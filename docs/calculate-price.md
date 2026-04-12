# Calculate Price — `calculatePrice`

Implements spec §3.4. Fires when Medusa renders shipping options at checkout for any option whose `price_type === "calculated"`.

## Flow

```
Customer reaches the shipping step of checkout
  → for each calculated shipping option, Medusa calls provider.calculatePrice(optionData, data, context)
  → provider reads context.shipping_address, context.from_location, context.items
  → aggregates a single parcel (summed weight + cubic bounding box)
  → POSTs /api/v3/shipping-options with calculate_quotes: true and the shipping_option_code filter
  → returns SendCloud's quotes[0].price.total.value as calculated_amount
```

## SendCloud endpoint

Same `POST https://panel.sendcloud.sc/api/v3/shipping-options`, this time with a populated filter:

```json
{
  "shipping_option_code": "postnl:standard/signature",
  "from_country_code": "FR",
  "to_country_code": "NL",
  "to_postal_code": "1012AB",
  "parcels": [
    {
      "weight": { "value": "1.500", "unit": "kg" },
      "dimensions": {
        "length": "20.80",
        "width": "20.80",
        "height": "20.80",
        "unit": "cm"
      }
    }
  ],
  "calculate_quotes": true
}
```

Response: `data[0].quotes[0].price.total.{value, currency}`. We return the numeric `value` as `calculated_amount`.

## Inputs

### `optionData`

| Field            | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `sendcloud_code` | required — extracted from the shipping option's persisted data |

### `context` (`CalculateShippingOptionPriceDTO["context"]`)

| Path                                              | Purpose                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `shipping_address.country_code`                   | required — destination; throws `INVALID_DATA` if missing             |
| `shipping_address.postal_code`                    | optional — improves quote accuracy, especially for zonal pricing     |
| `from_location.address.country_code`              | preferred sender — resolved from Medusa's stock-location association |
| `items[].variant.{weight, length, width, height}` | aggregated into a single parcel                                      |

### From-country resolution order

1. `context.from_location.address.country_code` — Medusa's stock-location origin
2. `options.defaultFromCountryCode` — plugin option fallback
3. Throws `INVALID_DATA` if neither resolves

## Parcel aggregation

Weight and dimensions are combined into a single parcel per cart:

- **Weight:** `sum(item.variant.weight * item.quantity)`, converted to kg based on the `weightUnit` plugin option (default `g`).
- **Dimensions:** `sum(item.variant.length * width * height * quantity)` → cube-root → cubic bounding box in cm.
- **Empty cart guard:** if both aggregate weight and volume are zero, throws `INVALID_DATA`.

The single-parcel assumption is deliberately simple this cycle. Multi-collo splitting (spec §8) is its own cycle; until then we treat each order as one box.

## Plugin options used

| Option                   | Default | Role                                                                |
| ------------------------ | ------- | ------------------------------------------------------------------- |
| `defaultFromCountryCode` | _none_  | Sender country fallback when `from_location` is absent              |
| `weightUnit`             | `"g"`   | Interprets `variant.weight` — values `"g" \| "kg" \| "lbs" \| "oz"` |

## Tax inclusivity

Hardcoded `is_calculated_price_tax_inclusive: false` — SendCloud quotes exclude destination tax, and Medusa adds tax on top. B2B stores that want tax-inclusive SendCloud quotes will need a follow-up `pricesIncludeTax` option.

## Error handling

| Condition                                                    | Error                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `optionData.sendcloud_code` missing or whitespace-only       | `INVALID_DATA`                                                              |
| `shipping_address.country_code` missing/empty                | `INVALID_DATA`                                                              |
| Neither `from_location` nor `defaultFromCountryCode`         | `INVALID_DATA`                                                              |
| Cart items yield zero weight AND zero volume                 | `INVALID_DATA`                                                              |
| SendCloud returns `data: []` or first option has no `quotes` | `UNEXPECTED_STATE`                                                          |
| Quote value is non-numeric (`Number.isFinite === false`)     | `UNEXPECTED_STATE`                                                          |
| Any HTTP error                                               | Mapped per `SendCloudClient.request` (`INVALID_DATA`, `UNAUTHORIZED`, etc.) |

## Tests

- `src/providers/sendcloud/__tests__/service.unit.spec.ts` → `describe("calculatePrice")`
- 9 cases: happy path (body shape + return value), defaultFromCountryCode fallback, missing to-country, missing both from sources, empty cart, empty data, no quotes, weight-unit conversion, volume aggregation

## Out of scope

- Multi-parcel splitting (spec §8, multicollo)
- Currency conversion for non-EUR stores
- Tax-inclusive pricing toggle
- Service-point pricing variance (`to_service_point` filter) — the option is picked at rate display; per-service-point pricing lands with the service-point lookup cycle
