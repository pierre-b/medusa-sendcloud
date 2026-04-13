# Plan 14 — Customs validation warnings (spec §9.4)

## Context

Cycle 05 already enriches `order.metadata.sendcloud_variants` with `hs_code` / `origin_country` / `weight` for every variant in customer-placed orders. Cycle 04's `buildParcelItems` reads from this map and silently drops missing fields — the parcel ships without them, and SendCloud may either:

- accept the parcel and let the customs document show "Unknown" / "0000.00" (depending on carrier policy), or
- reject the announce at request time with a 4xx for non-EU destinations.

Spec §9.4 wants the plugin to **warn at fulfillment creation time** for missing HS code / origin_country / suspicious declared value. This cycle adds those warnings without blocking the announce.

### User decisions

- **Severity:** annotate + log. Persist on `fulfillment.data.sendcloud_warnings[]` (so admins see them post-fulfilment, and the future §15.3 widget can render them) and emit `logger.warn` for ops visibility. Do **not** throw — SendCloud still rejects truly invalid customs at the source, and we don't want to block a fulfillment over a fixable variant data gap.
- **Scope:** auto-detect EU-vs-non-EU using a built-in 27-member country list. No new plugin option.
- **Value rule:** warn when any item has `unit_price === 0` OR when the total declared value is below 1 unit of the order currency (no FX). Catches the most common mistake (free samples shipped internationally).

### Scope constraints

- Only runs in `createFulfillment` — not in `validateFulfillmentData` (storefront can't fix HS codes; admin can).
- No checking of customs documents themselves (paperless trade flag from §9.3 is a separate cycle).
- Not wired to admin email / Slack / dashboard surface — `fulfillment.data.sendcloud_warnings[]` is the single channel; UI presentation lands with §15.2 / §15.3.

---

## When customs validation runs

```
function requiresCustomsCheck(fromCC, toCC):
  if not toCC:               return false   // can't determine destination
  if not fromCC:             return true    // safer to warn when origin unknown
  if fromCC === toCC:        return false   // domestic
  if EU.has(fromCC) and EU.has(toCC): return false   // intra-EU customs union
  return true
```

EU = the 27 current member states (2026):
`AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE`

Notable exclusions (customs IS required for these):

- `GB` — UK left the EU customs union in 2020
- `NO`, `IS`, `CH` — EFTA, not in EU customs union for goods
- `IE` is included; `XI` (Northern Ireland) is **not** in the table — treat as `GB`

---

## Warning shape

```ts
type CustomsWarning = {
  code:
    | "missing_hs_code"
    | "missing_origin_country"
    | "zero_value_item"
    | "low_total_value";
  item_id?: string; // line_item_id when the warning is per-item
  message: string; // human-readable, includes the line_item_id and field
};
```

Persisted on `fulfillment.data.sendcloud_warnings: CustomsWarning[]` (omitted entirely when no warnings — back-compat).

## `validateCustomsData` (new)

New module `src/providers/sendcloud/customs-validation.ts` exporting:

```ts
export const EU_COUNTRY_CODES: ReadonlySet<string>;
export const requiresCustomsCheck: (fromCC?: string, toCC?: string) => boolean;
export const validateCustomsData: (input: {
  items: FulfillmentItemDTO[] | undefined;
  order: Partial<FulfillmentOrderDTO> | undefined;
  variantsMap: SendCloudVariantsMap;
}) => CustomsWarning[];
```

`validateCustomsData` walks the order's line items, reads `hs_code` / `origin_country` from `variantsMap`, and the `unit_price` from `order.items`. Per-item warnings push one entry per missing field. Total-value warning is computed once across all line items.

## `createFulfillment` integration

After building parcels, before calling the announce endpoint:

```ts
const fromCC = this.options_.defaultFromCountryCode;
const toCC = toAddress.country_code;
let warnings: CustomsWarning[] = [];
if (requiresCustomsCheck(fromCC, toCC)) {
  warnings = validateCustomsData({ items, order, variantsMap });
  for (const w of warnings) {
    this.logger_?.warn(
      `medusa-sendcloud customs warning [${w.code}]: ${w.message}`
    );
  }
}
// ... announce ...
if (warnings.length > 0) {
  baseData.sendcloud_warnings = warnings;
}
```

Single-parcel and multi-collo paths share the same warnings emission — `baseData` is built before the multi-collo branch tacks on `is_multicollo` / `parcels[]`.

## Fields not validated

- **Item description** — always present (`item.title ?? ""`); empty string still satisfies SendCloud's required field, no admin action available.
- **Quantity** — guaranteed >0 by Medusa's order line-item invariant.
- **Weight** — separate validation in cycle 04 (`buildShipmentParcel` throws if cart is weightless). Cycle 14 doesn't duplicate.
- **Currency** — order-level invariant.

## Tests

### `src/providers/sendcloud/__tests__/customs-validation.unit.spec.ts` — 8 cases

1. `requiresCustomsCheck` — FR→DE returns false (intra-EU)
2. `requiresCustomsCheck` — FR→US returns true (cross-border)
3. `requiresCustomsCheck` — US→FR returns true (non-EU origin)
4. `requiresCustomsCheck` — FR→GB returns true (post-Brexit)
5. `requiresCustomsCheck` — undefined/empty fromCC returns true (safer); undefined toCC returns false (can't determine)
6. `validateCustomsData` — all variants have hs_code + origin_country, all unit_price > 0, total > 1 → empty array
7. `validateCustomsData` — one item missing hs_code, one missing origin_country, one with unit_price 0 → 3 entries with correct codes
8. `validateCustomsData` — total of all items below 1 → `low_total_value` warning emitted

### `src/providers/sendcloud/__tests__/service.unit.spec.ts` — 3 new cases under `createFulfillment`

1. Intra-EU shipment with missing hs_code → no warnings on fulfillment.data, no logger.warn
2. FR→US shipment with full customs data → no warnings, normal output
3. FR→US shipment with missing hs_code on one variant → `fulfillment.data.sendcloud_warnings` has the entry, `logger.warn` called once

Total: **161 + 11 = 172** unit tests post-cycle (1 todo).

---

## Critical files

| Path                                                                | Action                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/providers/sendcloud/customs-validation.ts`                     | create                                                                              |
| `src/providers/sendcloud/service.ts`                                | edit — call `validateCustomsData` in createFulfillment, attach `sendcloud_warnings` |
| `src/providers/sendcloud/__tests__/customs-validation.unit.spec.ts` | create                                                                              |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts`            | edit — +3 cases, swap todo marker                                                   |
| `docs/customs-validation.md`                                        | create                                                                              |
| `docs/README.md`                                                    | index + roadmap update                                                              |
| `NOTES.md`                                                          | parked items                                                                        |

---

## Gate + push

1. `make check && npm run test:unit` — 161 → 172 passing, 1 todo
2. `npx medusa plugin:build` — green
3. Single commit: _"Add customs validation warnings for international fulfillments"_
4. `git push origin main`

---

## Out of scope

- Hard-blocking the announce (chosen against; SendCloud is the authoritative gate)
- Admin email / Slack notification of warnings (no notification infra in the plugin)
- Configurable EU country list / customs union plugin option (auto-detect is correct for the standard case)
- Currency-aware "low total value" thresholds (no FX source; literal `< 1` rule covers the 0 / cents-by-mistake case)
- `paperless_trade` flag from spec §9.3 (separate cycle when the consuming admin needs it)
- `it.todo` next target: **fulfillment creation widget — §15.3 (admin UI for parcel split + service-point pickup)**
