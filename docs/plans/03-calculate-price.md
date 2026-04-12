# Plan 03 — `calculatePrice` (spec §3.4)

## Context

Cycle 02 closed the validation gap — options can be picked and carried through checkout. This cycle adds **pricing**: when a customer views shipping options at checkout, each one gets a real SendCloud quote instead of a static fallback.

**Goal:** `SendCloudFulfillmentProvider.calculatePrice(optionData, data, context)` returns `{ calculated_amount, is_calculated_price_tax_inclusive }` derived from a live SendCloud quote.

**Why now:** `calculatePrice` is the first method that actually exercises the `quotes[]` array in the v3 shipping-options response — the field cycle 01 deliberately ignored. It's also the first method with real cart-context consumption (address + items + stock location), so the behaviour this cycle establishes (weight aggregation, country-code extraction, dimension handling) will be reused by `createFulfillment` (§3.6) later.

**Scope:** only §3.4. No other provider methods change. Deferred: multi-parcel splitting (multicollo is its own cycle), currency conversion (EUR only assumed), per-item parcel splitting.

### User decisions

- **from_country_code source:** `context.from_location.address.country_code` primary; plugin option `defaultFromCountryCode` fallback; throw `INVALID_DATA` if neither present
- **Parcel dimensions:** aggregate volumetric bounding box — sum item volumes, derive a cube with side = cube-root of total volume
- **Weight unit:** plugin option `weightUnit` with default `"g"`; converted to `"kg"` for SendCloud (it accepts `g | kg | lbs | oz` but canonical path in our code is kg)

---

## Prerequisites

None — snapshot + nock are in place.

---

## External API verification

Re-using `POST https://panel.sendcloud.sc/api/v3/shipping-options` with `calculate_quotes: true`. The `shipping-option-filter` schema we already typed accepts all the fields we need: `shipping_option_code`, `from_country_code`, `to_country_code`, `to_postal_code`, `parcels[]`, `calculate_quotes`.

**Response path for the price:** `response.data[0].quotes[0].price.total.value` (string, currency in `quotes[0].price.total.currency`).

The `ShippingOption.quotes[]` shape is referenced in the snapshot (`shipping-quote` schema). Currently our `SendCloudShippingOption` type has `quotes?: unknown[] | null`. Tighten to a proper `SendCloudShippingQuote` type extracted from the snapshot.

**From the snapshot (verified):**

```yaml
quotes:
  - weight:
      { min: { value: "0.001", unit: kg }, max: { value: "23.001", unit: kg } }
    price:
      breakdown:
        - type: price_without_insurance
          label: Label
          price: { value: "15.50", currency: EUR }
        - type: insurance_price
          label: Shipment protection (incl. taxes)
          price: { value: "2.00", currency: EUR }
      total: { value: "17.50", currency: EUR }
    lead_time: 24
```

We read `quotes[0].price.total.value` and `quotes[0].price.total.currency`. If `data[]` is empty / null, or the first entry has no `quotes`, we throw `UNEXPECTED_STATE` (the admin configured an option SendCloud says doesn't exist anymore or can't quote).

---

## Plugin options added this cycle

| Option                   | Type                           | Default | Purpose                                                         |
| ------------------------ | ------------------------------ | ------- | --------------------------------------------------------------- |
| `defaultFromCountryCode` | `string` (ISO 3166-1 alpha-2)  | _none_  | Fallback sender country when `context.from_location` is absent. |
| `weightUnit`             | `"g" \| "kg" \| "lbs" \| "oz"` | `"g"`   | How to interpret `variant.weight` values stored in Medusa.      |

Tax inclusivity is hardcoded `false` this cycle (SendCloud quotes exclude destination sales tax; Medusa will add it). A future `pricesIncludeTax` plugin option can flip it per-store.

---

## Behaviour spec

### `calculatePrice(optionData, data, context)`

1. `const code = readSendCloudCode(optionData)` — existing guard
2. `const toCountry = requireString(context.shipping_address?.country_code)` — else throw `INVALID_DATA` with message mentioning `shipping_address.country_code`
3. `const toPostal = context.shipping_address?.postal_code` (optional)
4. `const fromCountry = context.from_location?.address?.country_code ?? this.options_.defaultFromCountryCode` — else throw `INVALID_DATA` mentioning either `from_location` or `defaultFromCountryCode`
5. Aggregate parcel:
   - `totalWeightSourceUnits = sum(items.map(i => (i.variant.weight ?? 0) * i.quantity))`
   - `totalWeightKg = convertToKg(totalWeightSourceUnits, options_.weightUnit ?? "g")`
   - `totalVolumeCm3 = sum(items.map(i => (i.variant.length ?? 0) * (i.variant.width ?? 0) * (i.variant.height ?? 0) * i.quantity))`
   - `side = totalVolumeCm3 > 0 ? Math.cbrt(totalVolumeCm3) : 0`
   - If `totalWeightKg === 0` AND `totalVolumeCm3 === 0` → throw `INVALID_DATA` ("cart has no shippable items; at least one item must declare weight or dimensions")
