# Plan 12 — Multi-collo (spec §8)

## Context

Large orders that ship in N boxes (e.g., chocolate hampers + bulk tins + gift crates) currently ship as a single SendCloud parcel with summed weight + cubed-root dimensions (cycle 04). For carriers that support multi-collo (DHL, PostNL, DPD), SendCloud can announce one **shipment** covering multiple **parcels**, each with its own tracking number, with the customer receiving one unified tracking email.

**Goal:** admin-controllable multi-parcel split, end-to-end — from create through webhook-driven status aggregation.

### User decisions

- **Trigger:** admin passes `metadata.sendcloud_parcels` on `POST /admin/orders/:id/fulfillments`. The 4th arg (`fulfillment`) in `createFulfillment` exposes `fulfillment.metadata.sendcloud_parcels`. No custom route, no workflow hook, no metadata race. Parcel breakdowns persist on the fulfillment record as audit history.
- **Endpoint:** keep cycle 04's `/api/v3/shipments/announce-with-shipping-rules` (sync, up to 15 parcels). Smallest diff from existing path.
- **Carrier pre-validation:** yes. Before announcing, query `/api/v3/shipping-options` with `{"functionalities":{"multicollo":true}}` and assert the chosen `shipping_option_code` is in the returned list. One extra round-trip in exchange for an admin-friendly error if the wrong carrier is picked.
- **Webhook aggregation:** yes. Cycle 07's handler walks `fulfillment.data.parcels[]`, updates the matching entry, recomputes `aggregate_status`, and sets `delivered_at` only when all parcels hit status 11 (Delivered).

### Scope constraints

- Admin UI widget for the parcel-split form is §15.3 — deferred.
- Return multi-collo stays parked (cycle 06 already persists `sendcloud_multi_collo_ids[]` for inspection; no split logic on returns yet).
- Customs per-parcel: each parcel re-uses the primary's customs info (all items listed on parcel 0). Per-parcel item distribution is §9 follow-up.

---

## Admin request shape

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

