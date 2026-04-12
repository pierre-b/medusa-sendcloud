# medusa-sendcloud — Feature Documentation

Each feature landed in this plugin gets its own page here. The index is the authoritative list — if a feature isn't linked below, it isn't shipped.

## Features

- [Fulfillment options — `getFulfillmentOptions` (§3.1)](./fulfillment-options.md) — list SendCloud carrier-service combinations for shipping-option creation

## OpenAPI snapshots

Vendor-authoritative copies of the SendCloud v3 specs the plugin relies on. Kept verbatim (Prettier-ignored) so future reviewers can diff against the live docs.

- [`openapi-snapshots/shipping-options.yaml`](./openapi-snapshots/shipping-options.yaml) — `POST /api/v3/shipping-options`, used by §3.1

## Planning

- [`plans/01-get-fulfillment-options.md`](./plans/01-get-fulfillment-options.md) — design doc for this cycle

## Roadmap

See `../../chocolaterie/docs/medusa-sendcloud-plugin-spec.md` §19 for the full feature checklist (P0 → P3). Next cycle: §3.2 `validateOption`.
