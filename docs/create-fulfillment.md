# Create Fulfillment — `createFulfillment`

Implements spec §3.6. Fires when a Medusa admin marks items for shipping on an order.

## Flow

```
Admin clicks "Create fulfillment" on an order
  → Medusa fulfillment workflow calls provider.createFulfillment(data, items, order, fulfillment)
  → plugin builds a SendCloud shipment payload and POSTs /api/v3/shipments/announce-with-shipping-rules
  → SendCloud creates the shipment, announces it, produces a label URL
  → plugin returns { data, labels } which Medusa persists on the fulfillment
```

## SendCloud endpoint

`POST https://panel.sendcloud.sc/api/v3/shipments/announce-with-shipping-rules`

Sync. Max 15 parcels. Applies SendCloud's shipping rules and defaults (both default `true`). The operation id is `sc-public-v3-scp-post-announce_shipment_with_rules`.

## Request payload

Only `to_address` is strictly required when rules/defaults are enabled — the plugin sends more because it has the data in hand.

| Field                                       | Source                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `to_address`                                | `fulfillment.delivery_address ?? order.shipping_address` mapped via `buildToAddress`                  |
| `ship_with.type`                            | `"shipping_option_code"` (literal)                                                                    |
| `ship_with.properties.shipping_option_code` | `data.sendcloud_code` (from `validateFulfillmentData`)                                                |
| `apply_shipping_rules`                      | `true`                                                                                                |
| `apply_shipping_defaults`                   | `true`                                                                                                |
| `order_number`                              | `order.display_id ?? order.id`                                                                        |
| `external_reference_id`                     | `fulfillment.id`                                                                                      |
| `parcels[0].parcel_items[]`                 | one entry per fulfillment item (`description`, `quantity`, `sku`, `item_id`, `price` when resolvable) |
| `parcels[0].additional_insured_price`       | `{ value: String(options.defaultInsuranceAmount), currency: "EUR" }` when configured                  |
| `customs_information.invoice_number`        | same as `order_number`                                                                                |
| `customs_information.export_reason`         | `options.defaultExportReason ?? "commercial_goods"`                                                   |
| `to_service_point.id`                       | `data.sendcloud_service_point_id` when set (validated earlier in `validateFulfillmentData`)           |

### Address mapping

| Medusa field             | SendCloud field       |
| ------------------------ | --------------------- |
| `first_name + last_name` | `name`                |
| `company`                | `company_name`        |
| `address_1`              | `address_line_1`      |
| `address_2`              | `address_line_2`      |
| `city`                   | `city`                |
| `postal_code`            | `postal_code`         |
| `country_code`           | `country_code`        |
| `province`               | `state_province_code` |
| `phone`                  | `phone_number`        |
| `email`                  | `email`               |

Required for SendCloud: `name, address_line_1, postal_code, city, country_code`. If any are missing/empty, the plugin throws `MedusaError.Types.INVALID_DATA` before making any request.

## Response mapping

SendCloud returns `201` with `{ data: { id, parcels, label_details, applied_shipping_rules } }`. The plugin takes the first parcel and projects:

| Returned path                 | Source                                                    |
| ----------------------------- | --------------------------------------------------------- |
| `data.sendcloud_shipment_id`  | `response.data.id`                                        |
| `data.sendcloud_parcel_id`    | `response.data.parcels[0].id`                             |
| `data.tracking_number`        | `response.data.parcels[0].tracking_number`                |
| `data.tracking_url`           | `response.data.parcels[0].tracking_url`                   |
| `data.status`                 | `response.data.parcels[0].status` (`{ code, message }`)   |
| `data.label_url`              | `response.data.parcels[0].documents[{type:"label"}].link` |
| `data.announced_at`           | `response.data.parcels[0].announced_at`                   |
| `data.applied_shipping_rules` | `response.data.applied_shipping_rules`                    |
| `labels[0]`                   | `{ tracking_number, tracking_url, label_url }`            |

## Scope this cycle

- Single parcel. Multi-collo (spec §8) deferred.
- Insurance via plugin option `defaultInsuranceAmount`. Rule-based insurance still resolves via `apply_shipping_rules: true`.
- Service-point forwarding honors the `sendcloud_service_point_id` enrichment that `validateFulfillmentData` (§3.3) set.

## Customs limitation

SendCloud's customs fields `hs_code`, `origin_country`, and per-item weight live on `ProductVariant` in Medusa, which isn't expanded on either `FulfillmentItemDTO` or `FulfillmentOrderLineItemDTO` reachable from this provider method's signature. This cycle ships:

- `customs_information.invoice_number` (from order reference)
- `customs_information.export_reason` (plugin option)
- `parcel_items[]` with `description`, `quantity`, `sku`, `item_id`, and resolvable `price`

International non-EU shipments that need `hs_code` / `origin_country` / per-item weight will fail at the carrier step until cycle 05 adds variant resolution (likely via `productModuleService` injection into the provider container, or a workflow wrapper that pre-enriches `data`). Domestic and EU-internal shipments work today.

## Plugin options

| Option                   | Default              | Role                                                                                                                            |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `defaultExportReason`    | `"commercial_goods"` | Customs export_reason enum                                                                                                      |
| `defaultInsuranceAmount` | _none_               | Per-parcel `additional_insured_price` in EUR (overridable per-fulfillment via `metadata.sendcloud_insurance_amount` — cycle 15) |

## Error handling

| Condition                                | Error                                  |
| ---------------------------------------- | -------------------------------------- |
| `data.sendcloud_code` missing/whitespace | `INVALID_DATA`                         |
| Shipping address missing required fields | `INVALID_DATA` (field name in message) |
| SendCloud returns no `parcels[0]`        | `UNEXPECTED_STATE`                     |
| Any HTTP error                           | Mapped by `SendCloudClient.request`    |

## Tests

`src/providers/sendcloud/__tests__/service.unit.spec.ts` → `describe("createFulfillment")` — 7 cases covering happy path, service-point forwarding, insurance, custom export reason, missing code, missing address fields, empty response parcels.
