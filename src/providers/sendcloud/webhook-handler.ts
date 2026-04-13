import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { updateFulfillmentWorkflow } from "@medusajs/medusa/core-flows";

import type { SendCloudPluginOptions } from "../../types/plugin-options";
import type { SendcloudWebhookPayload } from "../../types/sendcloud-api";

import { verifySendcloudSignature } from "./helpers";
import {
  type MulticolloParcel,
  computeAggregateStatus,
  findParcelTimestamp,
} from "./multicollo";

export type SendcloudWebhookInput = {
  signature: string | undefined;
  rawBody: Buffer | string | undefined;
  payload: unknown;
};

export type SendcloudWebhookResult = {
  status: 200 | 401;
  message: string;
};

const STATUS_DELIVERED = 11;
const STATUS_EXCEPTION = 80;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type FulfillmentRecord = {
  id: string;
  data?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  canceled_at?: Date | string | null;
  delivered_at?: Date | string | null;
};

export const processSendcloudWebhook = async (
  container: MedusaContainer,
  options: SendCloudPluginOptions,
  input: SendcloudWebhookInput
): Promise<SendcloudWebhookResult> => {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  const secret = options.webhookSecret;
  if (!secret || secret.trim().length === 0) {
    return {
      status: 401,
      message:
        "medusa-sendcloud: webhookSecret plugin option is required to accept webhooks",
    };
  }
  if (!input.signature) {
    return {
      status: 401,
      message: "medusa-sendcloud: missing Sendcloud-Signature header",
    };
  }
  if (!input.rawBody) {
    return {
      status: 401,
      message:
        "medusa-sendcloud: missing raw body — check preserveRawBody middleware",
    };
  }
  if (!verifySendcloudSignature(input.rawBody, input.signature, secret)) {
    return {
      status: 401,
      message: "medusa-sendcloud: signature verification failed",
    };
  }

  const payload = input.payload as SendcloudWebhookPayload | undefined;
  if (!payload || typeof payload !== "object" || !payload.action) {
    logger.debug("medusa-sendcloud: webhook payload missing action");
    return { status: 200, message: "ignored" };
  }

  switch (payload.action) {
    case "parcel_status_changed":
      return handleParcelStatusChanged(container, options, payload, logger);
    case "refund_requested":
      return handleRefundRequested(container, options, payload, logger);
    default:
      logger.debug(
        `medusa-sendcloud: unhandled webhook action "${payload.action}"`
      );
      return { status: 200, message: "ignored" };
  }
};

const findFulfillmentByParcelId = async (
  container: MedusaContainer,
  parcelId: number,
  lookbackDays: number
): Promise<FulfillmentRecord | undefined> => {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const since = new Date(Date.now() - lookbackDays * MS_PER_DAY).toISOString();

  const { data } = await query.graph({
    entity: "fulfillment",
    filters: { created_at: { $gte: since } },
    fields: ["id", "data", "metadata", "canceled_at", "delivered_at"],
  });

  const candidates = data as FulfillmentRecord[];
  return candidates.find((fulfillment) => {
    const fulfillmentData = (fulfillment.data ?? {}) as Record<string, unknown>;
    if (fulfillmentData.sendcloud_parcel_id === parcelId) return true;
    const parcels = fulfillmentData.parcels as MulticolloParcel[] | undefined;
    if (!Array.isArray(parcels)) return false;
    return parcels.some((p) => p?.sendcloud_parcel_id === parcelId);
  });
};

