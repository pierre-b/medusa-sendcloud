# Fulfillment Options — `getFulfillmentOptions`

Implements spec §3.1. Returns the list of SendCloud carrier-service combinations that a Medusa admin can choose from when creating a shipping option (Settings → Locations → Shipping).

## Flow

```
Admin opens "Create shipping option" modal
  → Medusa calls fulfillment module
  → fulfillment module calls sendcloud provider's getFulfillmentOptions()
  → provider.client_.request({ method: "POST", path: "/api/v3/shipping-options", body: {} })
  → SendCloud returns { data: ShippingOption[], message: string | null }
  → provider maps each to FulfillmentOption with stable id sendcloud_{code}
  → options render in the admin dropdown
```

## SendCloud endpoint

- `POST https://panel.sendcloud.sc/api/v3/shipping-options`
- Operation id: `sc-public-v3-scp-post-shipping_options` (see `docs/openapi-snapshots/shipping-options.yaml`)
- Neighbour `POST /api/v3/fetch-shipping-options` is **deprecated 2026-01-14** — do not use it.

### Request

All fields on the `shipping-option-filter` schema are optional. For `getFulfillmentOptions()` we POST `{}` — no cart context is available at admin-config time, so we accept that `quotes[]` will be empty and use the endpoint purely for listing.

Future cycles (`calculatePrice`, `validateFulfillmentData`) will populate `from_country_code`, `to_country_code`, `parcels[]`, and `calculate_quotes: true`.

### Response mapping

| SendCloud v3 field                       | Medusa `FulfillmentOption` field                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `code`                                   | `id` (prefixed as `sendcloud_${code}`); also preserved raw as `sendcloud_code` |
| `name`                                   | `name`                                                                         |
| `carrier.code`                           | `sendcloud_carrier_code`                                                       |
| `carrier.name`                           | `sendcloud_carrier_name`                                                       |
| `product.code`                           | `sendcloud_product_code`                                                       |
| `requirements.is_service_point_required` | `sendcloud_requires_service_point`                                             |
| `functionalities` (full object)          | `sendcloud_functionalities`                                                    |

The unmapped v3 fields (`contract`, `weight`, `max_dimensions`, `parcel_billed_weights`, `charging_type`, `quotes`) are not needed until later cycles. They stay in the snapshot for reference.

## Error handling

Delegated to `SendCloudClient.request()` (see `src/services/sendcloud-client.ts`). Retries 429/5xx up to 3 times with exponential backoff (honours `Retry-After`); maps non-retryable 4xx to the appropriate `MedusaError.Types`:

| Status        | MedusaError        |
| ------------- | ------------------ |
| 400, 422      | `INVALID_DATA`     |
| 401           | `UNAUTHORIZED`     |
| 403           | `FORBIDDEN`        |
| 404           | `NOT_FOUND`        |
| 409           | `CONFLICT`         |
| 429 exhausted | `UNEXPECTED_STATE` |
| 5xx exhausted | `UNEXPECTED_STATE` |
| Network       | `UNEXPECTED_STATE` |

Error message format: `SendCloud (${status}): ${detail}` — SendCloud's per-error `detail` (JSON:API error format) surfaces verbatim.

## Plugin options surfaced

None directly. The client inherits `baseUrl`, `maxRetries`, `retryBaseDelayMs` from the plugin options (see `src/types/plugin-options.ts`).

## Tests

- `src/providers/sendcloud/__tests__/service.unit.spec.ts` — behaviour: request shape, v3 → FulfillmentOption mapping, empty response
- `src/services/__tests__/sendcloud-client.request.unit.spec.ts` — resilience: retries, error mapping, network failures
- Mocked HTTP via `nock` (chosen after msw v2 hit `@swc/jest` ESM interop issues; see NOTES.md)

## Manual verification

1. `yarn medusa plugin:publish` from this repo
2. In a consuming Medusa app: `yarn medusa plugin:add medusa-sendcloud`
3. Register the provider in `medusa-config.ts` with real sandbox keys
4. Boot admin → Settings → Locations → a location → Shipping → Create shipping option → Fulfillment Provider: `sendcloud`
5. The dropdown "Fulfillment Option" should list every enabled SendCloud carrier-service with its human-readable name
