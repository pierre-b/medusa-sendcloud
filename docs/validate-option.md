# Validate Option + Can Calculate — `validateOption`, `canCalculate`

Implements spec §3.2 and §3.5. Both are admin-time hooks fired when a Medusa admin creates or saves a shipping option.

## Flow

```
Admin opens "Create shipping option" and picks the "sendcloud" fulfillment provider
  → admin selects one of the options returned by getFulfillmentOptions (§3.1)
  → admin saves
  → Medusa fulfillment module calls provider.validateOption(shippingOption.data)
  → validateOption extracts data.sendcloud_code → round-trips to SendCloud
  → if the code still resolves on SendCloud, return true and the option is persisted
  → if the option is type: "calculated", Medusa also calls provider.canCalculate(…)
  → canCalculate returns true unconditionally (SendCloud always quotes)
```

## SendCloud endpoint

Same as §3.1 — `POST https://panel.sendcloud.sc/api/v3/shipping-options` — this time with a filter:

```json
{ "shipping_option_code": "postnl:standard/signature" }
```

SendCloud returns `{ data: ShippingOption[], message: string | null }`. We return `true` **only if** at least one entry in `data` has `code` strictly equal to the requested code. This defensive equality guards against any fuzzy-matching behaviour the filter might apply server-side.

## Inputs

### `validateOption(data)`

| Field on `data`  | Type              | Purpose                                                                                                                      |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `sendcloud_code` | string (required) | The SendCloud shipping option code (e.g., `postnl:standard/signature`). Populated by §3.1's `getFulfillmentOptions` mapping. |

Missing or empty `sendcloud_code` → `MedusaError.Types.INVALID_DATA` with message `medusa-sendcloud: option data is missing sendcloud_code`.

### `canCalculate(_data)`

Parameter ignored. Always returns `true`. Per spec §3.5 — the v3 shipping-options endpoint can quote any option.

## Error handling

`validateOption` delegates network errors to `SendCloudClient.request()`. A `401` from SendCloud surfaces as `MedusaError.Types.UNAUTHORIZED` — not swallowed into a `false` result. "Option invalid" and "auth broken" are different failure modes and must surface separately.

## Plugin options surfaced

None directly. Inherits `baseUrl`, `maxRetries`, `retryBaseDelayMs` via the client.

## Tests

- `src/providers/sendcloud/__tests__/service.unit.spec.ts` — `describe("validateOption")` and `describe("canCalculate")`
- Coverage: round-trip success, empty-data false, defensive-equality false, missing/empty code throws, client-error propagation, unconditional true for `canCalculate`

## Manual verification

1. In Medusa Admin → Settings → Locations → a location → Shipping → Create shipping option
2. Fulfillment Provider: `sendcloud`
3. Fulfillment Option: pick any from the dropdown populated by §3.1
4. Save — success means `validateOption` returned `true` for the chosen code
5. If saving fails with a `UNAUTHORIZED` toast, re-check plugin credentials; a 401 is surfaced to admins instead of silently treated as "invalid option"
