# medusa-sendcloud — Feature Documentation

Each feature landed in this plugin gets its own page here. The index is the authoritative list — if a feature isn't linked below, it isn't shipped.

## Features

- [Fulfillment options — `getFulfillmentOptions` (§3.1)](./fulfillment-options.md) — list SendCloud carrier-service combinations for shipping-option creation
- [Validate option + can calculate — `validateOption`, `canCalculate` (§3.2, §3.5)](./validate-option.md) — admin-time confirmation that a saved option still resolves on SendCloud
- [Validate fulfillment data — `validateFulfillmentData` (§3.3)](./validate-fulfillment-data.md) — checkout-time service-point requirement enforcement
- [Calculate price — `calculatePrice` (§3.4)](./calculate-price.md) — live SendCloud quote per shipping option at checkout
- [Create fulfillment — `createFulfillment` (§3.6)](./create-fulfillment.md) — announce the shipment to SendCloud and persist tracking + label URL
- [Cancel fulfillment — `cancelFulfillment` (§3.7)](./cancel-fulfillment.md) — cancel a SendCloud shipment (manual or compensation)

## OpenAPI snapshots

Vendor-authoritative copies of the SendCloud v3 specs the plugin relies on. Kept verbatim (Prettier-ignored) so future reviewers can diff against the live docs.

- [`openapi-snapshots/shipping-options.yaml`](./openapi-snapshots/shipping-options.yaml) — `POST /api/v3/shipping-options`, used by §3.1 / §3.2 / §3.4
- [`openapi-snapshots/shipments.yaml`](./openapi-snapshots/shipments.yaml) — `POST /api/v3/shipments/announce-with-shipping-rules` + `/cancel`, used by §3.6 / §3.7

## Planning

- [`plans/01-get-fulfillment-options.md`](./plans/01-get-fulfillment-options.md) — cycle 01: `getFulfillmentOptions`
- [`plans/02-validate-option-and-checkout-data.md`](./plans/02-validate-option-and-checkout-data.md) — cycle 02: `validateOption` + `canCalculate` + `validateFulfillmentData`
- [`plans/03-calculate-price.md`](./plans/03-calculate-price.md) — cycle 03: `calculatePrice`
- [`plans/04-create-and-cancel-fulfillment.md`](./plans/04-create-and-cancel-fulfillment.md) — cycle 04: `createFulfillment` + `cancelFulfillment`

## Roadmap

See `../../chocolaterie/docs/medusa-sendcloud-plugin-spec.md` §19 for the full feature checklist (P0 → P3). Next cycle: §3.8 `createReturnFulfillment` + variant resolution for full customs.