- `weight` is in the plugin's configured `weightUnit` (default `g`)
- `length` / `width` / `height` are centimetres (SendCloud's only dimension unit in v3)
- Array length ∈ [1, 15]; length 1 is equivalent to today's single-parcel behaviour

## `createFulfillment` flow change

```
createFulfillment(data, items, order, fulfillment)
  → parcelsHint = parseParcelsHint(fulfillment?.metadata?.sendcloud_parcels)
  → if parcelsHint?.length > 1:
      assertCarrierSupportsMulticollo(client, code)   // pre-validation round-trip
      parcels = [
        buildShipmentParcel(items, order, opts).withDims(parcelsHint[0]),
        ...parcelsHint.slice(1).map(h => buildParcelFromHint(h))   // bare weight+dims, no items
      ]
  → else: parcels = [buildShipmentParcel(...)]   // unchanged
  → POST /api/v3/shipments/announce-with-shipping-rules { parcels }
  → persist shipment + all parcels in fulfillment.data
```

### `parseParcelsHint`

New helper in `helpers.ts`:

```ts
type ParcelHint = { weight: number; length: number; width: number; height: number };

export const parseParcelsHint = (raw: unknown): ParcelHint[] | null
```

- `null` means "no hint, use single-parcel path"
- Throws `MedusaError.INVALID_DATA` on: non-array, zero length, >15 items, any entry with non-positive `weight`/`length`/`width`/`height`, non-numeric values

### `assertCarrierSupportsMulticollo`

New helper in a new `src/providers/sendcloud/multicollo.ts`:

```ts
export const assertCarrierSupportsMulticollo = async (
  client: SendCloudClient,
  shippingOptionCode: string
): Promise<void>
```

- Calls `POST /api/v3/shipping-options` with `{ functionalities: { multicollo: true } }`
- If `data[].code` doesn't include `shippingOptionCode` → throws `MedusaError.NOT_ALLOWED` with message `medusa-sendcloud: carrier <code> does not support multi-collo shipments`

## Data model change

Current `fulfillment.data` (cycle 04):

```ts
{
  (sendcloud_shipment_id,
    sendcloud_parcel_id,
    tracking_number,
    tracking_url,
    status,
    label_url,
    announced_at,
    applied_shipping_rules);
}
```

Post-cycle `fulfillment.data` keeps all those **plus**:

```ts
is_multicollo?: boolean              // only present when true
parcels?: Array<{                    // only present when is_multicollo
  sendcloud_parcel_id: number
  tracking_number: string
  tracking_url: string
  status: { id: number; message: string } | null
  label_url: string | null
}>
aggregate_status?:                   // only present when is_multicollo
  | "pending"
  | "partially_delivered"
  | "delivered"
  | "exception"
```

Back-compat: single-parcel fulfillments stay byte-for-byte identical to cycle 04 output — no consumer reads a field that disappeared.

`sendcloud_parcel_id` keeps pointing at the **primary** parcel (parcels[0]) so cycle 09 bulk-label, cycle 10 single-label, and cycle 07 webhook primary-parcel paths keep working for single-parcel fulfillments.

## Webhook aggregation (cycle 07 extension)

In `webhook-handler.ts`, `parcel_status_changed` currently resolves a fulfillment by `data.sendcloud_parcel_id` scalar. Extension:

1. New lookup step also checks `fulfillment.data.parcels[].sendcloud_parcel_id` for a match.
2. If the matching fulfillment is multi-collo, update the matching `parcels[i]` entry (tracking + status) instead of the root fields.
3. Recompute `aggregate_status`:
   - `exception` if any parcel has status.id ∈ {80, 1500, 1999} (exception set — same as cycle 07)
   - `delivered` if ALL parcels have status.id === 11
   - `partially_delivered` if SOME have status.id === 11 and the rest are in-transit
   - `pending` otherwise
4. Call `updateFulfillmentWorkflow({ delivered_at: new Date() })` **only** when `aggregate_status === "delivered"`.

Single-parcel fulfillments keep the cycle-07 root-field update path unchanged.

## Carrier pre-validation caching

`assertCarrierSupportsMulticollo` hits `/api/v3/shipping-options` on every multi-collo fulfillment. Not cached this cycle — each call is ~100ms and multi-collo fulfillments are infrequent. If it becomes a hot path, a request-scoped (or TTL 5min) cache of the compatible-carrier list is the next optimisation.

---

## Tests

### New unit spec `src/providers/sendcloud/__tests__/multicollo.unit.spec.ts` — 6 cases

1. `parseParcelsHint` — returns null for undefined/non-array/empty
2. `parseParcelsHint` — rejects >15 entries, non-positive dimensions, non-numeric values (INVALID_DATA)
3. `parseParcelsHint` — returns typed array for valid input
4. `assertCarrierSupportsMulticollo` — passes when carrier code is in the returned list
5. `assertCarrierSupportsMulticollo` — throws NOT_ALLOWED when carrier code is absent
6. `assertCarrierSupportsMulticollo` — propagates client errors (401 → stays UNAUTHORIZED)

### Extend `service.unit.spec.ts` — 4 new cases under `createFulfillment`

1. Hint with 2 entries → announces 2 parcels with exact dims/weight; payload.parcels[0] carries parcel_items, parcels[1] carries only dims+weight
2. Hint with 1 entry → **single-parcel path**, no multicollo pre-validation round-trip, identical to no-hint output (regression guard)
3. Hint + unsupported carrier → `assertCarrierSupportsMulticollo` throws NOT_ALLOWED, no announce call made
4. Hint present, SendCloud returns 3 parcels → `fulfillment.data.is_multicollo = true`, `parcels[]` length 3, `aggregate_status = "pending"`, `labels[]` has 3 entries

### Extend `webhook-handler.unit.spec.ts` — 3 new cases under `parcel_status_changed`

1. Multi-collo fulfillment, one parcel delivered → matching `parcels[i]` updated, `aggregate_status = "partially_delivered"`, NO `delivered_at`
2. Multi-collo fulfillment, all parcels delivered → `aggregate_status = "delivered"`, `delivered_at` set via `updateFulfillmentWorkflow`
3. Multi-collo fulfillment, one parcel status.id 80 (exception) → `aggregate_status = "exception"`, `metadata.sendcloud_exception` stored, no `delivered_at`

Total: 137 + 13 = 150 unit tests post-cycle.

---

## Critical files

| Path                                                             | Action                                             |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `src/providers/sendcloud/multicollo.ts`                          | create                                             |
| `src/providers/sendcloud/helpers.ts`                             | edit — add `parseParcelsHint` + per-parcel builder |
| `src/providers/sendcloud/service.ts`                             | edit — branch `createFulfillment` on parcelsHint   |
| `src/providers/sendcloud/webhook-handler.ts`                     | edit — multi-parcel lookup + aggregate_status      |
| `src/providers/sendcloud/__tests__/multicollo.unit.spec.ts`      | create                                             |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts`         | edit — +4 cases, swap todo marker                  |
| `src/providers/sendcloud/__tests__/webhook-handler.unit.spec.ts` | edit — +3 cases                                    |
| `docs/multi-collo.md`                                            | create                                             |
| `docs/README.md`                                                 | index + roadmap update                             |
| `NOTES.md`                                                       | parked items                                       |

---

## Gate + push

1. `make check && npm run test:unit` — 136 → 150 passing, 1 todo (next cycle)
2. `npx medusa plugin:build` — green
3. Single commit: _"Add multi-collo shipment support with webhook status aggregation"_
4. `git push origin main`

---

## Out of scope

- Admin UI parcel-split form (§15.3 — needs fulfillment creation widget first)
- Auto-split by carrier max weight (no per-carrier cap data persisted today)
- Multi-collo **returns** — inverse-announce doesn't support multiple parcels the same way; spec §7 doesn't list multi-collo returns explicitly
- Per-parcel customs / item distribution (spec §9 follow-up)
- Async `/api/v3/shipments` endpoint for >15 parcels (needs webhook-driven completion; defer until a merchant actually exceeds 15)
- Caching of multi-collo-capable carriers (hot-path-only optimisation)
- `it.todo` marker swap target: **return cancellation — §7 (PATCH /api/v3/returns/:id/cancel)**
