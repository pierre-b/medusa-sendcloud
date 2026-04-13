import {
  type CustomsWarning,
  EU_COUNTRY_CODES,
  requiresCustomsCheck,
  validateCustomsData,
} from "../customs-validation";

describe("EU_COUNTRY_CODES", () => {
  it("contains the 27 current EU member states", () => {
    expect(EU_COUNTRY_CODES.size).toBe(27);
    for (const cc of [
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
    ]) {
      expect(EU_COUNTRY_CODES.has(cc)).toBe(true);
    }
  });

  it("excludes GB, NO, IS, CH, JE, GG, XI", () => {
    for (const cc of ["GB", "NO", "IS", "CH", "JE", "GG", "XI"]) {
      expect(EU_COUNTRY_CODES.has(cc)).toBe(false);
    }
  });
});

describe("requiresCustomsCheck", () => {
  it("returns false for intra-EU shipments (FR→DE)", () => {
    expect(requiresCustomsCheck("FR", "DE")).toBe(false);
  });

  it("returns true for FR→US, US→FR, FR→GB", () => {
    expect(requiresCustomsCheck("FR", "US")).toBe(true);
    expect(requiresCustomsCheck("US", "FR")).toBe(true);
    expect(requiresCustomsCheck("FR", "GB")).toBe(true);
  });

  it("returns false when toCC is missing (cannot determine destination)", () => {
    expect(requiresCustomsCheck("FR", undefined)).toBe(false);
    expect(requiresCustomsCheck("FR", "")).toBe(false);
  });

  it("returns false when fromCC is missing (skip-when-unset; config warning surfaces it)", () => {
    expect(requiresCustomsCheck(undefined, "US")).toBe(false);
    expect(requiresCustomsCheck("", "US")).toBe(false);
  });

  it("returns false for domestic shipments (FR→FR)", () => {
    expect(requiresCustomsCheck("FR", "FR")).toBe(false);
  });
});

const buildVariantsMap = (entries: Record<string, unknown>) =>
  entries as Record<string, { hs_code?: string; origin_country?: string }>;

const buildOrder = (
  lineItems: Array<{
    id: string;
    variant_id: string;
    unit_price: number;
    quantity: number;
  }>
) =>
  ({
    id: "order_intl_1",
    currency_code: "EUR",
    items: lineItems.map((li) => ({
      id: li.id,
      variant_id: li.variant_id,
      unit_price: li.unit_price,
      quantity: li.quantity,
      title: `Item ${li.id}`,
    })),
  }) as unknown as Parameters<typeof validateCustomsData>[0]["order"];

const buildItems = (lineItems: Array<{ id: string; quantity: number }>) =>
  lineItems.map((li) => ({
    id: `fitem_${li.id}`,
    title: `Item ${li.id}`,
    quantity: li.quantity,
    line_item_id: li.id,
  })) as unknown as Parameters<typeof validateCustomsData>[0]["items"];

describe("validateCustomsData", () => {
  it("returns no warnings when every variant has hs_code + origin_country and prices are positive", () => {
    const order = buildOrder([
      { id: "li_a", variant_id: "var_a", unit_price: 10, quantity: 1 },
      { id: "li_b", variant_id: "var_b", unit_price: 5, quantity: 2 },
    ]);
    const items = buildItems([
      { id: "li_a", quantity: 1 },
      { id: "li_b", quantity: 2 },
    ]);
    const variantsMap = buildVariantsMap({
      var_a: { hs_code: "180631", origin_country: "FR" },
      var_b: { hs_code: "180632", origin_country: "FR" },
    });

    expect(validateCustomsData({ items, order, variantsMap })).toEqual([]);
  });

  it("flags missing hs_code, missing origin_country, and zero-value items", () => {
    const order = buildOrder([
      { id: "li_a", variant_id: "var_a", unit_price: 10, quantity: 1 },
      { id: "li_b", variant_id: "var_b", unit_price: 0, quantity: 1 },
    ]);
    const items = buildItems([
      { id: "li_a", quantity: 1 },
      { id: "li_b", quantity: 1 },
    ]);
    const variantsMap = buildVariantsMap({
      var_a: { origin_country: "FR" },
      var_b: { hs_code: "180632" },
    });

    const warnings = validateCustomsData({ items, order, variantsMap });
    const codes = warnings.map((w) => w.code).sort();
    expect(codes).toEqual([
      "missing_hs_code",
      "missing_origin_country",
      "zero_value_item",
    ]);
    expect(
      warnings.find((w: CustomsWarning) => w.code === "missing_hs_code")
        ?.line_item_id
    ).toBe("li_a");
    expect(
      warnings.find((w: CustomsWarning) => w.code === "missing_origin_country")
        ?.line_item_id
    ).toBe("li_b");
    expect(
      warnings.find((w: CustomsWarning) => w.code === "zero_value_item")
        ?.line_item_id
    ).toBe("li_b");
  });

  it("emits low_total_value when summed unit_price * quantity is below 1", () => {
    const order = buildOrder([
      { id: "li_a", variant_id: "var_a", unit_price: 0.3, quantity: 2 },
    ]);
    const items = buildItems([{ id: "li_a", quantity: 2 }]);
    const variantsMap = buildVariantsMap({
      var_a: { hs_code: "180631", origin_country: "FR" },
    });

    const warnings = validateCustomsData({ items, order, variantsMap });
    expect(warnings).toEqual([
      expect.objectContaining({ code: "low_total_value" }),
    ]);
    expect(warnings[0].line_item_id).toBeUndefined();
  });

  it("deduplicates by variant_id when the same broken variant appears on multiple lines", () => {
    const order = buildOrder([
      { id: "li_a", variant_id: "var_x", unit_price: 5, quantity: 1 },
      { id: "li_b", variant_id: "var_x", unit_price: 5, quantity: 1 },
      { id: "li_c", variant_id: "var_x", unit_price: 5, quantity: 1 },
    ]);
    const items = buildItems([
      { id: "li_a", quantity: 1 },
      { id: "li_b", quantity: 1 },
      { id: "li_c", quantity: 1 },
    ]);
    const variantsMap = buildVariantsMap({}); // empty — both fields missing for var_x

    const warnings = validateCustomsData({ items, order, variantsMap });
    expect(warnings.filter((w) => w.code === "missing_hs_code")).toHaveLength(
      1
    );
    expect(
      warnings.filter((w) => w.code === "missing_origin_country")
    ).toHaveLength(1);
  });

  it("emits warnings for every variant when variantsMap is empty (manual order path)", () => {
    const order = buildOrder([
      { id: "li_a", variant_id: "var_a", unit_price: 5, quantity: 1 },
      { id: "li_b", variant_id: "var_b", unit_price: 5, quantity: 1 },
    ]);
    const items = buildItems([
      { id: "li_a", quantity: 1 },
      { id: "li_b", quantity: 1 },
    ]);

    const warnings = validateCustomsData({
      items,
      order,
      variantsMap: buildVariantsMap({}),
    });
    expect(warnings.filter((w) => w.code === "missing_hs_code")).toHaveLength(
      2
    );
    expect(
      warnings.filter((w) => w.code === "missing_origin_country")
    ).toHaveLength(2);
  });
});
