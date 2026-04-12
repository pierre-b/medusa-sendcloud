# Service-point Lookup — `GET /store/sendcloud/service-points`

Implements spec §5. Storefront-facing proxy to SendCloud's v2 service-points API for PUDO pickup-point selection at checkout.

## Flow

```
Customer picks a shipping option where sendcloud_requires_service_point === true
  → storefront calls GET /store/sendcloud/service-points?country=NL&postal_code=...
  → plugin resolves the fulfillment provider, builds the outbound GET,
    forwards to https://servicepoints.sendcloud.sc/api/v2/service-points
    with Basic Auth
  → plugin returns { service_points: [...] } — pass-through of SendCloud's array
  → storefront renders a map / list; customer picks one
  → storefront stores the chosen service_point_id on the shipping method data
  → cycle 02's validateFulfillmentData enforces presence
  → cycle 04's createFulfillment forwards it as to_service_point.id
```

## Endpoint

`GET https://{your-medusa-host}/store/sendcloud/service-points`

Medusa's `/store/*` routes require the `x-publishable-api-key` header — the JS SDK and Next.js Starter handle this automatically.

## Query parameters

Allowlist-only. Unknown params are silently dropped.

| Param          | Type    | Required | Notes                                            |
| -------------- | ------- | -------- | ------------------------------------------------ |
| `country`      | string  | **yes**  | ISO 3166-1 alpha-2; coerced to upper-case        |
| `postal_code`  | string  | no       | Max 12 chars                                     |
| `city`         | string  | no       |                                                  |
| `house_number` | string  | no       |                                                  |
| `carrier`      | string  | no       | `"postnl"`, `"dhl"`, `"dpd"`, … — filters to one |
| `radius`       | integer | no       | Meters; non-numeric / zero / negative ignored    |
| `latitude`     | string  | no       | Decimal                                          |
| `longitude`    | string  | no       | Decimal                                          |

Other SendCloud service-points params (`ne_*`, `sw_*`, `pudo_id`, `weight`, `shop_type`, `general_shop_type`, `access_token`) are **not** forwarded this cycle — add on demand.

## Response

### `200 OK`

```json
{
  "service_points": [
    {
      "id": 12345,
      "code": "NL-12345",
      "name": "Kiosk Corner",
      "street": "Stationsplein",
      "house_number": "1",
      "postal_code": "1012AB",
      "city": "Amsterdam",
      "latitude": "52.3",
      "longitude": "4.9",
      "carrier": "postnl",
      "country": "NL",
      "formatted_opening_times": { "monday": ["08:00-18:00"] },
      "open_tomorrow": true,
      "open_upcoming_week": true,
      "distance": 123
    }
  ]
}
```

Pass-through of SendCloud's response — field documentation lives in SendCloud's API docs and in the committed snapshot at `docs/openapi-snapshots/service-points.yaml`.

### `400 Bad Request`

```json
{
  "message": "medusa-sendcloud: query.country is required (ISO 3166-1 alpha-2)"
}
```

Fires for missing / invalid `country`. All other malformed inputs are silently dropped.

### `502 Bad Gateway`

Upstream SendCloud call failed — bad credentials, network error, or the fulfillment provider isn't registered. Body: `{ "message": string }` with the upstream error detail when available.

## Example storefront usage (Medusa JS SDK)

```ts
import { sdk } from "@medusajs/js-sdk";

const { service_points } = await sdk.client.fetch<{
  service_points: SendCloudServicePoint[];
}>("/store/sendcloud/service-points", {
  method: "GET",
  query: {
    country: "NL",
    postal_code: "1012AB",
    carrier: "postnl",
    radius: 2000,
  },
});
```

The SDK forwards the publishable key automatically — never call `fetch()` directly on `/store/*` routes.

## Ephemeral IDs

Per SendCloud's documentation and plugin spec §5.3, service-point IDs are **volatile** — they can change between lookups. Don't cache them beyond the checkout session. The plugin deliberately doesn't add a TTL cache layer: whatever the customer sees in their checkout flow is what gets forwarded to `createFulfillment`, and SendCloud's Return 404 on stale IDs at create time is surfaced as an admin-facing error via `SendCloudClient.request()` error mapping.

## Tests

`src/providers/sendcloud/__tests__/service-points.unit.spec.ts` — 11 cases:

- `parseServicePointsQuery` — missing/blank/non-2char country, uppercasing, allowlist pass-through, drop-blanks, radius parsing (positive int, 0, NaN, empty)
- `fetchSendcloudServicePoints` — happy path (asserts outbound URL + auth + query), upstream 401 → 502, provider not registered → 502, network error → 502

## Scope / deferred

- No in-memory TTL cache — ephemeral IDs make caching wrong beyond a minute or two
- No OAuth2 / `access_token` auth forwarding — Basic Auth only
- `ne_*`, `sw_*`, `weight`, `pudo_id`, `shop_type` query params not exposed
- No admin widget that previews service points — dedicated admin cycle
- No route-level integration test (would require booting Medusa HTTP runner)
