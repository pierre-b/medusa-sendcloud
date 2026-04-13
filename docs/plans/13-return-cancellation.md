# Plan 13 — Return cancellation (spec §7.4)

## Context

Cycle 06 (`createReturnFulfillment`) created the return-announce path but parked cancellation: `cancelFulfillment` detects return data (`sendcloud_return_id` present, `sendcloud_shipment_id` absent) and throws `NOT_ALLOWED` with an actionable placeholder. SendCloud exposes `PATCH /api/v3/returns/{id}/cancel` for this — note **PATCH** (not POST), per the v3 OpenAPI snapshot at `docs/openapi-snapshots/returns.yaml:481`.

This cycle replaces the placeholder with a real two-step call: PATCH the cancel request, then GET the return to surface `parent_status` immediately.

### User decisions

- **Routing:** extend `cancelFulfillment(data)` rather than adding a custom admin route. Admin uses Medusa's standard `POST /admin/orders/:id/fulfillments/:fid/cancel` flow — same UX as outbound shipment cancel, symmetric with how `createReturnFulfillment` hooks into Medusa's create.
- **Status read:** PATCH then immediately GET `/api/v3/returns/{id}` and persist `parent_status`. Two round-trips for immediate admin clarity (no need to wait for a webhook to confirm the cancellation landed). The GET is best-effort — if it fails, the PATCH success message still propagates.

### SendCloud semantics (verified against OpenAPI)

- **Endpoint:** `PATCH /api/v3/returns/{id}/cancel` — empty body, integer path param, Basic auth.
- **202** → `{ message: "Cancellation requested successfully" }`. Cancellation is a **request**; carriers may not all support upstream label cancellation. The actual outcome shows up later via `parent_status` on the return record.
- **404** → return id unknown.
- **409** → `{ errors: [{ field, code: 409, message: "Return is not cancellable." }] }` — return already shipped, processed, or carrier doesn't support cancellation.
- **`parent_status` enum** (returns.yaml:306): `cancelling-upstream`, `cancelling`, `cancelled`, `cancelled-upstream`. Also other lifecycle values for non-cancelled states.

---

## Implementation

### `cancelFulfillment(data)` extension

Current branch (cycle 06):

```ts
if (
  data.sendcloud_return_id !== undefined &&
  data.sendcloud_shipment_id === undefined
) {
  throw new MedusaError(NOT_ALLOWED, "...placeholder...");
}
```

Replace with real call:

```ts
if (
  data.sendcloud_return_id !== undefined &&
  data.sendcloud_shipment_id === undefined
) {
  return cancelReturn(this.client_, data.sendcloud_return_id);
}
```

New helper `cancelReturn(client, returnId)` in a new module `src/providers/sendcloud/return-cancel.ts`:

1. Validate `returnId` is a positive integer (else `INVALID_DATA`).
2. PATCH `/api/v3/returns/{id}/cancel` with empty body.
3. On 404 → `NOT_FOUND` with friendly message.
4. On 409 → `NOT_ALLOWED` with the upstream `errors[0].message` (so admin sees "Return is not cancellable").
5. On 2xx, capture `data.message` → `cancellationMessage`.
6. GET `/api/v3/returns/{id}` (best-effort — wrapped in try/catch, errors logged but not thrown).
7. Return:

```ts
{
  sendcloud_return_cancellation: {
    requested_at: ISO,
    message: cancellationMessage,
    parent_status: parentStatus ?? null,  // null if GET failed
  }
}
```

The shape matches the existing `sendcloud_cancellation` field for outbound shipments — symmetric naming.

### Client method support

`SendCloudClient.request<T>` already handles PATCH (line 30 of `sendcloud-client.ts`). No client changes needed. The empty-body PATCH must omit the `Content-Type: application/json` header? Let me check — current request() always sets `application/json` and serialises body, so empty body becomes `null` JSON. SendCloud's OpenAPI says `requestBody: { content: {} }` (empty content). We'll send no body (or `{}`) — verify in the unit test against `nock`.

