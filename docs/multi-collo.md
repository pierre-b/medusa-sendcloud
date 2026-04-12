# Multi-collo shipments (spec §8)

Admins can split a single fulfillment across up to 15 parcels — one shipment, multiple tracking numbers, one unified customer tracking email. Relevant carriers: DHL, PostNL, DPD in their multi-collo-capable service variants.

## Admin trigger

`POST /admin/orders/:id/fulfillments` accepts a `metadata` object, which the core workflow persists on the created fulfillment. SendCloud's provider reads `fulfillment.metadata.sendcloud_parcels` from the 4th arg of `createFulfillment`:

```
POST /admin/orders/:id/fulfillments
{
  "items": [...],
  "location_id": "sloc_...",
  "metadata": {
    "sendcloud_parcels": [
      { "weight": 1500, "length": 30, "width": 20, "height": 10 },
      { "weight":  900, "length": 20, "width": 15, "height":  8 }
    ]
  }
}
```

- `weight` uses the plugin's configured `weightUnit` (default `g`)
- `length` / `width` / `height` are centimetres (SendCloud's only dimension unit in v3)
- Array length ∈ [1, 15]; length 1 falls through to the single-parcel path

The parcel breakdown persists on the fulfillment record as audit history — useful when reconciling with carrier invoices.

## Flow

```
createFulfillment(data, items, order, fulfillment)
  └─ parseParcelsHint(fulfillment.metadata.sendcloud_parcels) → [hint0, hint1, ...]
       ├─ null / length 1 → existing single-parcel path (unchanged)
       └─ length > 1:
           1. assertCarrierSupportsMulticollo(client, shippingOptionCode)
              ↳ POST /api/v3/shipping-options { functionalities: { multicollo: true } }
              ↳ rejects with NOT_ALLOWED if code is missing from the response
           2. parcels = [primary (+items) with hint0 dims, barebones parcels from hint[1..N-1]]
           3. POST /api/v3/shipments/announce-with-shipping-rules { parcels }
           4. persist fulfillment.data.parcels[] + is_multicollo + aggregate_status='pending'
           5. return N labels (one per parcel)
```

Spec note: SendCloud shipping rules don't fully apply to multi-collo shipments (weight / parcel-dimensions / item-name / SKU / item-value rules are skipped). The rest of the ship-with-rules semantics still apply (`apply_shipping_rules: true` stays set).

## Data model

Single-parcel fulfillments (cycle 04) are byte-for-byte unchanged. Multi-collo fulfillments carry three extra fields:

```ts
fulfillment.data = {
  // existing cycle 04 shape
  sendcloud_shipment_id,
  sendcloud_parcel_id,
  tracking_number,
  tracking_url,
  status,
  label_url,
  announced_at,
  applied_shipping_rules,

  // multi-collo only
  is_multicollo: true,
  parcels: [
    { sendcloud_parcel_id, tracking_number, tracking_url, status, label_url },
  ],
  aggregate_status:
    "pending" | "partially_delivered" | "delivered" | "exception",
};
```

`sendcloud_parcel_id` keeps pointing at `parcels[0]` so cycle 09 bulk-label, cycle 10 single-label, and cycle 07 root-path webhook look-ups keep working when the fulfillment only has one parcel.

## Carrier pre-validation

`assertCarrierSupportsMulticollo` calls the v3 shipping-options endpoint with `{ functionalities: { multicollo: true } }` and checks the chosen shipping-option code is in the returned list. Every multi-collo announcement pays one extra round-trip; single-parcel fulfillments skip the check. No client-side cache this cycle — add a request-scoped TTL cache if it becomes a hot path.

## Webhook aggregation (cycle 07 extension)

`parcel_status_changed` now:

1. Looks up fulfillments by `data.sendcloud_parcel_id` **or** any `data.parcels[].sendcloud_parcel_id` — both single and multi hits are resolved.
2. When the match is multi-collo: updates the matching parcel entry in `parcels[]`, recomputes `aggregate_status`, and writes both back.
3. Aggregate rules:
   - `exception` — any parcel has `status.id ∈ { 80 }` (same exception id set as cycle 07)
   - `delivered` — **all** parcels have `status.id === 11`
   - `partially_delivered` — at least one parcel is delivered, not all
   - `pending` — otherwise
4. `delivered_at` is set **only** when `aggregate_status === "delivered"`. Single-parcel fulfillments keep the cycle-07 single-status-id-11 rule.

`refund_requested` uses the same multi-parcel lookup; behaviour is unchanged (metadata stamp only).

## Tests

- `src/providers/sendcloud/__tests__/multicollo.unit.spec.ts` — 7 cases covering `parseParcelsHint` (5) + `assertCarrierSupportsMulticollo` (2 happy/not-allowed + 1 auth propagation = 3)
- `src/providers/sendcloud/__tests__/service.unit.spec.ts` — 4 multi-collo cases under `createFulfillment` (2-parcel dims, single-entry fallthrough, NOT_ALLOWED carrier, 3-parcel data + labels)
- `src/providers/sendcloud/__tests__/webhook-handler.unit.spec.ts` — 3 multi-collo cases (partial delivery, all-delivered → delivered_at, one-exception aggregate)

150 unit tests green (1 `it.todo` pointing at return cancellation — §7).

## Relationship to other cycles

- Cycle 04 — single-parcel `createFulfillment` / `cancelFulfillment`: unchanged, inherits the same `announce-with-shipping-rules` path.
- Cycle 07 — webhook parcel_status_changed: extended for multi-parcel lookup + aggregate_status.
- Cycle 09 / 10 — bulk and single label download: work with the primary `sendcloud_parcel_id`. For multi-collo, secondary parcels' labels are accessible via the `parcels[]` array on the fulfillment record.

## Out of scope

- Admin UI parcel-split form — §15.3 (fulfillment widget cycle)
- Auto-split by carrier max weight — needs per-carrier cap data we don't persist
- Multi-collo **returns** — spec §7 doesn't list multi-collo returns, and returns-announce doesn't accept a multi-parcel payload the same way
- Per-parcel customs / item distribution — spec §9 follow-up
- `/api/v3/shipments` async endpoint for >15 parcels — needs webhook-driven completion; defer until a merchant actually exceeds 15
- Client-side cache of multi-collo-capable carriers — hot-path-only optimisation
