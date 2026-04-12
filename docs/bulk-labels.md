# Bulk Label Download — `POST /admin/sendcloud/labels/bulk`

Implements spec §6.3. Warehouse pick-and-pack UX — admin selects up to 20 fulfillments in Medusa, downloads a single PDF containing every label.

## Flow

```
Admin selects fulfillments, clicks "Download labels"
  → admin UI POSTs { fulfillment_ids: [...], paper_size: "a6" } to /admin/sendcloud/labels/bulk
  → plugin validates body (1..=20 non-empty string ids, optional paper_size enum)
  → plugin resolves each fulfillment via query.graph → reads data.sendcloud_parcel_id
  → plugin GETs https://panel.sendcloud.sc/api/v3/parcel-documents/label
      ?parcels=X&parcels=Y&...&paper_size=a6
  → SendCloud returns a single merged PDF as binary
  → plugin streams the PDF back with Content-Disposition: attachment
  → browser downloads sendcloud-labels-<timestamp>.pdf
```

## Endpoint

`POST https://{your-medusa-host}/admin/sendcloud/labels/bulk`

Admin-auth is required — Medusa's session/bearer auth on `/admin/*` routes.

## Request body

```json
{
  "fulfillment_ids": ["ful_1", "ful_2", "ful_3"],
  "paper_size": "a6"
}
```

| Field             | Type           | Required | Notes                       |
| ----------------- | -------------- | -------- | --------------------------- |
| `fulfillment_ids` | `string[]`     | **yes**  | 1–20 Medusa fulfillment IDs |
| `paper_size`      | `"a4" \| "a6"` | no       | Defaults to `"a6"`          |

Other body keys are ignored. `fulfillment_ids` must be a non-empty array of non-empty strings.

## Response

### `200 OK`

Binary `application/pdf` body. Headers:

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="sendcloud-labels-<timestamp>.pdf"
```

The admin UI can push this directly at `window.location` or write to a blob and use `URL.createObjectURL`.

### `400 Bad Request`

```json
{ "message": "medusa-sendcloud: <reason>" }
```

Fires when:

- `fulfillment_ids` is missing / empty / >20 / contains non-string entries
- `paper_size` is not `"a4"` or `"a6"`
- Some requested fulfillment IDs don't exist in Medusa
- Any fulfillment is missing `data.sendcloud_parcel_id` (e.g. non-SendCloud fulfillment)

The `message` lists the offending IDs when applicable.

### `502 Bad Gateway`

Upstream SendCloud call failed — bad credentials, network error, the fulfillment provider isn't registered, or SendCloud returned 4xx/5xx (`SendCloudClient` error-mapping propagates the detail).

## Upstream

`GET https://panel.sendcloud.sc/api/v3/parcel-documents/label` (operationId `sc-public-v3-scp-get-retrieve_parcel_documents_bulk`). Snapshot at `docs/openapi-snapshots/parcel-documents.yaml`.

- `parcels[]` query array — integer, min 1 / max 20 — serialized as repeated `?parcels=1&parcels=2&...`
- `paper_size` query — `a4 | a6`
- `Accept: application/pdf` header

## Scope

- **Hard cap 20 per request.** Medusa admin UIs that want to label more than 20 orders at once must paginate client-side. Server-side batching + ZIP merging is a future cycle.
- **Labels only.** `type=label` on the upstream path. Customs declarations (`customs-declaration`) and air waybills (`air-waybill`) share the endpoint shape but aren't exposed through this route yet.
- **PDF only.** ZPL + PNG formats are supported by SendCloud but not wired here; would require an `Accept`-mapped enum on the route.

## Implementation

- **`parseBulkLabelRequest`** (`helpers.ts`) — defensive body validator
- **`fetchSendcloudBulkLabels`** (`src/providers/sendcloud/bulk-labels.ts`) — resolves fulfillments, validates each has a parcel id, calls `requestBinary`
- **`SendCloudClient.requestBinary`** — mirrors `request()` with `arrayBuffer()` parsing and a configurable `Accept` header
- **`SendCloudClient` array query support** — `URLSearchParams.append` for each array entry → repeated `?k=v`

## Tests

`src/providers/sendcloud/__tests__/bulk-labels.unit.spec.ts` — 15 cases covering:

- `parseBulkLabelRequest` × 8: non-object / missing / empty / >20 / non-string entries / default paper_size / valid paper_size / invalid paper_size
- `fetchSendcloudBulkLabels` × 5: happy path (PDF streamed, repeated query params), unknown fulfillment id → 400, missing sendcloud_parcel_id → 400, provider not registered → 502, upstream 404 → 502
- `SendCloudClient.requestBinary` × 2: array query param serialization, 404 → NOT_FOUND mapping
