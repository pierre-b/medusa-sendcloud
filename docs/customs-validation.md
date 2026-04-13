# Customs validation warnings (spec §9.4)

Backend safety net + admin UI surfaces for international fulfillments. Warns when an outbound parcel is missing data SendCloud needs for cross-border customs declarations: HS code, country of origin, declared value.

The plugin **does not block** the announce — SendCloud is the authoritative gate. The plugin's job is to surface the gap so admins can fix variant data without waiting for an upstream rejection.

## Two surfaces

1. **Per-fulfillment warnings** — emitted at `createFulfillment` time, persisted on `fulfillment.data.sendcloud_warnings[]`, displayed in the order details page via the `sendcloud-order-warnings` admin widget (zone `order.details.side.after`).
2. **Configuration warnings** — emitted at any dashboard fetch, surfaced on `/app/settings/sendcloud` under "Configuration & health". Currently flags two cases: `defaultFromCountryCode` missing and `webhookSecret` missing.

## When the per-fulfillment check runs

```
function requiresCustomsCheck(fromCC, toCC):
  if !toCC:                        return false   // no destination
  if !fromCC:                      return false   // skip when origin unknown
  if fromCC === toCC:              return false   // domestic
  if EU.has(fromCC) && EU.has(toCC): return false // intra-EU customs union
  return true
```

`fromCC` is the plugin option `defaultFromCountryCode`. If it's not configured, the per-fulfillment check is **disabled entirely** and the dashboard's "Configuration & health" section flags it once. Merchant fixes once at install instead of getting noisy warnings on every order.

EU = the 27 member states (2026 list, source [european-union.europa.eu](https://european-union.europa.eu/principles-countries-history/eu-countries_en)):

`AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE`

Customs **is** required for these (excluded from the EU set): `GB`, `NO`, `IS`, `CH`, Channel Islands (`JE`, `GG`), Northern Ireland (`XI`).

## Warning shape

```ts
type CustomsWarning = {
  code:
    | "missing_hs_code"
    | "missing_origin_country"
    | "zero_value_item"
    | "low_total_value";
  line_item_id?: string; // present for per-item warnings; absent for shipment-wide rules
  message: string;
};
```

Persisted on `fulfillment.data.sendcloud_warnings: CustomsWarning[]` (omitted when empty — back-compat).

## Per-variant deduplication

If the same variant (`var_x`) appears across multiple line items and is missing both `hs_code` and `origin_country`, `validateCustomsData` walks by **distinct variant_id** rather than per line item. A bulk order of 50 lines all referencing one broken variant produces 2 warnings, not 100. This keeps the count proportional to "things to fix".

## Configuration health

```ts
type ConfigWarning = {
  code: "missing_from_country" | "missing_webhook_secret";
  message: string;
};
```

Returned on `GET /admin/sendcloud/dashboard` as `config_warnings: ConfigWarning[]`. Computed against `provider.options_` regardless of upstream connectivity (a SendCloud outage doesn't suppress config warnings).

## Files

| Path                                             | Role                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `src/providers/sendcloud/customs-validation.ts`  | `EU_COUNTRY_CODES`, `requiresCustomsCheck`, `validateCustomsData`                   |
| `src/providers/sendcloud/config-health.ts`       | `getConfigWarnings(options)`                                                        |
| `src/providers/sendcloud/dashboard.ts`           | extended snapshot includes `config_warnings`                                        |
| `src/providers/sendcloud/service.ts`             | `createFulfillment` calls `validateCustomsData` when `requiresCustomsCheck` is true |
| `src/admin/routes/settings/sendcloud/page.tsx`   | "Configuration & health" section                                                    |
| `src/admin/widgets/sendcloud-order-warnings.tsx` | order detail widget reading `fulfillments[].data.sendcloud_warnings`                |

## Tests

- `src/providers/sendcloud/__tests__/customs-validation.unit.spec.ts` — 9 cases
- `src/providers/sendcloud/__tests__/config-health.unit.spec.ts` — 3 cases
- `src/providers/sendcloud/__tests__/dashboard.unit.spec.ts` — 1 new case (config_warnings on snapshot)
- `src/providers/sendcloud/__tests__/service.unit.spec.ts` — 4 new cases under `createFulfillment`

Admin UI surfaces (settings section + order widget) have no automated tests — Medusa admin testing infra is out of scope for this cycle. Manual verification: build the plugin, mount in the sample app, hit the order detail page for an international order with broken variant data.

## Out of scope

- Hard-blocking the announce (SendCloud is the authoritative gate)
- Configurable EU country list / customs union plugin option (auto-detect is correct for the standard case)
- Currency-aware "low total value" thresholds (literal `< 1` rule covers zero-or-mistake)
- Paperless trade flag (spec §9.3 — separate cycle)
- Email / Slack notification of warnings
