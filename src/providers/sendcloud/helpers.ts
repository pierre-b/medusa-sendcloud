import crypto from "node:crypto";

import { MedusaError } from "@medusajs/framework/utils";
import type {
  CalculateShippingOptionPriceDTO,
  FulfillmentItemDTO,
  FulfillmentOrderDTO,
} from "@medusajs/framework/types";

import type { SendCloudWeightUnitOption } from "../../types/plugin-options";
import type {
  SendCloudAddress,
  SendCloudParcelItemRequest,
  SendCloudParcelRequest,
  SendCloudShippingOptionsFilter,
  SendCloudVariantCustomsEntry,
  SendCloudVariantsMap,
} from "../../types/sendcloud-api";

export const verifySendcloudSignature = (
  rawBody: Buffer | string,
  signatureHeader: string,
  secret: string
): boolean => {
  if (!signatureHeader || !secret) return false;
  const bodyBuffer =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const digestHex = crypto
    .createHmac("sha256", secret)
    .update(bodyBuffer)
    .digest("hex");

  // Guard against invalid hex in the signature header — Buffer.from with
  // non-hex characters produces a shorter buffer which would otherwise
  // sneak past the length compare.
  if (!/^[0-9a-f]+$/i.test(signatureHeader)) return false;

  const providedBuf = Buffer.from(signatureHeader.toLowerCase(), "hex");
  const computedBuf = Buffer.from(digestHex, "hex");
  if (providedBuf.length !== computedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, computedBuf);
};

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

const readOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : value;
};

export const buildToAddress = (rawAddress: unknown): SendCloudAddress => {
  if (!rawAddress || typeof rawAddress !== "object") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-sendcloud: shipping address is required to create a fulfillment"
    );
  }
  const a = rawAddress as Record<string, unknown>;

  const firstName = readOptionalString(a.first_name) ?? "";
  const lastName = readOptionalString(a.last_name) ?? "";
  const name = `${firstName} ${lastName}`.trim();
  if (name.length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-sendcloud: shipping address name (first_name + last_name) is required"
    );
  }

  const addressLine1 = requireString(a.address_1, "to_address.address_line_1");
  const postalCode = requireString(a.postal_code, "to_address.postal_code");
  const city = requireString(a.city, "to_address.city");
  const countryCode = requireString(a.country_code, "to_address.country_code");

  const result: SendCloudAddress = {
    name,
    address_line_1: addressLine1,
    postal_code: postalCode,
    city,
    country_code: countryCode,
  };

  const company = readOptionalString(a.company);
  if (company) result.company_name = company;

  const addressLine2 = readOptionalString(a.address_2);
  if (addressLine2) result.address_line_2 = addressLine2;

  const province = readOptionalString(a.province);
  if (province) result.state_province_code = province;

  const phone = readOptionalString(a.phone);
  if (phone) result.phone_number = phone;

  const email = readOptionalString(a.email);
  if (email) result.email = email;

  return result;
};

export const extractVariantIds = (
  items: Array<{ variant_id?: string | null }> | undefined
): string[] => {
  if (!items) return [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item?.variant_id && typeof item.variant_id === "string") {
      seen.add(item.variant_id);
    }
  }
  return Array.from(seen);
};

export const buildVariantsMap = (
  variants: Array<{
    id?: string;
    hs_code?: string | null;
    origin_country?: string | null;
    weight?: number | null;
  }>
): SendCloudVariantsMap => {
  const out: SendCloudVariantsMap = {};
  for (const variant of variants) {
    if (!variant?.id) continue;
    const entry: SendCloudVariantCustomsEntry = {};
    if (variant.hs_code) entry.hs_code = variant.hs_code;
    if (variant.origin_country) entry.origin_country = variant.origin_country;
    if (typeof variant.weight === "number" && variant.weight > 0) {
      entry.weight = variant.weight;
    }
    if (Object.keys(entry).length > 0) {
      out[variant.id] = entry;
    }
  }
  return out;
};

export const readSendcloudVariantsFromOrder = (
  order: Partial<FulfillmentOrderDTO> | undefined
): SendCloudVariantsMap => {
  const metadata = order?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const raw = (metadata as Record<string, unknown>).sendcloud_variants;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as SendCloudVariantsMap;
};

export const buildParcelItems = (
  items: FulfillmentItemDTO[] | undefined,
  order: Partial<FulfillmentOrderDTO> | undefined,
  opts: {
    variantsMap?: SendCloudVariantsMap;
    weightUnit?: SendCloudWeightUnitOption;
  } = {}
): SendCloudParcelItemRequest[] => {
  if (!items || items.length === 0) return [];

  const variantsMap = opts.variantsMap ?? {};
  const weightUnit = opts.weightUnit ?? "g";

  const lineItemsById = new Map<
    string,
    { unit_price?: number; variant_id?: string | null }
  >();
  const currency = order?.currency_code;
  for (const lineItem of order?.items ?? []) {
    if (lineItem?.id) {
      lineItemsById.set(lineItem.id, {
        unit_price:
          typeof lineItem.unit_price === "number"
            ? lineItem.unit_price
            : undefined,
        variant_id: lineItem.variant_id ?? null,
      });
    }
  }

  return items.map((item) => {
    const entry: SendCloudParcelItemRequest = {
      description: item.title ?? "",
      quantity: Number(item.quantity ?? 0),
    };
    if (item.sku) entry.sku = item.sku;
    if (item.id) entry.item_id = item.id;

    const lineItem = item.line_item_id
      ? lineItemsById.get(item.line_item_id)
      : undefined;

    if (
      lineItem?.unit_price !== undefined &&
      typeof currency === "string" &&
      currency.length > 0
    ) {
      entry.price = {
        value: String(lineItem.unit_price),
        currency: currency.toUpperCase(),
      };
    }

    const variantId = lineItem?.variant_id ?? undefined;
    const customs: SendCloudVariantCustomsEntry | undefined = variantId
      ? variantsMap[variantId]
      : undefined;

    if (customs) {
      if (customs.hs_code) entry.hs_code = customs.hs_code;
      if (customs.origin_country) entry.origin_country = customs.origin_country;
      if (typeof customs.weight === "number" && customs.weight > 0) {
        const kg = convertToKg(customs.weight, weightUnit);
        entry.weight = { value: kg.toFixed(3), unit: "kg" };
      }
    }

    return entry;
  });
};

export const buildShipmentParcel = (
  items: FulfillmentItemDTO[] | undefined,
  order: Partial<FulfillmentOrderDTO> | undefined,
  opts: {
    insuranceAmount?: number;
    variantsMap?: SendCloudVariantsMap;
    weightUnit?: SendCloudWeightUnitOption;
  }
): SendCloudParcelRequest => {
  const parcel: SendCloudParcelRequest = {};
  const parcelItems = buildParcelItems(items, order, {
    variantsMap: opts.variantsMap,
    weightUnit: opts.weightUnit,
  });
  if (parcelItems.length > 0) {
    parcel.parcel_items = parcelItems;
  }
  if (
    typeof opts.insuranceAmount === "number" &&
    Number.isFinite(opts.insuranceAmount) &&
    opts.insuranceAmount > 0
  ) {
    parcel.additional_insured_price = {
      value: String(opts.insuranceAmount),
      currency: "EUR",
    };
  }
  return parcel;
};

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
