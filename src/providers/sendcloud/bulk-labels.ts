import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";

import type { SendCloudClient } from "../../services/sendcloud-client";

export const BULK_LABELS_PATH = "/api/v3/parcel-documents/label";

export type BulkLabelsSuccess = {
  status: 200;
  body: Buffer;
  contentType: string;
};

export type BulkLabelsFailure = {
  status: 400 | 502;
  body: { message: string };
};

export type BulkLabelsResult = BulkLabelsSuccess | BulkLabelsFailure;

export type BulkLabelsInput = {
  fulfillmentIds: string[];
  paperSize: "a4" | "a6";
};

type BulkLabelsProvider = {
  client_: SendCloudClient;
};

type FulfillmentRow = {
  id: string;
  data?: Record<string, unknown> | null;
};

export const fetchSendcloudBulkLabels = async (
  container: MedusaContainer,
  providerRegistrationKey: string,
  input: BulkLabelsInput
): Promise<BulkLabelsResult> => {
  let provider: BulkLabelsProvider;
  try {
    provider = container.resolve<BulkLabelsProvider>(providerRegistrationKey);
  } catch {
    return {
      status: 502,
      body: {
        message:
          "medusa-sendcloud: fulfillment provider not registered; cannot fetch labels",
      },
    };
  }

  let rows: FulfillmentRow[];
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "fulfillment",
      filters: { id: input.fulfillmentIds },
      fields: ["id", "data"],
    });
    rows = data as FulfillmentRow[];
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown Query failure";
    return {
      status: 502,
      body: {
        message: `medusa-sendcloud: failed to resolve fulfillments via Query: ${message}`,
      },
    };
  }
  const foundIds = new Set(rows.map((row) => row.id));
  const missing = input.fulfillmentIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return {
      status: 400,
      body: {
        message: `medusa-sendcloud: unknown fulfillment ids: ${missing.join(", ")}`,
      },
    };
  }

  const parcelIds: number[] = [];
  const missingParcelIds: string[] = [];
  for (const row of rows) {
    const parcelId = (row.data as Record<string, unknown> | undefined)?.[
      "sendcloud_parcel_id"
    ];
    if (typeof parcelId === "number" && Number.isFinite(parcelId)) {
      parcelIds.push(parcelId);
    } else {
      missingParcelIds.push(row.id);
    }
  }
  if (missingParcelIds.length > 0) {
    return {
      status: 400,
      body: {
        message: `medusa-sendcloud: fulfillments are missing sendcloud_parcel_id: ${missingParcelIds.join(", ")}`,
      },
    };
  }

  try {
    const { body, contentType } = await provider.client_.requestBinary({
      method: "GET",
      path: BULK_LABELS_PATH,
      accept: "application/pdf",
      query: {
        parcels: parcelIds,
        paper_size: input.paperSize,
      },
    });
    return { status: 200, body, contentType };
  } catch (error) {
    const message =
      error instanceof MedusaError
        ? error.message
        : error instanceof Error
          ? error.message
          : "medusa-sendcloud: bulk-labels upstream failed";
    return { status: 502, body: { message } };
  }
};
