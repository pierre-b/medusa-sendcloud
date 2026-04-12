# Plan 09 — Bulk label download (spec §6.3)

## Context

Warehouse pick-and-pack flow. An admin selects multiple orders in the Medusa dashboard and needs a single PDF covering every fulfillment's shipping label at once — instead of clicking through each label one-by-one. Spec §6.3.

**Goal:** `POST /admin/sendcloud/labels/bulk` — accepts an array of Medusa fulfillment IDs, resolves each to its `sendcloud_parcel_id`, asks SendCloud for the merged bulk-label document, streams the binary PDF back to the admin.

**Why now:** first warehouse-facing UX cycle. The `it.todo("bulk label download — §6.3")` marker is outstanding. Unblocks a real operational pain point for multi-order shipping days.

### Scope constraints

- **Hard cap of 20 fulfillments per request.** SendCloud's bulk endpoint caps at 20; the plugin rejects >20 with a clear 400 so callers paginate client-side. A future cycle can add server-side batching + ZIP merging if a real workflow needs it.
- **Labels only.** `type=label` on `/api/v3/parcel-documents/{type}`. Customs declarations and air waybills stay deferred — same endpoint shape but separate UX / paths.
- **PDF only.** `Accept: application/pdf` hardcoded. ZPL and PNG formats deferred.
- **Admin route only.** No storefront surface (labels belong to fulfilment ops).

---

## External API verification (`docs/openapi-snapshots/parcel-documents.yaml`)

`GET /api/v3/parcel-documents/{type}` — operationId `sc-public-v3-scp-get-retrieve_parcel_documents_bulk`.

**Parameters:**

- `type` path enum: `label | customs-declaration | air-waybill` — we always send `label`
- `parcels` query array of integers, `minItems: 1`, `maxItems: 20`, required
- `paper_size` query — `a4 | a6` (verified in the spec)
- `Accept` header — `application/pdf | application/zpl | image/png`, default `application/pdf`

**Responses:**

- `200`: binary body (matches the `Accept` header content-type)
- `400`: `{ errors: [...] }` — invalid type, etc.
- `404`: `{ errors: [{ code: "not_found", detail: "No Parcel matches..." }] }`

Query-array serialization: OpenAPI v3 default is `style: form, explode: true` → `?parcels=1&parcels=2&parcels=3`. The plugin spec doc written earlier described `?parcels=1,2,3` but the OpenAPI operation declares `type: array` with no explicit `style`, which means explode-true (repeat). We'll serialize as repeated query params via `URLSearchParams.append`.

---

## Plugin options

None new. Reuses credentials + retry logic already on the client.

---

## Behaviour spec

### `POST /admin/sendcloud/labels/bulk`

**Request body:**

```ts
{
  fulfillment_ids: string[]      // 1..=20 Medusa fulfillment IDs
  paper_size?: "a4" | "a6"       // defaults to "a6"
}
```

**Flow:**

1. Validate body via `parseBulkLabelRequest(raw)`:
   - `fulfillment_ids` required, must be an array of 1..20 non-empty strings
   - `paper_size` optional, must be `"a4"` or `"a6"` when present
   - Other keys ignored
   - Bad inputs → `400 { message }`
2. Resolve fulfillments via `query.graph({ entity: "fulfillment", filters: { id: fulfillment_ids }, fields: ["id", "data"] })`.
3. Map `id → data.sendcloud_parcel_id`. If any are missing the parcel id (e.g. manual non-SendCloud fulfillments), return `400 { message: "medusa-sendcloud: fulfillments are missing SendCloud parcel ids: [...]" }` listing the offenders.
4. Call the client's new `requestBinary` helper against `/api/v3/parcel-documents/label?parcels=1&parcels=2&...&paper_size=a6`.
5. Stream the binary back to the admin: `res.status(200).set("content-type", contentType).set("content-disposition", \`attachment; filename="sendcloud-labels-${timestamp}.pdf"\`).end(body)`.
6. Upstream failures wrap as `502 { message }`, same pattern as cycle 08.

### `parseBulkLabelRequest(body: unknown)`

Pure helper in `helpers.ts`:

```ts
type ParsedBulkLabelRequest =
  | { ok: true; value: { fulfillmentIds: string[]; paperSize: "a4" | "a6" } }
  | { ok: false; error: string };
```

Validation is defensive — anything that isn't a real body produces a clear error.

### `fetchSendcloudBulkLabels(container, providerRegistrationKey, input)`

New module `src/providers/sendcloud/bulk-labels.ts`. Shape:

```ts
type BulkLabelsResult =
  | { status: 200; body: Buffer; contentType: string }
  | { status: 400 | 502; body: { message: string } };

export async function fetchSendcloudBulkLabels(
  container: MedusaContainer,
  providerRegistrationKey: string,
  input: { fulfillmentIds: string[]; paperSize: "a4" | "a6" }
): Promise<BulkLabelsResult>;
```

Internally:

1. Resolve provider by key (borrow the `SendCloudClient` — cycle-07 pattern)
2. Run `query.graph` for the fulfillments
3. Validate every ID resolves + has a numeric `sendcloud_parcel_id`
4. Call `client.requestBinary({ method: "GET", path: "/api/v3/parcel-documents/label", query: { parcels: [id1,id2,...], paper_size: "a6" }, accept: "application/pdf" })`
5. Return `{ status: 200, body, contentType }`

### `SendCloudClient` extensions

Two small, non-breaking changes:

