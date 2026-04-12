# Webhook Sync — `parcel_status_changed` + `refund_requested`

Implements spec §4. Closes the tracking loop: SendCloud pushes parcel-level events at `POST /webhooks/sendcloud`, the plugin verifies the HMAC, and updates the matching Medusa fulfillment.

## Endpoint

`POST https://{your-medusa-host}/webhooks/sendcloud`

Wire this URL in the SendCloud dashboard under Settings → Integrations → Webhooks. Paste the same `webhookSecret` on both sides.

The route sits behind the `preserveRawBody: true` middleware declared since cycle 01 so HMAC verification can hash the exact bytes SendCloud signed.

## HMAC verification

- **Header:** `Sendcloud-Signature` — lowercase hex, HMAC-SHA256 of the raw body with `webhookSecret` as key
- **Algorithm:** `crypto.createHmac("sha256", secret).update(rawBody).digest("hex")`
- **Comparison:** constant-time via `crypto.timingSafeEqual`; length- and charset-guarded to avoid throws on malformed input
- **Behaviour when `webhookSecret` is not configured:** endpoint returns **401** unconditionally. The plugin refuses to accept anonymous webhook traffic.

## Event handling

### `parcel_status_changed`

1. Extracts `payload.parcel.id`.
2. Queries recent fulfillments via `query.graph({ entity: "fulfillment", filters: { created_at: { $gte: since } } })` and filters in memory by `data.sendcloud_parcel_id === parcel.id`. The `since` lower-bound is `now - webhookLookbackDays * 24h`.
3. Compares `payload.timestamp` with the stored `fulfillment.data.status_updated_at`. If the incoming is stale, skips (SendCloud retries may arrive out of order).
4. Calls `updateFulfillmentWorkflow` with:
   ```ts
   {
     id: fulfillment.id,
     data: {
       status: parcel.status,
       status_updated_at: payload.timestamp,
       tracking_number: parcel.tracking_number,
       tracking_url: parcel.tracking_url,
     },
   }
   ```
5. **status.id === 11 (delivered):** sets `fulfillment.delivered_at = new Date()` on the same `updateFulfillmentWorkflow` call when the fulfillment isn't already marked delivered. Order-level delivered-state sync via `markOrderFulfillmentAsDeliveredWorkflow` is deferred — that workflow requires an `orderId` that `FulfillmentDTO` doesn't expose directly (tracked in NOTES.md).
6. **status.id === 80 (exception):** sets `fulfillment.metadata.sendcloud_exception = { timestamp, message }` in the same workflow call for admin visibility.

Other status ids persist as-is on `fulfillment.data.status`. No Medusa-side side effect.

### `refund_requested`

Same fulfillment-lookup path, then calls `updateFulfillmentWorkflow` to set `fulfillment.metadata.sendcloud_refund_requested = { timestamp, reason }`. Other metadata keys are preserved.

### Other events

`integration_connected`, `integration_deleted`, `integration_modified`, and any unknown `action` are logged at debug level and acknowledged with `200 OK`. SendCloud stops retrying once it sees the 2xx response.

## Plugin options

| Option                | Default           | Purpose                                      |
| --------------------- | ----------------- | -------------------------------------------- |
| `webhookSecret`       | _none (required)_ | HMAC secret shared with SendCloud            |
| `webhookLookbackDays` | `60`              | Upper bound for the fulfillment query window |

## Status codes

| HTTP  | When                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------ |
| `200` | Handled successfully (including no-match, stale-timestamp, unknown-action — all graceful no-ops) |
| `401` | `webhookSecret` not configured / signature header missing / signature verification failed        |
| `500` | Provider registration missing or workflow invocation threw (SendCloud will retry)                |

Graceful no-ops return `200` deliberately so SendCloud doesn't retry events we've intentionally ignored.

## Scale considerations

The `webhookLookbackDays` window bounds each webhook to a linear scan over fulfillments created in that window. For stores with thousands of fulfillments per month, this stays sub-millisecond at the Postgres level; the in-memory filter is a single `Array.find`. If volume becomes a concern, a future cycle can add a module link between `fulfillment` and `sendcloud_parcel_id` to bypass the scan.

## Tests

`src/providers/sendcloud/__tests__/webhook-handler.unit.spec.ts` — 16 cases covering:

- `verifySendcloudSignature` — valid, tampered body, wrong secret, non-hex input, length mismatch
- `processSendcloudWebhook` — missing secret → 401, missing signature header → 401, bad signature → 401
- `parcel_status_changed` — happy path (data merge), delivered workflow, delivered-skip when already delivered, exception metadata, stale-timestamp skip, no-match fallback
- `refund_requested` — metadata flag, preserves other metadata keys
- Unknown action → 200 no-op
