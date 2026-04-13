import type {
  FulfillmentItemDTO,
  FulfillmentOrderDTO,
} from "@medusajs/framework/types";

import type { SendCloudVariantsMap } from "../../types/sendcloud-api";

// Source: https://european-union.europa.eu/principles-countries-history/eu-countries_en
// Last verified: 2026-04-13. Update on accession (next likely: Albania,
// North Macedonia, Montenegro — not before 2027).
export const EU_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

export type CustomsWarning = {
  code:
    | "missing_hs_code"
    | "missing_origin_country"
    | "zero_value_item"
    | "low_total_value";
  line_item_id?: string;
  message: string;
};

export const requiresCustomsCheck = (
  fromCC?: string,
  toCC?: string
): boolean => {
  if (!toCC) return false;
  if (!fromCC) return false;
  if (fromCC === toCC) return false;
  if (EU_COUNTRY_CODES.has(fromCC) && EU_COUNTRY_CODES.has(toCC)) return false;
  return true;
};

type ValidateInput = {
  items: FulfillmentItemDTO[] | undefined;
  order: Partial<FulfillmentOrderDTO> | undefined;
  variantsMap: SendCloudVariantsMap;
};

type LineItemRecord = {
  id: string;
  variant_id?: string | null;
  unit_price?: number | string | null;
  quantity?: number | string | null;
};

const buildLineItemIndex = (
  order: Partial<FulfillmentOrderDTO> | undefined
): Map<string, LineItemRecord> => {
  const index = new Map<string, LineItemRecord>();
  const orderItems = (order?.items ?? []) as LineItemRecord[];
  for (const li of orderItems) {
    if (li?.id) index.set(li.id, li);
  }
  return index;
};

export const validateCustomsData = (input: ValidateInput): CustomsWarning[] => {
  const warnings: CustomsWarning[] = [];
  const lineItemsById = buildLineItemIndex(input.order);
  const variantsSeen = new Set<string>();
  let totalDeclared = 0;

  for (const item of input.items ?? []) {
    const lineItemId = (item as { line_item_id?: string }).line_item_id;
    const lineItem = lineItemId ? lineItemsById.get(lineItemId) : undefined;
    const variantId = lineItem?.variant_id ?? undefined;
    const unitPrice = Number(lineItem?.unit_price ?? 0);
    const quantity = Number(item.quantity ?? lineItem?.quantity ?? 0);
    totalDeclared += unitPrice * quantity;

    if (unitPrice === 0 && quantity > 0) {
      warnings.push({
        code: "zero_value_item",
        line_item_id: lineItemId,
        message: `medusa-sendcloud: line item ${lineItemId ?? item.id} has unit_price 0; SendCloud may reject the customs declaration`,
      });
    }

    if (!variantId) continue;
    if (variantsSeen.has(variantId)) continue;
    variantsSeen.add(variantId);

    const customs = input.variantsMap[variantId];
    if (!customs?.hs_code) {
      warnings.push({
        code: "missing_hs_code",
        line_item_id: lineItemId,
        message: `medusa-sendcloud: variant ${variantId} (line ${lineItemId ?? item.id}) is missing hs_code; required for international shipments`,
      });
    }
    if (!customs?.origin_country) {
      warnings.push({
        code: "missing_origin_country",
        line_item_id: lineItemId,
        message: `medusa-sendcloud: variant ${variantId} (line ${lineItemId ?? item.id}) is missing origin_country; required for international shipments`,
      });
    }
  }

  if (totalDeclared > 0 && totalDeclared < 1) {
    warnings.push({
      code: "low_total_value",
      message: `medusa-sendcloud: total declared value (${totalDeclared.toFixed(2)}) is below 1 in order currency; carrier may reject`,
    });
  }

  return warnings;
};