6. POST filter:
   ```ts
   {
     shipping_option_code: code,
     from_country_code: fromCountry,
     to_country_code: toCountry,
     to_postal_code: toPostal ?? null,
     parcels: [
       {
         weight: { value: String(totalWeightKg.toFixed(3)), unit: "kg" },
         dimensions:
           totalVolumeCm3 > 0
             ? {
                 length: String(side.toFixed(2)),
                 width: String(side.toFixed(2)),
                 height: String(side.toFixed(2)),
                 unit: "cm",
               }
             : undefined,
       },
     ],
     calculate_quotes: true,
   }
   ```
7. `response.data[0]?.quotes?.[0]?.price.total` — else throw `UNEXPECTED_STATE` ("SendCloud returned no quote for `${code}`")
8. Return `{ calculated_amount: Number(total.value), is_calculated_price_tax_inclusive: false }`
9. If `Number.isNaN(calculated_amount)` → throw `UNEXPECTED_STATE` (malformed quote)

### Helpers

- `readSendCloudCode(data)` — reused, unchanged
- `requireString(value, fieldName)` — new helper: if non-string/empty → `INVALID_DATA` with `fieldName` in message
- `convertToKg(value, unit)` — pure function: g→kg /1000, kg→kg, lbs→kg *0.45359237, oz→kg *0.028349523

---

## Types

Tighten `SendCloudShippingOption.quotes` from `unknown[] | null` to a real `SendCloudShippingQuote[]`:

```ts
export type SendCloudShippingQuote = {
  weight?: { min?: SendCloudWeight; max?: SendCloudWeight };
  price: {
    breakdown: Array<{
      type: string;
      label: string;
      price: SendCloudPrice;
    }>;
    total: SendCloudPrice;
  };
  lead_time?: number | null;
};
```

`SendCloudPrice` already exists; no new base types needed.

---

## TDD sequence

### Red

New `describe("calculatePrice")` block in `src/providers/sendcloud/__tests__/service.unit.spec.ts`. Seven cases:

1. **Happy path** — full context (from_location + shipping_address + 2 items) → returns `{ calculated_amount: 17.50, is_calculated_price_tax_inclusive: false }`; nock asserts outbound filter includes `from_country_code`, `to_country_code`, `parcels[0].weight.{value,unit}`, and `calculate_quotes: true`
2. **Falls back to `defaultFromCountryCode` plugin option** when `from_location` is absent
3. **Throws INVALID_DATA** when `shipping_address.country_code` missing
4. **Throws INVALID_DATA** when neither `from_location` nor `defaultFromCountryCode` available
5. **Throws INVALID_DATA** when cart has no weight and no volume (truly empty cart)
6. **Throws UNEXPECTED_STATE** when SendCloud returns `data: []`
7. **Throws UNEXPECTED_STATE** when first option has no quotes
8. **Weight-unit conversion** — cart with `weightUnit: "kg"` sends grams × 1000 correctly (verify outbound parcel weight)
9. **Volume aggregation** — two items (one 1000 cm³, one 8000 cm³) produce a cube with side = cbrt(9000) ≈ 20.80 cm

### Green

1. Extend `SendCloudPluginOptions` with `defaultFromCountryCode?: string` and `weightUnit?: "g" | "kg" | "lbs" | "oz"`
2. Add `SendCloudShippingQuote` type to `src/types/sendcloud-api.ts`; tighten `SendCloudShippingOption.quotes`
3. Add `convertToKg` + `requireString` helpers to `service.ts` (module-scope, alongside `readSendCloudCode`)
4. Override `calculatePrice` on the provider
5. Run tests → green

### Refactor

- `readSendCloudCode` + `requireString` + `convertToKg` are three module-scope helpers. Consider moving to a `src/providers/sendcloud/helpers.ts` if a fourth lands; defer otherwise.
- Re-run the five Ultrathink passes from `CLAUDE.md`.

---

## Docs

- **`docs/calculate-price.md`** — new feature doc
- **`docs/README.md`** — add the entry
- **NOTES.md** — update with any new parked items (currency support, multi-parcel splitting, tax-inclusive pricing flag)
- Replace `it.todo("returns quote price for calculatePrice — §3.4")` with `it.todo("createFulfillment — §3.6")`

---

## Critical files to be created or modified

| Path                                                     | Action                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/providers/sendcloud/service.ts`                     | Override `calculatePrice`; add `requireString` + `convertToKg` helpers |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts` | Add `calculatePrice` describe block; swap the todo marker              |
| `src/types/plugin-options.ts`                            | Add `defaultFromCountryCode`, `weightUnit`                             |
| `src/types/sendcloud-api.ts`                             | Add `SendCloudShippingQuote`; tighten `SendCloudShippingOption.quotes` |
| `docs/calculate-price.md`                                | create                                                                 |
| `docs/README.md`                                         | feature index                                                          |
| `NOTES.md`                                               | parked items                                                           |

---

## Gate + push

1. `make check && npm run test:unit` — all existing tests plus ~9 new calculatePrice tests all green
2. `npx medusa plugin:build` — still clean
3. Single commit: _"Implement calculatePrice with v3 quotes and volumetric aggregation"_
4. `git push origin main`

---

## Out of scope (next plans)

- **§3.6 `createFulfillment`** — the big one. Next cycle target.
- Multi-parcel splitting (multicollo) — spec §8, its own cycle
- Currency conversion for non-EUR stores — requires an external FX source
- `pricesIncludeTax` plugin option for B2B stores — add when a customer actually asks
- Service-point round-trip validation — deferred from cycle 02
