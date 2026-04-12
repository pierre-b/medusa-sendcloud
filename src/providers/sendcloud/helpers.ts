import { MedusaError } from "@medusajs/framework/utils";
import type { CalculateShippingOptionPriceDTO } from "@medusajs/framework/types";

import type { SendCloudWeightUnitOption } from "../../types/plugin-options";
import type { SendCloudShippingOptionsFilter } from "../../types/sendcloud-api";

export const readSendCloudCode = (data: Record<string, unknown>): string => {
  const code = data.sendcloud_code;
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-sendcloud: option data is missing sendcloud_code"
    );
  }
  return code;
};

export const requireString = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-sendcloud: ${fieldName} is required`
    );
  }
  return value;
};

export const isValidServicePointId = (
  value: unknown
): value is string | number => {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }
  return false;
};

const WEIGHT_UNIT_TO_KG: Record<SendCloudWeightUnitOption, number> = {
  g: 0.001,
  kg: 1,
  lbs: 0.45359237,
  oz: 0.028349523,
};

export const convertToKg = (
  value: number,
  unit: SendCloudWeightUnitOption
): number => value * WEIGHT_UNIT_TO_KG[unit];

export type ParcelShape = NonNullable<
  SendCloudShippingOptionsFilter["parcels"]
>[number];

export const aggregateParcel = (
  items: CalculateShippingOptionPriceDTO["context"]["items"] | undefined,
  weightUnit: SendCloudWeightUnitOption
): ParcelShape => {
  let totalWeight = 0;
  let totalVolume = 0;

  for (const item of items ?? []) {
    const quantity = Number(item.quantity ?? 0);
    const variant = item.variant;
    if (!variant) continue;

    const weight = Number(variant.weight ?? 0);
    const length = Number(variant.length ?? 0);
    const width = Number(variant.width ?? 0);
    const height = Number(variant.height ?? 0);

    totalWeight += weight * quantity;
    totalVolume += length * width * height * quantity;
  }

  if (totalWeight <= 0 && totalVolume <= 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-sendcloud: cart has no shippable items — at least one item must declare weight or dimensions"
    );
  }

  const weightKg = convertToKg(totalWeight, weightUnit);
  const parcel: ParcelShape = {
    weight: { value: weightKg.toFixed(3), unit: "kg" },
  };

  if (totalVolume > 0) {
    const side = Math.cbrt(totalVolume).toFixed(2);
    parcel.dimensions = {
      length: side,
      width: side,
      height: side,
      unit: "cm",
    };
  }

  return parcel;
};
