# Create Return Fulfillment — `createReturnFulfillment`

Implements spec §3.8. Fires when a Medusa customer initiates a return and the fulfillment module asks our provider to produce a return label.

## Flow

```
Customer requests return on the storefront (or admin creates claim/exchange)
  → Medusa core-flow createReturnFulfillmentWorkflow runs
  → provider.createReturnFulfillment(fulfillment) invoked
  → plugin inverts the address orientation:
      from_address = fulfillment.delivery_address  (customer)
      to_address   = fulfillment.location.address  (warehouse)
  → POSTs /api/v3/returns/announce-synchronously with shipping_option.code,
    parcel_items[], order_number, customs_invoice_nr, send_tracking_emails
  → SendCloud returns { return_id, parcel_id, multi_collo_ids }
  → plugin constructs label_url = ${baseUrl}/api/v3/parcels/{parcel_id}/documents/label
  → plugin returns { data, labels } — Medusa persists on the return fulfillment
```

## SendCloud endpoint

`POST https://panel.sendcloud.sc/api/v3/returns/announce-synchronously`

Sync. SendCloud flags sync as "for debugging" due to carrier round-trip latency, but for our single-parcel foundation volume it's the simplest contract — we need the `parcel_id` immediately to build the label URL.

## Input expectations

The provider's `fulfillment` parameter is a `CreateFulfillmentDTO`-shaped blob supplied by Medusa's core-flow `createReturnFulfillmentWorkflow`. We read:

| Path                              | Role                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fulfillment.data.sendcloud_code` | required — the shipping option code (same key as outbound)                                                                                            |
| `fulfillment.delivery_address`    | customer address → becomes SendCloud `from_address`                                                                                                   |
| `fulfillment.location.address`    | warehouse / stock location address → becomes SendCloud `to_address`                                                                                   |
| `fulfillment.items`               | return items → `parcel_items[]` via `buildParcelItems`                                                                                                |
| `fulfillment.order`               | optional partial `OrderDTO` — used for `display_id`, `currency_code`, `items[].unit_price`, and `metadata.sendcloud_variants` (cycle-05 customs path) |

### Address mapping

Same logic as outbound (`buildToAddress`) — see `docs/create-fulfillment.md`. `name` derived from `first_name + last_name`; required fields `address_line_1`, `postal_code`, `city`, `country_code`.

## Response mapping

SendCloud returns `201` with only three fields: `{ return_id, parcel_id, multi_collo_ids }` — no tracking number or label URL. We construct the label URL from the documented parcel-document pattern.

| Returned path                    | Source                                                   |
| -------------------------------- | -------------------------------------------------------- |
| `data.sendcloud_return_id`       | `response.return_id`                                     |
| `data.sendcloud_parcel_id`       | `response.parcel_id`                                     |
| `data.sendcloud_multi_collo_ids` | `response.multi_collo_ids ?? []`                         |
| `data.label_url`                 | `${baseUrl}/api/v3/parcels/${parcel_id}/documents/label` |
| `data.tracking_number`           | `null` — lands via webhook (spec §4, future cycle)       |
| `data.tracking_url`              | `null` — same                                            |
| `data.status`                    | `null` — same                                            |
| `labels[0]`                      | `{ tracking_number: "", tracking_url: "", label_url }`   |

`tracking_number` and `tracking_url` are empty strings in the `labels[0]` entry because Medusa's `FulfillmentLabel` schema types them as required strings. The real values arrive via the `parcel_status_changed` webhook in the next cycle.

## Customs (international non-EU returns)

If `fulfillment.order.metadata.sendcloud_variants` is populated (cycle-05 subscriber ran on the original `order.placed`), `parcel_items[]` carry `hs_code`, `origin_country`, and per-item weight. This means international returns work end-to-end for orders that went through the normal customer checkout. Admin-created manual orders still hit the cycle-05 gap — documented in NOTES.md.

## Plugin options honored

| Option       | Role                                                          |
| ------------ | ------------------------------------------------------------- |
| `weightUnit` | Converts `variant.weight` to kg for `parcel_items[].weight`   |
| `brandId`    | Forwarded as `brand_id` on the return payload when configured |

## Errors

| Condition                                            | Error                                |
| ---------------------------------------------------- | ------------------------------------ |
| `fulfillment.data.sendcloud_code` missing/whitespace | `INVALID_DATA`                       |
| `fulfillment.delivery_address` missing/invalid       | `INVALID_DATA` via `buildToAddress`  |
| `fulfillment.location.address` missing/invalid       | `INVALID_DATA` via `buildToAddress`  |
| SendCloud returns no `return_id` or `parcel_id`      | `UNEXPECTED_STATE`                   |
| Any HTTP error                                       | Mapped per `SendCloudClient.request` |

## Scope this cycle

- **Single parcel.** If SendCloud returns a non-empty `multi_collo_ids`, we persist it on `fulfillment.data.sendcloud_multi_collo_ids` but only emit one `labels[0]` entry. Multi-collo returns (spec §8) stay a dedicated cycle.
- **No async creation.** The `/api/v3/returns` (async) endpoint isn't used.
- **Return cancellation:** implemented in cycle 13 via `PATCH /api/v3/returns/{id}/cancel`. See [return-cancellation.md](./return-cancellation.md). `cancelFulfillment` routes return data (`sendcloud_return_id` present, `sendcloud_shipment_id` absent) to the new helper.
- **`send_tracking_emails` is hardcoded to `true`.** No plugin option to opt out yet. B2B stores that prefer their own tracking notifications will need a future `sendTrackingEmails` option (parked in NOTES.md).
- **No return portal.** Spec §7.1 approach A (SendCloud-hosted) is a separate integration surface.
- **No rule-based label sizes or format.** Label is always fetched as A6 PDF at the default URL.

## Tests

`src/providers/sendcloud/__tests__/service.unit.spec.ts` → `describe("createReturnFulfillment")` — 7 cases:

- Happy path (inverted addresses, shipping_option.code, order_number, customs_invoice_nr, send_tracking_emails, response mapping, label URL)
- Variant customs merge via `order.metadata.sendcloud_variants`
- `brandId` plugin option → `brand_id`
- `INVALID_DATA` for missing `sendcloud_code`
- `INVALID_DATA` for missing `delivery_address`
- `INVALID_DATA` for missing `location.address`
- `UNEXPECTED_STATE` for missing `return_id` in response
