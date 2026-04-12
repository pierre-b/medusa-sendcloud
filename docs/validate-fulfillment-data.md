# Validate Fulfillment Data — `validateFulfillmentData`

Implements spec §3.3. Fires at **checkout time**, not admin-time — when a customer selects a shipping method on the cart.

## Flow

```
Customer selects "PostNL Service Point" at checkout
  → Medusa fulfillment module calls provider.validateFulfillmentData(optionData, data, context)
      - optionData: the shipping option's persisted data (sendcloud_code, sendcloud_requires_service_point, …)
      - data:       the customer-supplied payload (service_point_id, …)
      - context:    the cart context (shipping address, items, …)
  → if the option requires a service point, we enforce data.service_point_id is present
  → we return the (possibly enriched) data object; Medusa stores it on the shipping method
```

## Validation performed this cycle

| Check                                                                                     | Behaviour                                                                     |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `optionData.sendcloud_code` missing / empty                                               | throw `MedusaError.Types.INVALID_DATA`                                        |
| `optionData.sendcloud_requires_service_point !== true`                                    | return `data` unchanged                                                       |
| requires_service_point is `true` and `data.service_point_id` missing / empty / wrong-type | throw `INVALID_DATA` with message referencing the shipping option code        |
| requires_service_point is `true` and `data.service_point_id` present                      | return `{ …data, sendcloud_service_point_id: String(data.service_point_id) }` |

The string coercion on `sendcloud_service_point_id` lets storefronts pass either SendCloud's numeric service-point id or a carrier's alphanumeric id verbatim — the outbound `createFulfillment` call will handle whichever format downstream.

## Explicitly out of scope for this cycle

Spec §3.3 also mentions:

- Destination-country support — not checked yet. The v3 response doesn't include a country list on each option; the authoritative way to validate is a round-trip with `to_country_code` filter. Deferred.
- Weight vs. carrier min/max — not checked yet. Option-data mapping in §3.1 doesn't currently persist `weight.min` / `weight.max`. Deferred.
- Round-tripping the service-point id to SendCloud's servicepoints.sendcloud.sc API. Deferred to the service-points cycle (spec §5).

These will land in follow-up cycles once we have the option-data fields and the cart context test fixtures required.

## Tests

- `src/providers/sendcloud/__tests__/service.unit.spec.ts` — `describe("validateFulfillmentData")`
- Coverage: no-requirement passthrough, requirement + present enriches, requirement + missing throws, missing code throws

## Plugin options surfaced

None. This method is pure in-process validation — no HTTP calls this cycle.
