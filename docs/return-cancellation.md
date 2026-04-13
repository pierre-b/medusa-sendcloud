# Return cancellation (spec §7.4)

Cancel a SendCloud return that an admin (or a customer via storefront) created earlier. Replaces cycle 06's `NOT_ALLOWED` placeholder with a real call to `PATCH /api/v3/returns/{id}/cancel` followed by a `GET /api/v3/returns/{id}` to surface the upstream `parent_status`.

## Trigger

Admin uses Medusa's standard cancellation flow:

```
POST /admin/orders/:id/fulfillments/:fulfillment_id/cancel
```

Medusa core invokes our provider's `cancelFulfillment(data)`. The plugin detects the return shape (`sendcloud_return_id` present, `sendcloud_shipment_id` absent) and routes to `cancelReturn(client, returnId)`.

No new admin route. Outbound shipment cancellation (cycle 04) and return cancellation share the same Medusa entry point.

## Flow

```
cancelFulfillment(data)
  └─ data.sendcloud_return_id present, data.sendcloud_shipment_id absent
     → cancelReturn(client, returnId)
       1. validate returnId is a positive integer (else INVALID_DATA, no HTTP call)
       2. PATCH /api/v3/returns/{id}/cancel  (empty body)
            • 202 → continue
            • 404 → throw NOT_FOUND
            • 409 → throw NOT_ALLOWED carrying SendCloud's "Return is not cancellable" reason
            • 401/403/5xx → propagate from client
       3. GET /api/v3/returns/{id}  (best-effort)
            • 2xx → read parent_status
            • any failure → parent_status = null (logged inside the client; PATCH success still stands)
       4. return { sendcloud_return_cancellation: { message, parent_status, requested_at } }
```

The result is merged into `fulfillment.data` by Medusa core, so admins see the cancellation status alongside the original return data.

## Response shape

```ts
{
  sendcloud_return_cancellation: {
    message: string; // SendCloud's PATCH 202 message
    parent_status: string | null; // from the follow-up GET; null if GET failed
    requested_at: string; // ISO timestamp the plugin issued the request
  }
}
```

## SendCloud semantics (verified against `docs/openapi-snapshots/returns.yaml`)

- **PATCH** (not POST) — empty body, integer path param.
- Returns `202` even when the cancellation is just a **request** to the carrier. Some carriers don't support upstream label cancellation at all; for them, SendCloud queues the request and never confirms — the return ships anyway.
- `parent_status` enum (subset relevant to cancellation):
  - `cancelling-upstream` — request sent to carrier
  - `cancelling` — internal cancellation in progress
  - `cancelled` — confirmed cancelled
  - `cancelled-upstream` — carrier confirmed cancellation
- 409 means "not cancellable" — return already shipped, processed, or carrier rejection. Surfaces as `MedusaError.NOT_ALLOWED` with the upstream message embedded.

## Error mapping

| Upstream | Plugin error                       | Notes                                                         |
| -------- | ---------------------------------- | ------------------------------------------------------------- |
| 202      | (success)                          | message + parent_status returned                              |
| 404      | `NOT_FOUND`                        | "medusa-sendcloud: return {id} was not found"                 |
| 409      | `NOT_ALLOWED`                      | message embedded: "...rejected return cancellation: {reason}" |
| 401      | `UNAUTHORIZED` (passthrough)       | client-level mapping                                          |
| 403      | `FORBIDDEN` (passthrough)          | client-level mapping                                          |
| 5xx      | `UNEXPECTED_STATE` (after retries) | client-level mapping                                          |

## Tests

- `src/providers/sendcloud/__tests__/return-cancel.unit.spec.ts` — 6 cases (happy path, 404, 409 with reason, GET 5xx fallback, invalid returnId, PATCH path/method assertion)
- `src/providers/sendcloud/__tests__/service.unit.spec.ts` — 1 replaced case (cancelFulfillment routes return data to `cancelReturn`)

## Out of scope

- Polling `parent_status` until it hits `cancelled` / `cancelled-upstream` — admin sees the immediate value; subsequent webhooks update the return parcel's status.
- Multi-collo returns — no upstream multi-parcel return-cancel API.
- Order-detail widget surfacing the cancellation message — §15.2 will read this from `fulfillment.data` when it lands.