### Error mapping

| Upstream | Plugin error type         | Surface message                                                                   |
| -------- | ------------------------- | --------------------------------------------------------------------------------- |
| 202      | (success)                 | `"Cancellation requested successfully"` (passthrough)                             |
| 404      | `NOT_FOUND`               | `"medusa-sendcloud: return {id} was not found"`                                   |
| 409      | `NOT_ALLOWED`             | `"medusa-sendcloud: SendCloud rejected return cancellation: {errors[0].message}"` |
| 401/403  | (existing client mapping) | `UNAUTHORIZED` / `FORBIDDEN` propagated                                           |
| 5xx      | (existing client mapping) | `UNEXPECTED_STATE` after retries                                                  |

---

## Tests

### `src/providers/sendcloud/__tests__/return-cancel.unit.spec.ts` — 6 cases

1. Happy path — PATCH returns 202 + `message`, GET returns `parent_status: "cancelling-upstream"` → returned object includes both message and parent_status.
2. 404 path — PATCH returns 404 → throws `NOT_FOUND` with friendly message.
3. 409 path — PATCH returns 409 with `errors[0].message: "Return is not cancellable."` → throws `NOT_ALLOWED` carrying that exact message.
4. GET failure tolerated — PATCH 202, GET 500 (after retries) → returns object with `message` populated and `parent_status: null` (the GET failure is logged, not surfaced).
5. Invalid return id — non-numeric `returnId` → throws `INVALID_DATA` without any HTTP call.
6. PATCH outbound URL + method — assert nock saw `PATCH /api/v3/returns/{id}/cancel` with empty body.

### `src/providers/sendcloud/__tests__/service.unit.spec.ts` — extend `cancelFulfillment` describe

1. Replace the existing "throws NOT_ALLOWED for return data" case with: "calls return-cancel and returns sendcloud_return_cancellation when data has only sendcloud_return_id".
2. Existing outbound shipment cancel cases stay unchanged.

Total: **154 + 7 = 161** unit tests post-cycle (1 todo).

---

## Critical files

| Path                                                           | Action                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/providers/sendcloud/return-cancel.ts`                     | create — `cancelReturn(client, id)` helper                                   |
| `src/providers/sendcloud/service.ts`                           | edit — wire helper into `cancelFulfillment` return branch                    |
| `src/providers/sendcloud/__tests__/return-cancel.unit.spec.ts` | create                                                                       |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts`       | edit — replace stubbed assertion, swap `it.todo` marker                      |
| `src/types/sendcloud-api.ts`                                   | edit — add `SendCloudReturnCancelResponse`, `SendCloudReturnDetailsResponse` |
| `docs/return-cancellation.md`                                  | create                                                                       |
| `docs/create-return-fulfillment.md`                            | edit — drop the "cancellation not yet implemented" blurb                     |
| `docs/README.md`                                               | index + roadmap update                                                       |
| `NOTES.md`                                                     | mark cycle-06 cancellation gap as resolved + new parked items                |

---

## Gate + push

1. `make check && npm run test:unit` — 154 → 161 passing, 1 todo
2. `npx medusa plugin:build` — green
3. Single commit: _"Implement return cancellation via PATCH /returns/:id/cancel"_
4. `git push origin main`

---

## Out of scope

- Polling `parent_status` until it reaches `cancelled` / `cancelled-upstream` — admin sees the immediate `parent_status` and can re-check via SendCloud dashboard or by re-fetching the fulfillment after the next webhook. A long-poll background job is overkill until a merchant asks.
- Multi-collo returns — spec §7 doesn't list multi-parcel returns, and `multi_collo_ids[]` from cycle 06 is informational only.
- Webhook handler extension for return-specific status events — cycle 07's `parcel_status_changed` already covers the return parcel via the same code path (return parcels surface as parcels in SendCloud's data model).
- `it.todo` next target: **customs validation warnings — §9.4 (admin-time HS code / origin_country / value sanity checks)**.
