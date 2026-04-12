# Plan 10 — Per-fulfillment label shortcut (spec §6.2)

## Context

Single-order admin UX. Cycle 09 ships the bulk route for warehouse pick-and-pack; this cycle fills in the more common shortcut — an admin viewing one order clicks "Print label" and gets the PDF directly. Spec §6.2.

**Goal:** `GET /admin/sendcloud/labels/{fulfillment_id}?paper_size=a6&dpi=72` — resolves one fulfillment, calls SendCloud's single-parcel endpoint, streams the PDF back.

**Why now:** the `it.todo("per-fulfillment label download shortcut — §6.2")` marker is outstanding. Small, high-value: 80% of admin label interactions are single-order, not bulk. Reuses cycle 09's `requestBinary` and 502-wrap pattern — minimal new surface.

### Scope constraints

- **GET only.** Label is idempotent; query-string params, no body.
- **Hardcoded `type=label`** on the upstream — customs declarations / air waybills stay deferred (same decision as cycle 09).
- **PDF only.** `Accept: application/pdf`. ZPL/PNG deferred.
- **Single parcel per request.** Fulfillments with multi-collo parcels (spec §8) aren't emitted today; a later multi-collo cycle can return multiple labels.

---

## External API verification (same snapshot as cycle 09)

`GET /api/v3/parcels/{id}/documents/{type}` — operationId `sc-public-v3-scp-get-retrieve_parcel_documents`. Per `docs/openapi-snapshots/parcel-documents.yaml`:

- `id` path param — integer, ≥1
- `type` path param — enum `label | customs-declaration | air-waybill` (we hardcode `label`)
- `paper_size` query — `a4 | a6`
- `dpi` query — integer enum `72 | 150 | 203 | 300 | 600` (default 72 for PDF)
- `Accept` header — picks response format

Responses:

- `200`: binary (matches Accept)
- `404`: `{ errors: [{ code: "not_found", ... }] }`

---

## Behaviour spec

### `GET /admin/sendcloud/labels/{fulfillment_id}?paper_size=a6&dpi=72`

1. `parseLabelQuery(raw)` — validates `paper_size` and `dpi` (both optional):
   - `paper_size`: `"a4" | "a6"` or absent → default `"a6"`
   - `dpi`: one of `72 | 150 | 203 | 300 | 600` or absent → defaults to SendCloud's default (72 for PDF)
   - Invalid → `400 { message }`
2. `fetchSendcloudLabel(container, providerKey, { fulfillmentId, paperSize, dpi })`:
   - Resolve the fulfillment provider (borrow client) — reuse cycle-09 pattern
   - Query.graph for the one fulfillment
   - Not found → `404 { message: "medusa-sendcloud: unknown fulfillment <id>" }`
   - Missing `sendcloud_parcel_id` → `400 { message: "medusa-sendcloud: fulfillment <id> has no sendcloud_parcel_id" }`
   - `client.requestBinary({ method: "GET", path: \`/api/v3/parcels/${parcel_id}/documents/label\`, query: { paper_size, dpi }, accept: "application/pdf" })`
   - Upstream errors → 502
3. Route streams PDF back with `Content-Disposition: attachment; filename="sendcloud-label-<ISO-date>-<parcel_id>.pdf"`

### `parseLabelQuery(raw)`

Pure helper:

```ts
type LabelQuery = { paperSize: "a4" | "a6"; dpi?: number };
type ParsedLabelQuery =
  | { ok: true; value: LabelQuery }
  | { ok: false; error: string };
```

### Refactor: extract `buildProviderRegistrationKey` to a shared module

`buildProviderRegistrationKey` is now imported from `service-points.ts` by 3 callers (webhook route, service-points route, bulk-labels route) and would become the 4th on this cycle. Move to `src/providers/sendcloud/registration.ts` with a single export — keeps the service-points module cohesive and makes the key's origin obvious.

---

## TDD sequence

Unit-test the handler + query parser with `nock`, same shape as cycle 09. Tests:

1. `parseLabelQuery` — invalid `paper_size` → 400
2. `parseLabelQuery` — invalid `dpi` → 400
3. `parseLabelQuery` — defaults `paper_size` to `"a6"`, leaves `dpi` undefined
4. `parseLabelQuery` — accepts valid combinations
5. `fetchSendcloudLabel` — happy path: streams PDF, asserts URL is `/api/v3/parcels/{id}/documents/label`
6. `fetchSendcloudLabel` — fulfillment unknown → 404
7. `fetchSendcloudLabel` — missing `sendcloud_parcel_id` → 400
8. `fetchSendcloudLabel` — provider not registered → 502
9. `fetchSendcloudLabel` — Query.graph throws → 502
10. `fetchSendcloudLabel` — upstream 404 → 502

---

## Files

| Path                                                               | Action                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `src/providers/sendcloud/registration.ts`                          | create — `buildProviderRegistrationKey` moved here                              |
| `src/providers/sendcloud/service-points.ts`                        | drop the exported helper; import from `./registration`                          |
| `src/providers/sendcloud/bulk-labels.ts`                           | (no behaviour change — indirect via the registration import shift)              |
| `src/api/webhooks/sendcloud/route.ts`                              | adjust import if needed (still uses inline `fp_..._...` or drops to the helper) |
| `src/api/store/sendcloud/service-points/route.ts`                  | adjust import                                                                   |
| `src/api/admin/sendcloud/labels/bulk/route.ts`                     | adjust import                                                                   |
| `src/providers/sendcloud/fulfillment-label.ts`                     | create — exports `fetchSendcloudLabel`                                          |
| `src/providers/sendcloud/helpers.ts`                               | add `parseLabelQuery`                                                           |
| `src/api/admin/sendcloud/labels/[fulfillment_id]/route.ts`         | create                                                                          |
| `src/providers/sendcloud/__tests__/fulfillment-label.unit.spec.ts` | create                                                                          |
| `docs/single-label-download.md`                                    | create                                                                          |
| `docs/README.md`                                                   | index                                                                           |
| `NOTES.md`                                                         | mark buildProviderRegistrationKey parked-item resolved                          |

---

## Gate + push

1. `make check && npm run test:unit` — existing 120 + ~10 new green, 1 todo
2. `npx medusa plugin:build` clean
3. Single commit: _"Add per-fulfillment label download shortcut"_
4. `git push origin main`

---

## Out of scope

- Multi-collo single-fulfillment emission (multiple parcels per fulfillment → ZIP or merged PDF)
- Customs / air-waybill single-doc shortcut
- ZPL / PNG format selection
- Admin settings widget (§15.1)
