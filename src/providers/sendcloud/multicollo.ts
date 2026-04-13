import { MedusaError } from "@medusajs/framework/utils";

import type { SendCloudClient } from "../../services/sendcloud-client";
import type {
  SendCloudShippingOptionsFilter,
  SendCloudShippingOptionsResponse,
} from "../../types/sendcloud-api";

export const MULTICOLLO_SHIPPING_OPTIONS_PATH = "/api/v3/shipping-options";

const STATUS_DELIVERED = 11;
const STATUS_EXCEPTION = 80;

export type MulticolloParcel = {
  sendcloud_parcel_id: number;
  tracking_number?: string | null;
  tracking_url?: string | null;
  status?: { id?: number; message?: string } | null;
  label_url?: string | null;
  status_updated_at?: number | null;
};

export type AggregateStatus =
  | "pending"
  | "partially_delivered"
  | "delivered"
  | "exception";

export const computeAggregateStatus = (
  parcels: MulticolloParcel[]
): AggregateStatus => {
  if (parcels.length === 0) return "pending";
  if (parcels.some((p) => p.status?.id === STATUS_EXCEPTION))
    return "exception";
  const delivered = parcels.filter(
    (p) => p.status?.id === STATUS_DELIVERED
  ).length;
  if (delivered === parcels.length) return "delivered";
  if (delivered > 0) return "partially_delivered";
  return "pending";
};

export const findParcelTimestamp = (
  parcels: MulticolloParcel[] | undefined,
  parcelId: number
): number => {
  const match = parcels?.find((p) => p.sendcloud_parcel_id === parcelId);
  return Number(match?.status_updated_at ?? 0);
};

export const assertCarrierSupportsMulticollo = async (
  client: SendCloudClient,
  shippingOptionCode: string
): Promise<void> => {
  const filter: SendCloudShippingOptionsFilter = {
    functionalities: { multicollo: true },
  };
  const response = await client.request<SendCloudShippingOptionsResponse>({
    method: "POST",
    path: MULTICOLLO_SHIPPING_OPTIONS_PATH,
    body: filter,
  });

  const supported = (response.data ?? []).some(
    (option) => option.code === shippingOptionCode
  );
  if (!supported) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `medusa-sendcloud: carrier shipping option "${shippingOptionCode}" does not support multi-collo shipments`
    );
  }
};