const handleParcelStatusChanged = async (
  container: MedusaContainer,
  options: SendCloudPluginOptions,
  payload: SendcloudWebhookPayload,
  logger: Logger
): Promise<SendcloudWebhookResult> => {
  const parcel = payload.parcel;
  const parcelId = parcel?.id;
  if (typeof parcelId !== "number") {
    logger.debug("medusa-sendcloud: parcel_status_changed missing parcel.id");
    return { status: 200, message: "ignored" };
  }

  const fulfillment = await findFulfillmentByParcelId(
    container,
    parcelId,
    options.webhookLookbackDays ?? 60
  );
  if (!fulfillment) {
    logger.debug(
      `medusa-sendcloud: no fulfillment found for sendcloud parcel id ${parcelId}`
    );
    return { status: 200, message: "no-match" };
  }

  const existingData = (fulfillment.data ?? {}) as Record<string, unknown>;
  const isMulticollo = Boolean(existingData.is_multicollo);
  const parcelStatus = parcel?.status ?? null;

  const existingTimestamp = isMulticollo
    ? findParcelTimestamp(
        existingData.parcels as MulticolloParcel[] | undefined,
        parcelId
      )
    : Number(existingData.status_updated_at ?? 0);
  if (
    Number.isFinite(payload.timestamp) &&
    payload.timestamp <= existingTimestamp
  ) {
    logger.debug(
      `medusa-sendcloud: skipping stale webhook for parcel ${parcelId} (timestamp ${payload.timestamp} <= stored ${existingTimestamp})`
    );
    return { status: 200, message: "stale" };
  }

  const nextData: Record<string, unknown> = isMulticollo
    ? buildMulticolloNextData(existingData, parcel, parcelId, payload.timestamp)
    : {
        status: parcelStatus,
        status_updated_at: payload.timestamp,
        ...(parcel?.tracking_number
          ? { tracking_number: parcel.tracking_number }
          : {}),
        ...(parcel?.tracking_url ? { tracking_url: parcel.tracking_url } : {}),
      };

  const update: {
    id: string;
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    delivered_at?: Date;
  } = {
    id: fulfillment.id,
    data: nextData,
  };

  if (parcelStatus?.id === STATUS_EXCEPTION) {
    const existingMetadata = (fulfillment.metadata ?? {}) as Record<
      string,
      unknown
    >;
    update.metadata = {
      ...existingMetadata,
      sendcloud_exception: {
        timestamp: payload.timestamp,
        message: parcelStatus.message,
      },
    };
  }

  const allDelivered = isMulticollo
    ? (nextData as { aggregate_status?: string }).aggregate_status ===
      "delivered"
    : parcelStatus?.id === STATUS_DELIVERED;

  if (allDelivered && !fulfillment.delivered_at) {
    // Mark the fulfillment itself delivered. Order-level delivered status
    // sync via markOrderFulfillmentAsDeliveredWorkflow needs an orderId
    // we don't have at webhook time (FulfillmentDTO has no order_id, and
    // reverse-resolving it via query.graph requires a link traversal
    // parked for a future cycle).
    update.delivered_at = new Date();
  }

  await updateFulfillmentWorkflow(container).run({ input: update });

  return { status: 200, message: "processed" };
};

const buildMulticolloNextData = (
  existingData: Record<string, unknown>,
  parcel: SendcloudWebhookPayload["parcel"],
  parcelId: number,
  timestamp: number
): Record<string, unknown> => {
  const existingParcels = (existingData.parcels ?? []) as MulticolloParcel[];
  const updatedParcels: MulticolloParcel[] = existingParcels.map((entry) => {
    if (entry.sendcloud_parcel_id !== parcelId) return entry;
    return {
      ...entry,
      status: parcel?.status ?? entry.status ?? null,
      status_updated_at: timestamp,
      ...(parcel?.tracking_number
        ? { tracking_number: parcel.tracking_number }
        : {}),
      ...(parcel?.tracking_url ? { tracking_url: parcel.tracking_url } : {}),
    };
  });

  // Multi-collo intentionally omits root status_updated_at: stale-checking
  // happens per-parcel via parcels[i].status_updated_at, so a webhook for
  // parcel B is not falsely rejected because parcel A was processed later.
  return {
    ...existingData,
    parcels: updatedParcels,
    aggregate_status: computeAggregateStatus(updatedParcels),
  };
};

const handleRefundRequested = async (
  container: MedusaContainer,
  options: SendCloudPluginOptions,
  payload: SendcloudWebhookPayload,
  logger: Logger
): Promise<SendcloudWebhookResult> => {
  const parcelId = payload.parcel?.id;
  if (typeof parcelId !== "number") {
    logger.debug("medusa-sendcloud: refund_requested missing parcel.id");
    return { status: 200, message: "ignored" };
  }

  const fulfillment = await findFulfillmentByParcelId(
    container,
    parcelId,
    options.webhookLookbackDays ?? 60
  );
  if (!fulfillment) {
    logger.debug(
      `medusa-sendcloud: no fulfillment found for sendcloud parcel id ${parcelId} (refund_requested)`
    );
    return { status: 200, message: "no-match" };
  }

  const existingMetadata = (fulfillment.metadata ?? {}) as Record<
    string,
    unknown
  >;

  await updateFulfillmentWorkflow(container).run({
    input: {
      id: fulfillment.id,
      metadata: {
        ...existingMetadata,
        sendcloud_refund_requested: {
          timestamp: payload.timestamp,
          reason: payload.refund_reason ?? null,
        },
      },
    },
  });

  return { status: 200, message: "processed" };
};
