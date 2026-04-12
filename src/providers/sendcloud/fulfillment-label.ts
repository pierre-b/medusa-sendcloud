import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";

import type { SendCloudClient } from "../../services/sendcloud-client";
import type { LabelQuery } from "./helpers";

export const buildSingleLabelPath = (parcelId: number): string =>
  `/api/v3/parcels/${parcelId}/documents/label`;

export type FulfillmentLabelSuccess = {
  status: 200;
  body: Buffer;
  contentType: string;
  parcelId: number;
};

export type FulfillmentLabelFailure = {
  status: 400 | 404 | 502;
  body: { message: string };
};

export type FulfillmentLabelResult =
  | FulfillmentLabelSuccess
  | FulfillmentLabelFailure;

export type FulfillmentLabelInput = LabelQuery & {
  fulfillmentId: string;
};

type LabelProvider = {
  client_: SendCloudClient;
};

type FulfillmentRow = {
  id: string;
  data?: Record<string, unknown> | null;
};

export const fetchSendcloudLabel = async (
  container: MedusaContainer,
  providerRegistrationKey: string,
  input: FulfillmentLabelInput
): Promise<FulfillmentLabelResult> => {
  let provider: LabelProvider;
  try {
    provider = container.resolve<LabelProvider>(providerRegistrationKey);
  } catch {
    return {
      status: 502,
      body: {
        message:
          "medusa-sendcloud: fulfillment provider not registered; cannot fetch label",
      },
    };
  }

  let rows: FulfillmentRow[];
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "fulfillment",
      filters: { id: input.fulfillmentId },
      fields: ["id", "data"],
    });
    rows = data as FulfillmentRow[];
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown Query failure";
    return {
      status: 502,
      body: {
        message: `medusa-sendcloud: failed to resolve fulfillment via Query: ${message}`,
      },
    };
  }

  // Query.graph with a scalar `id` filter on a primary-key column returns
  // at most one row; no need for a redundant find().
  const row = rows[0];
  if (!row) {
    return {
      status: 404,
      body: {
        message: `medusa-sendcloud: unknown fulfillment ${input.fulfillmentId}`,
      },
    };
  }

  const parcelId = (row.data as Record<string, unknown> | undefined)?.[
    "sendcloud_parcel_id"
  ];
  if (typeof parcelId !== "number" || !Number.isFinite(parcelId)) {
    return {
      status: 400,
      body: {
        message: `medusa-sendcloud: fulfillment ${input.fulfillmentId} has no sendcloud_parcel_id`,
      },
    };
  }

  try {
    const { body, contentType } = await provider.client_.requestBinary({
      method: "GET",
      path: buildSingleLabelPath(parcelId),
      accept: "application/pdf",
      query: {
        paper_size: input.paperSize,
        dpi: input.dpi,
      },
    });
    return { status: 200, body, contentType, parcelId };
  } catch (error) {
    const message =
      error instanceof MedusaError
        ? error.message
        : error instanceof Error
          ? error.message
          : "medusa-sendcloud: single-label upstream failed";
    return { status: 502, body: { message } };
  }
};