1. `SendCloudRequestInit.query` now accepts **array** values. `buildUrl` uses `url.searchParams.append(k, v)` for each item rather than `set`. Existing scalar callers keep working.
2. New public method `requestBinary<T = Buffer>({...})` — same retry + error-mapping as `request`, but returns `{ body: Buffer, contentType: string }` instead of JSON. Internals:
   - Build URL + headers as today
   - Override `accept` header from `init.accept` (default `application/pdf`)
   - On 2xx: `const arrayBuffer = await response.arrayBuffer()`; return `{ body: Buffer.from(arrayBuffer), contentType: response.headers.get("content-type") ?? "application/octet-stream" }`
   - On 4xx/5xx: parse error body the same way as `request` (text → JSON if possible), throw `MedusaError` with correct type

Shared retry/backoff + error mapping lives in a private `executeWithRetries(build, parse)` — refactor `request` to use it, then implement `requestBinary` on top. Optional — if the refactor is noisy, duplicate the loop for this cycle and DRY in cycle 10.

---

## Route — `src/api/admin/sendcloud/labels/bulk/route.ts`

```ts
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = parseBulkLabelRequest(req.body);
  if (!parsed.ok) return res.status(400).json({ message: parsed.error });

  const result = await fetchSendcloudBulkLabels(
    req.scope,
    PROVIDER_KEY,
    parsed.value
  );
  if (result.status !== 200) {
    return res.status(result.status).json(result.body);
  }

  const filename = `sendcloud-labels-${Date.now()}.pdf`;
  res
    .status(200)
    .set("content-type", result.contentType)
    .set("content-disposition", `attachment; filename="${filename}"`)
    .end(result.body);
};
```

`/admin/*` routes are session-auth-protected by Medusa. No extra middleware needed.

---

## TDD sequence

### Red

`src/providers/sendcloud/__tests__/bulk-labels.unit.spec.ts` — 11 cases:

1. `parseBulkLabelRequest` — non-object body → 400
2. `parseBulkLabelRequest` — missing `fulfillment_ids` → 400
3. `parseBulkLabelRequest` — empty array → 400
4. `parseBulkLabelRequest` — >20 IDs → 400
5. `parseBulkLabelRequest` — accepts valid input; defaults `paper_size` to `"a6"`
6. `parseBulkLabelRequest` — rejects invalid `paper_size`
7. `fetchSendcloudBulkLabels` — happy path: mocks query.graph, asserts outbound query has `parcels=X&parcels=Y&paper_size=a6`, returns PDF buffer + content-type
8. `fetchSendcloudBulkLabels` — missing parcel IDs on some fulfillments → 400 listing offenders
9. `fetchSendcloudBulkLabels` — not every requested ID resolved in the query → 400
10. `fetchSendcloudBulkLabels` — provider not registered → 502
11. `fetchSendcloudBulkLabels` — upstream 404 → 502 with message

Plus `sendcloud-client.request.unit.spec.ts` extensions (3 cases):

- Array query values produce repeated `?k=v` pairs
- `requestBinary` returns `{ body, contentType }` on 200 PDF
- `requestBinary` maps 404 to `MedusaError.NOT_FOUND`

### Green

1. Extend `SendCloudClient.buildUrl` + `SendCloudRequestInit.query` for array values
2. Add `SendCloudClient.requestBinary` (refactor shared retry or duplicate)
3. `parseBulkLabelRequest` in `helpers.ts`
4. `src/providers/sendcloud/bulk-labels.ts` with `fetchSendcloudBulkLabels`
5. `src/api/admin/sendcloud/labels/bulk/route.ts`
6. Tests pass

---

## Docs

- **`docs/bulk-labels.md`** — endpoint, request/response, limits, error matrix
- **`docs/README.md`** — feature index, snapshot index (`parcel-documents.yaml`)
- **NOTES.md** — park: ZPL/PNG format support; `customs-declaration` / `air-waybill` bulk; >20 batching with server-side ZIP merge; per-fulfillment label download (single-parcel shortcut route)
- Replace `it.todo` with `it.todo("admin settings widget — §15.1")` or similar next-cycle handoff

---

## Critical files to be created or modified

| Path                                                           | Action                                          |
| -------------------------------------------------------------- | ----------------------------------------------- |
| `docs/openapi-snapshots/parcel-documents.yaml`                 | commit snapshot (already downloaded)            |
| `src/services/sendcloud-client.ts`                             | array-query support; `requestBinary` method     |
| `src/providers/sendcloud/helpers.ts`                           | `parseBulkLabelRequest`                         |
| `src/providers/sendcloud/bulk-labels.ts`                       | create — exports `fetchSendcloudBulkLabels`     |
| `src/api/admin/sendcloud/labels/bulk/route.ts`                 | create                                          |
| `src/providers/sendcloud/__tests__/bulk-labels.unit.spec.ts`   | create                                          |
| `src/services/__tests__/sendcloud-client.request.unit.spec.ts` | extend with `requestBinary` + array query cases |
| `docs/bulk-labels.md`                                          | create                                          |
| `docs/README.md`                                               | indices                                         |
| `NOTES.md`                                                     | parked items                                    |

---

## Gate + push

1. `make check && npm run test:unit` — existing 104 + ~14 new green, 1 todo
2. `npx medusa plugin:build` clean
3. Single commit: _"Bulk-download up to 20 SendCloud shipping labels as a single PDF"_
4. `git push origin main`

---

## Out of scope (next plans)

- > 20-fulfillment batching with ZIP merge
- ZPL / PNG format selection
- Customs / air-waybill bulk downloads
- Single-label admin shortcut (`GET /admin/sendcloud/labels/{fulfillment_id}`)
- Admin settings widget (§15.1)
