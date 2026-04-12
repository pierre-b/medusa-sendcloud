# Variant Customs Resolution

Implements cycle 05. Bridges Medusa's module isolation to populate `hs_code`, `origin_country`, and per-item `weight` on `parcel_items[]` for `createFulfillment` (§3.6) and, later, `createReturnFulfillment` (§3.8).

## Why this exists

Medusa fulfillment providers can't resolve Query or cross-module services directly — module isolation is a first-class constraint (`/learn/fundamentals/modules/isolation`). `createFulfillment`'s signature gives us `FulfillmentItemDTO[]` (no variant) and `FulfillmentOrderDTO` (no expanded variant). Variant-level customs fields live on `ProductVariant` in the Product Module, reachable only through the Medusa container.

The plugin therefore runs a subscriber **at order.placed time** that uses Query to resolve the customs fields once and stores them on `order.metadata.sendcloud_variants`. The provider reads from this metadata at fulfillment time — no Query call needed in the provider path.

## Flow

```
customer places order
  → Medusa emits `order.placed`
  → subscribers/sendcloud-resolve-variants.ts fires
      → container.resolve(ContainerRegistrationKeys.QUERY)
      → query.graph({ entity: "order", filters: { id }, fields: ["id", "items.variant_id"] })
      → distinct variant_ids extracted via extractVariantIds()
      → query.graph({ entity: "product_variant", filters: { id: variantIds },
                      fields: ["id", "hs_code", "origin_country", "weight"] })
      → buildVariantsMap() skips entries whose customs are all null
      → enrichSendcloudVariantsWorkflow(container).run({ input: { orderId, variants } })
          → updateOrderMetadataStep resolves Modules.ORDER, merges
            metadata.sendcloud_variants = { [variantId]: { hs_code, origin_country, weight } }
  → (later) admin creates fulfillment
  → provider.createFulfillment reads readSendcloudVariantsFromOrder(order)
  → buildParcelItems merges customs fields into parcel_items[]
```

## Enriched `parcel_items[]` shape

When the order metadata has an entry for a line item's `variant_id`, `buildParcelItems` populates the optional SendCloud fields from the map:

```json
{
  "description": "Bar of Chocolate",
  "quantity": 2,
  "sku": "BAR-001",
  "item_id": "fitem_1",
  "price": { "value": "925", "currency": "EUR" },
  "hs_code": "180690",
  "origin_country": "FR",
  "weight": { "value": "0.090", "unit": "kg" }
}
```

Weight is stored on the variant in the unit matching the `weightUnit` plugin option (default `"g"`), and converted to kg at fulfillment time using `convertToKg` so SendCloud always receives `{ unit: "kg" }`.

## Plugin options honored

| Option                       | Role in this cycle                                         |
| ---------------------------- | ---------------------------------------------------------- |
| `weightUnit` (default `"g"`) | Converts `variant.weight` → kg for `parcel_items[].weight` |

No new plugin options.

## Graceful fallbacks

- Order has no `metadata` or `metadata.sendcloud_variants` → parcel_items carry description/quantity/sku/item_id/price only (same as cycle 04)
- A variant resolves with all-null customs fields → skipped entirely (no empty entry under metadata)
- Subscriber call fails (Query error, order module unavailable) → the subscriber swallows via its returning path; admin can retry or proceed without customs
- `data.variant_id` absent on a line item → that item ships without customs
- `weight` value ≤ 0 or non-numeric → omitted from SendCloud payload

## Admin-created / manual orders

Orders created directly via Medusa's admin (without going through the cart checkout that emits `order.placed`) will skip the subscriber. Their fulfillments will fall back to basics-only customs — same failure mode as cycle 04. Tracked in NOTES.md; a follow-up cycle can add a manual enrichment API endpoint or admin widget button.

## Race window

`order.placed` emits as part of the checkout completion. By the time an admin gets around to creating a fulfillment (minutes → days later), the subscriber has long since completed. The theoretical race where an admin creates a fulfillment during the subscriber's Query latency window is not coded around — the fallback (ship without customs) is tolerable.

## Tests

- `src/providers/sendcloud/__tests__/service.unit.spec.ts` — two new cases under `createFulfillment`:
  - Merges variant customs fields when `order.metadata.sendcloud_variants` is present
  - Falls back to basics when metadata is absent
- `src/subscribers/__tests__/sendcloud-resolve-variants.unit.spec.ts` — four cases with a mock container:
  - Resolves variants via Query, de-dupes variant_ids, invokes workflow
  - Short-circuits when order has no variant_ids
  - Skips workflow when all variants resolve only null customs
  - Returns without side effects when order itself is missing

## Files

| Path                                            | Role                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/subscribers/sendcloud-resolve-variants.ts` | `order.placed` handler; the `resolveSendcloudVariants(container, orderId)` core is separately exported for testability         |
| `src/workflows/enrich-sendcloud-variants.ts`    | One-step workflow that merges `sendcloud_variants` into `order.metadata` via `Modules.ORDER`                                   |
| `src/providers/sendcloud/helpers.ts`            | `extractVariantIds`, `buildVariantsMap`, `readSendcloudVariantsFromOrder`, extended `buildParcelItems` + `buildShipmentParcel` |
| `src/providers/sendcloud/service.ts`            | `createFulfillment` calls helpers with the metadata-read variantsMap                                                           |
