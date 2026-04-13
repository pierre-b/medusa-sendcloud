# Plan 14 — Customs validation warnings + UI surfaces (spec §9.4 + §15.2 partial)

## Context

Cycle 05 already enriches `order.metadata.sendcloud_variants` with `hs_code` / `origin_country` / `weight` for every variant in customer-placed orders. Cycle 04's `buildParcelItems` reads from this map and silently drops missing fields — the parcel ships without them, and SendCloud may either:

- accept the parcel and let the customs document show "Unknown" / "0000.00" (depending on carrier policy), or
- reject the announce at request time with a 4xx for non-EU destinations.

Spec §9.4 wants the plugin to **warn at fulfillment creation time** for missing HS code / origin_country / suspicious declared value. This cycle adds those warnings AND surfaces them in the admin UI:

- **Configuration warnings** (e.g., `defaultFromCountryCode` not set) → new section in the existing `/app/settings/sendcloud` page (cycle 11)
- **Per-fulfillment warnings** (e.g., HS code missing on a specific order's line item) → new admin widget on the order details page (`order.details.side.after` zone — partial §15.2)

### User decisions

- **Severity:** annotate + log. Persist on `fulfillment.data.sendcloud_warnings[]` and emit `logger.warn`. No throw — SendCloud is the authoritative gate.
- **Scope:** auto-detect EU-vs-non-EU using a built-in 27-member country list. No config option.
- **Value rule:** warn when any item has `unit_price === 0` OR when total declared value < 1 in order currency (no FX).
- **Behaviour when `defaultFromCountryCode` is unset:** **skip** the per-fulfillment customs check entirely (no noisy warnings on every order) AND emit a global config warning visible in the settings page. Merchant fixes once at install.
- **UI surfaces:** both — extend settings page with a "Configuration & health" section, and add a new widget on the order details page.
- **Widget zone:** `order.details.side.after`. Hidden when no warnings on any of the order's fulfillments.

### Scope constraints

- Per-fulfillment customs check runs only in `createFulfillment` (not `validateFulfillmentData` — checkout can't fix HS codes).
- Widget reads `order.fulfillments[].data.sendcloud_warnings` from the AdminOrder DTO (DetailWidgetProps) — no new admin endpoint needed.
- Settings page extension reuses the existing `/admin/sendcloud/dashboard` endpoint — additive `config_warnings` field on the response.
- Paperless trade flag (§9.3) stays out of scope.
- Customs documents themselves stay out of scope.

---

## Backend — customs validation

### When the per-fulfillment check runs

```
function requiresCustomsCheck(fromCC?, toCC?):
  if !toCC:                  return false   // can't determine destination
  if !fromCC:                return false   // skip when origin unknown — config warning surfaces it once
  if fromCC === toCC:        return false   // domestic
  if EU.has(fromCC) && EU.has(toCC): return false   // intra-EU customs union
  return true
```

EU = the 27 current member states (2026), source: <https://european-union.europa.eu/principles-countries-history/eu-countries_en>:
`AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE`

Excluded (customs IS required for these): `GB`, `NO`, `IS`, `CH`, Channel Islands (`JE`, `GG`), `XI` (Northern Ireland — different customs status from `IE`).

### CustomsWarning shape

```ts
type CustomsWarning = {
  code:
    | "missing_hs_code"
    | "missing_origin_country"
    | "zero_value_item"
    | "low_total_value";
  line_item_id?: string; // populated for per-item warnings; absent for shipment-wide rules
  message: string; // human-readable, includes the line_item_id and field
};
```

Persisted on `fulfillment.data.sendcloud_warnings: CustomsWarning[]` (omitted when empty — back-compat).

### Per-variant deduplication

If the same variant appears in multiple line items (rare but possible) and is missing both `hs_code` and `origin_country`, walk by **distinct variant_id** rather than by line item. That keeps warning count proportional to "things to fix" (number of variants), not "lines on the invoice". A bulk order of 50 lines all referencing the same broken variant produces 2 warnings (one per missing field), not 100.

### `validateCustomsData(input)`

New module `src/providers/sendcloud/customs-validation.ts`:

```ts
export const EU_COUNTRY_CODES: ReadonlySet<string>;
export const requiresCustomsCheck: (fromCC?: string, toCC?: string) => boolean;
export const validateCustomsData: (input: {
  items: FulfillmentItemDTO[] | undefined;
  order: Partial<FulfillmentOrderDTO> | undefined;
  variantsMap: SendCloudVariantsMap;
}) => CustomsWarning[];
```

### `createFulfillment` integration

After parcels built, before announce:

```ts
const fromCC = this.options_.defaultFromCountryCode;
const toCC = toAddress.country_code;
let warnings: CustomsWarning[] = [];
if (requiresCustomsCheck(fromCC, toCC)) {
  warnings = validateCustomsData({ items, order, variantsMap });
  for (const w of warnings) {
    this.logger_?.warn(`medusa-sendcloud customs [${w.code}]: ${w.message}`);
  }
}
// ... announce ...
if (warnings.length > 0) {
  baseData.sendcloud_warnings = warnings;
}
```

---

## Backend — configuration health

### `getConfigWarnings(options)` (new helper)

In `src/providers/sendcloud/config-health.ts`:

```ts
type ConfigWarning = {
  code: "missing_from_country" | "missing_webhook_secret";
  message: string;
};

export const getConfigWarnings: (
  options: SendCloudPluginOptions
) => ConfigWarning[];
```

Initial rules:

- `defaultFromCountryCode` missing or not 2-letter ISO → `missing_from_country` ("International customs validation disabled until `defaultFromCountryCode` is set in `medusa-config.ts`.")
- `webhookSecret` missing or empty → `missing_webhook_secret` ("SendCloud webhooks rejected with 401 until `webhookSecret` is configured.")

Future rules (parked): `brandId` missing for multi-brand, `defaultInsuranceAmount` set without `enableReturns`, etc. — leave the helper extensible.

### Dashboard endpoint extension

`src/providers/sendcloud/dashboard.ts` — `fetchDashboardSnapshot` already returns `{ connected, error?, shipping_options }`. Add `config_warnings: ConfigWarning[]` to the snapshot, populated by `getConfigWarnings(options)` regardless of upstream connectivity.

The route `src/api/admin/sendcloud/dashboard/route.ts` already has access to the resolved provider. Pull `provider.options_` (or pass via the snapshot helper signature) to compute config_warnings. Cleanest: `fetchDashboardSnapshot(container, key)` resolves the provider and computes both connectivity AND config_warnings together.

---

## Frontend — settings page extension

`src/admin/routes/settings/sendcloud/page.tsx` (cycle 11) gains a new section:

```
## Configuration & health
[empty when no warnings]
[red badge per warning when warnings present, with code label + message text]
```

Rendered above the existing "Connection" section so admins see config issues first. Each warning uses `Badge color="orange"` + `Text` description.

When `data.config_warnings` is empty/undefined, the section renders nothing (or a small `Text size="small"`: "No configuration warnings.").

---

## Frontend — order details widget

New file `src/admin/widgets/sendcloud-order-warnings.tsx`:

```tsx
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { Container, Heading, Badge, Text } from "@medusajs/ui";
import type { DetailWidgetProps, AdminOrder } from "@medusajs/framework/types";

const SendcloudOrderWarnings = ({ data }: DetailWidgetProps<AdminOrder>) => {
  const warnings = (data.fulfillments ?? []).flatMap(
    (f) => (f.data?.sendcloud_warnings as CustomsWarning[] | undefined) ?? []
  );
  if (warnings.length === 0) return null;
  // Render Container with one row per warning, badge + message
};

export const config = defineWidgetConfig({ zone: "order.details.side.after" });
export default SendcloudOrderWarnings;
```

Hidden when no fulfillment carries warnings. Renders one `Container` with grouped warnings sorted by `code`.

---

## Tests

### `src/providers/sendcloud/__tests__/customs-validation.unit.spec.ts` — 9 cases

1. `requiresCustomsCheck` — FR→DE → false (intra-EU)
2. FR→US → true; US→FR → true; FR→GB → true (post-Brexit)
3. Missing toCC → false; missing fromCC → false (skip-when-unset)
4. fromCC === toCC → false (domestic)
5. `validateCustomsData` — all valid → empty
6. Missing hs_code, missing origin_country, unit_price 0 → 3 warnings with correct codes + line_item_ids
7. Total declared value < 1 → `low_total_value` (single shipment-wide entry, no line_item_id)
8. Same variant on multiple line items, both missing hs_code → 1 warning per missing field per variant (not per line)
9. Empty `variantsMap` (manual order) → warnings emitted for every line, dedup via variant_id

### `src/providers/sendcloud/__tests__/config-health.unit.spec.ts` — 3 cases

1. All options present → no warnings
2. Missing `defaultFromCountryCode` → `missing_from_country` warning
3. Missing `webhookSecret` → `missing_webhook_secret` warning

### `src/providers/sendcloud/__tests__/dashboard.unit.spec.ts` — 1 new case

1. Snapshot includes `config_warnings: []` on happy path; includes the missing-from-country warning when option absent

### `src/providers/sendcloud/__tests__/service.unit.spec.ts` — 3 new cases under `createFulfillment`

1. Intra-EU shipment with missing hs_code → no `sendcloud_warnings` key, no `logger.warn`
2. FR→US shipment with full customs data → no warnings emitted
3. FR→US shipment with one variant missing hs_code → `fulfillment.data.sendcloud_warnings` has the entry, `logger.warn` called once
4. Skip-when-unset: no `defaultFromCountryCode` configured + cross-border destination → no per-fulfillment warnings (verified via `logger.warn` not called)

Total: **161 + 16 = 177** unit tests post-cycle (1 todo).

Admin-side widget + settings extension: **no automated tests** (no admin test harness — same rationale as cycle 11). Manual verification: build the plugin, mount in the sample app, hit the order detail page.

---

## Critical files

| Path                                                                | Action                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/providers/sendcloud/customs-validation.ts`                     | create                                                                              |
| `src/providers/sendcloud/config-health.ts`                          | create                                                                              |
| `src/providers/sendcloud/dashboard.ts`                              | edit — include `config_warnings` in snapshot                                        |
| `src/providers/sendcloud/service.ts`                                | edit — call `validateCustomsData` in createFulfillment, attach `sendcloud_warnings` |
| `src/admin/routes/settings/sendcloud/page.tsx`                      | edit — add "Configuration & health" section                                         |
| `src/admin/widgets/sendcloud-order-warnings.tsx`                    | create                                                                              |
| `src/providers/sendcloud/__tests__/customs-validation.unit.spec.ts` | create                                                                              |
| `src/providers/sendcloud/__tests__/config-health.unit.spec.ts`      | create                                                                              |
| `src/providers/sendcloud/__tests__/dashboard.unit.spec.ts`          | edit — +1 case for config_warnings                                                  |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts`            | edit — +4 cases, swap todo marker                                                   |
| `docs/customs-validation.md`                                        | create                                                                              |
| `docs/admin-settings.md`                                            | edit — document the config warnings section                                         |
| `docs/README.md`                                                    | index + roadmap update                                                              |
| `NOTES.md`                                                          | parked items                                                                        |

---

## Gate + push

1. `make check && npm run test:unit` — 161 → 177 passing, 1 todo
2. `npx medusa plugin:build` — green (admin extensions compile too)
3. Single commit: _"Add customs validation with admin warning surfaces"_
4. `git push origin main`

---

## Out of scope

- Hard-blocking the announce (chosen against; SendCloud is the authoritative gate)
- Admin email / Slack notification of warnings
- Configurable EU country list / customs union plugin option
- Currency-aware "low total value" thresholds
- `paperless_trade` flag from spec §9.3
- Fulfillment creation form (§15.3 — admin parcel-split + service-point UI)
- Order-detail widget for tracking + label download (the rest of §15.2 — separate cycle)
- `it.todo` next target: **fulfillment creation widget — §15.3**
