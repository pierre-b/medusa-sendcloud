# Cancel Fulfillment — `cancelFulfillment`

Implements spec §3.7. Fires when the fulfillment is cancelled — either via Medusa admin action, or as workflow compensation when a later step in a fulfillment-creation saga fails.

## Flow

```
Fulfillment cancel trigger (admin UI or workflow compensation)
  → Medusa calls provider.cancelFulfillment(fulfillment.data)
  → plugin extracts data.sendcloud_shipment_id and POSTs
    /api/v3/shipments/{shipment_id}/cancel (no body)
  → SendCloud returns 200 (cancelled) or 202 (queued)
  → plugin returns { sendcloud_cancellation: { status, message } }
  → Medusa merges the returned object onto fulfillment.data for audit
```

## SendCloud endpoint

`POST https://panel.sendcloud.sc/api/v3/shipments/{shipment_id}/cancel`

No request body. Response branches:

| Status | Meaning                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | Cancelled immediately — `{ data: { status: "cancelled", message } }`                                                                       |
| `202`  | Queued — shipment is in `READY_TO_SEND`; SendCloud watches for 14 days and cancels if unchanged. `{ data: { status: "queued", message } }` |
| `409`  | Already cancelled, delivered, or >42 days old — surfaced as `MedusaError.Types.CONFLICT` via the client's status mapping                   |

Both `200` and `202` are success paths. The admin sees the status surface on `fulfillment.data.sendcloud_cancellation` and can follow up if `queued`.

## Returned shape

```ts
{
  sendcloud_cancellation: {
    status: "cancelled" | "queued",
    message: string,
  }
}
```

Medusa merges this with `fulfillment.data`; other keys set by `createFulfillment` (`sendcloud_shipment_id`, tracking info) stay intact.

## Error handling

| Condition                                         | Error                                              |
| ------------------------------------------------- | -------------------------------------------------- |
| `data.sendcloud_shipment_id` missing / non-string | `INVALID_DATA`                                     |
| `409` from SendCloud                              | `CONFLICT` (existing client mapping)               |
| Other 4xx / 5xx                                   | Mapped per `SendCloudClient.request`               |
| Network errors                                    | Retried up to `maxRetries` then `UNEXPECTED_STATE` |

## Tests

`src/providers/sendcloud/__tests__/service.unit.spec.ts` → `describe("cancelFulfillment")` — 4 cases: 200 cancelled, 202 queued, 409 conflict, missing shipment id.
