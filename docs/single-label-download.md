# Per-Fulfillment Label — `GET /admin/sendcloud/labels/{fulfillment_id}`

Implements spec §6.2. The common case: admin views one order, clicks "Print label", gets the PDF.

## Flow

```
Admin action in dashboard → GET /admin/sendcloud/labels/ful_123?paper_size=a6&dpi=300
  → plugin validates query (paper_size + optional dpi)
  → plugin resolves fulfillment via query.graph → reads data.sendcloud_parcel_id
  → plugin GETs https://panel.sendcloud.sc/api/v3/parcels/{parcel_id}/documents/label?paper_size=a6&dpi=300
  → SendCloud returns the single-parcel label as PDF binary
  → plugin streams it back with Content-Disposition: attachment
  → browser prompts download of sendcloud-label-YYYY-MM-DD-<parcel_id>.pdf
```

## Endpoint

`GET https://{your-medusa-host}/admin/sendcloud/labels/{fulfillment_id}`

Admin session auth required (Medusa default on `/admin/*`).

### Path params

| Param            | Type   | Required | Notes                 |
| ---------------- | ------ | -------- | --------------------- |
| `fulfillment_id` | string | **yes**  | Medusa fulfillment ID |

### Query params

| Param        | Type                             | Required | Notes                                                                                |
| ------------ | -------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `paper_size` | `"a4" \| "a6"`                   | no       | Defaults to `"a6"`                                                                   |
| `dpi`        | `72 \| 150 \| 203 \| 300 \| 600` | no       | SendCloud's default for PDF is 72. ZPL is carrier-native so DPI is ignored upstream. |

## Response

### `200 OK`

Binary `application/pdf` stream with `Content-Disposition: attachment; filename="sendcloud-label-<YYYY-MM-DD>-<parcel_id>.pdf"`.

### `400 Bad Request`

```json
{ "message": "medusa-sendcloud: <reason>" }
```

Fires when:

- `fulfillment_id` path param is missing
- `paper_size` is not one of the enum
- `dpi` is not one of the allowed values
- The fulfillment exists in Medusa but has no `data.sendcloud_parcel_id` (e.g. a manual fulfillment)

### `404 Not Found`

```json
{ "message": "medusa-sendcloud: unknown fulfillment <id>" }
```

The fulfillment ID doesn't resolve via Query.

### `502 Bad Gateway`

Upstream SendCloud call failed, Query threw, or the fulfillment provider isn't registered.

## Upstream

`GET /api/v3/parcels/{id}/documents/label` — operationId `sc-public-v3-scp-get-retrieve_parcel_documents`. Same OpenAPI snapshot as the bulk route: `docs/openapi-snapshots/parcel-documents.yaml`.

## Implementation

- `parseLabelQuery` (`helpers.ts`) — validates the `paper_size` + `dpi` pair
- `fetchSendcloudLabel` (`src/providers/sendcloud/fulfillment-label.ts`) — resolves fulfillment, reads `sendcloud_parcel_id`, calls `requestBinary` on the single-parcel endpoint
- `buildProviderRegistrationKey` (`src/providers/sendcloud/registration.ts`) — shared utility extracted this cycle (4 callers now)

## Tests

`src/providers/sendcloud/__tests__/fulfillment-label.unit.spec.ts` — 12 cases:

- `parseLabelQuery` × 5: default paper_size, valid combos, invalid paper_size, invalid dpi, empty dpi string
- `fetchSendcloudLabel` × 7: happy path (PDF streamed, outbound URL + query asserted), dpi omission when unset, unknown fulfillment → 404, missing sendcloud_parcel_id → 400, provider not registered → 502, Query throws → 502, upstream 404 → 502

## Relationship to the bulk route

For n ≥ 2 labels, admins use `POST /admin/sendcloud/labels/bulk` (cycle 09). For n = 1 this route exists because:

- GET semantics are a better fit for single-resource reads
- Path-based URL means admin UIs can link to it directly (no JSON body to construct)
- No 20-parcel cap concern

Both routes share the same helpers (`requestBinary`, `buildProviderRegistrationKey`) and return identical `Content-Disposition` semantics.
