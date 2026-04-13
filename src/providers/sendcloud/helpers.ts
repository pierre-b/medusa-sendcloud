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
  SendCloudServicePointsQuery,
  SendCloudShippingOptionsFilter,
  SendCloudVariantCustomsEntry,
  SendCloudVariantsMap,
} from "../../types/sendcloud-api";

export type ParsedServicePointsQuery =
  | { ok: true; value: SendCloudServicePointsQuery }
  | { ok: false; error: string };

const SERVICE_POINTS_STRING_FIELDS = [
  "postal_code",
  "city",
  "house_number",
  "carrier",
  "latitude",
  "longitude",
] as const;

export const parseServicePointsQuery = (
  raw: Record<string, unknown> | undefined | null
): ParsedServicePointsQuery => {
  const rawInput = raw ?? {};
  const countryRaw = rawInput.country;
  if (typeof countryRaw !== "string" || countryRaw.trim().length === 0) {
    return {
      ok: false,
      error: "medusa-sendcloud: query.country is required (ISO 3166-1 alpha-2)",
    };
  }
  const countryTrimmed = countryRaw.trim();
  if (countryTrimmed.length !== 2) {
    return {
      ok: false,
      error: "medusa-sendcloud: query.country must be a 2-letter ISO code",
    };
  }

  const value: SendCloudServicePointsQuery = {
    country: countryTrimmed.toUpperCase(),
  };

  for (const field of SERVICE_POINTS_STRING_FIELDS) {
    const candidate = rawInput[field];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      value[field] = candidate.trim();
    }
  }

  const radiusRaw = rawInput.radius;
  if (radiusRaw !== undefined && radiusRaw !== null && radiusRaw !== "") {
    const parsed = Number(radiusRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      value.radius = Math.trunc(parsed);
    }
  }

  return { ok: true, value };
};

const VALID_DPI_VALUES = new Set([72, 150, 203, 300, 600]);

export type LabelQuery = {
  paperSize: "a4" | "a6";
  dpi?: number;
};

export type ParsedLabelQuery =
  | { ok: true; value: LabelQuery }
  | { ok: false; error: string };

export const parseLabelQuery = (
  raw: Record<string, unknown> | undefined | null
): ParsedLabelQuery => {
  const rawInput = raw ?? {};

  let paperSize: "a4" | "a6" = "a6";
  if (rawInput.paper_size !== undefined) {
    if (rawInput.paper_size !== "a4" && rawInput.paper_size !== "a6") {
      return {
        ok: false,
        error: 'medusa-sendcloud: paper_size must be "a4" or "a6"',
      };
    }
    paperSize = rawInput.paper_size;
  }

  const value: LabelQuery = { paperSize };

  if (rawInput.dpi !== undefined && rawInput.dpi !== "") {
    const parsedDpi = Number(rawInput.dpi);
    if (!Number.isFinite(parsedDpi) || !VALID_DPI_VALUES.has(parsedDpi)) {
      return {
        ok: false,
        error: "medusa-sendcloud: dpi must be one of 72, 150, 203, 300, or 600",
      };
    }
    value.dpi = parsedDpi;
  }

  return { ok: true, value };
};

export type BulkLabelInput = {
  fulfillmentIds: string[];
  paperSize: "a4" | "a6";
};

export type ParsedBulkLabelRequest =
  | { ok: true; value: BulkLabelInput }
  | { ok: false; error: string };

const MAX_BULK_FULFILLMENTS = 20;

export const parseBulkLabelRequest = (
  body: unknown
): ParsedBulkLabelRequest => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      error: "medusa-sendcloud: request body must be a JSON object",
    };
  }
  const input = body as Record<string, unknown>;

  const rawIds = input.fulfillment_ids;
  if (!Array.isArray(rawIds)) {
    return {
      ok: false,
      error: "medusa-sendcloud: fulfillment_ids must be an array",
    };
  }
  if (rawIds.length === 0) {
    return {
      ok: false,
      error: "medusa-sendcloud: fulfillment_ids must contain at least one id",
    };
  }
  if (rawIds.length > MAX_BULK_FULFILLMENTS) {
    return {
      ok: false,
      error: `medusa-sendcloud: fulfillment_ids exceeds the maximum of ${MAX_BULK_FULFILLMENTS} per request`,
    };
  }
  const ids: string[] = [];
  for (const candidate of rawIds) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      return {
        ok: false,
        error:
          "medusa-sendcloud: every fulfillment_ids entry must be a non-empty string",
      };
    }
    ids.push(candidate.trim());
  }

  let paperSize: "a4" | "a6" = "a6";
  if (input.paper_size !== undefined) {
    if (input.paper_size !== "a4" && input.paper_size !== "a6") {
      return {
        ok: false,
        error: 'medusa-sendcloud: paper_size must be "a4" or "a6"',
      };
    }
    paperSize = input.paper_size;
  }

  return { ok: true, value: { fulfillmentIds: ids, paperSize } };
};

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

export type ParcelHint = {
  weight: number;
  length: number;
  width: number;
  height: number;
};

const MAX_HINT_PARCELS = 15;

const assertPositiveNumber = (
  value: unknown,
  field: keyof ParcelHint
): void => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-sendcloud: sendcloud_parcels[].${field} must be a positive number`
    );
  }
};

export const parseParcelsHint = (raw: unknown): ParcelHint[] | null => {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length > MAX_HINT_PARCELS) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-sendcloud: sendcloud_parcels supports at most ${MAX_HINT_PARCELS} entries`
    );
  }
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `medusa-sendcloud: sendcloud_parcels[${index}] must be an object with weight/length/width/height`
      );
    }
    const candidate = entry as Record<string, unknown>;
    assertPositiveNumber(candidate.weight, "weight");
    assertPositiveNumber(candidate.length, "length");
    assertPositiveNumber(candidate.width, "width");
    assertPositiveNumber(candidate.height, "height");
    return {
      weight: candidate.weight as number,
      length: candidate.length as number,
      width: candidate.width as number,
      height: candidate.height as number,
    };
  });
};

export const applyHintDimensions = (
  parcel: SendCloudParcelRequest,
  hint: ParcelHint,
  weightUnit: SendCloudWeightUnitOption
): SendCloudParcelRequest => {
  const weightKg = convertToKg(hint.weight, weightUnit);
  return {
    ...parcel,
    weight: { value: weightKg.toFixed(3), unit: "kg" },
    dimensions: {
      length: String(hint.length),
      width: String(hint.width),
      height: String(hint.height),
      unit: "cm",
    },
  };
};

export const buildParcelFromHint = (
  hint: ParcelHint,
  weightUnit: SendCloudWeightUnitOption,
  insuranceAmount?: number
): SendCloudParcelRequest => {
  const parcel = applyHintDimensions({}, hint, weightUnit);
  if (
    typeof insuranceAmount === "number" &&
    Number.isFinite(insuranceAmount) &&
    insuranceAmount > 0
  ) {
    parcel.additional_insured_price = {
      value: String(insuranceAmount),
      currency: "EUR",
    };
  }
  return parcel;
};

export const readInsuranceOverride = (
  metadata: Record<string, unknown> | null | undefined
): number | null => {
  const raw = metadata?.sendcloud_insurance_amount;
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-sendcloud: sendcloud_insurance_amount must be a non-negative number (received ${String(raw)})`
    );
  }
  return value;
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
