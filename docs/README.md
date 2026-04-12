# medusa-sendcloud — Feature Documentation

Each feature landed in this plugin gets its own page here. The index is the authoritative list — if a feature isn't linked below, it isn't shipped.

## Features

- [Fulfillment options — `getFulfillmentOptions` (§3.1)](./fulfillment-options.md) — list SendCloud carrier-service combinations for shipping-option creation
- [Validate option + can calculate — `validateOption`, `canCalculate` (§3.2, §3.5)](./validate-option.md) — admin-time confirmation that a saved option still resolves on SendCloud
- [Validate fulfillment data — `validateFulfillmentData` (§3.3)](./validate-fulfillment-data.md) — checkout-time service-point requirement enforcement
- [Calculate price — `calculatePrice` (§3.4)](./calculate-price.md) — live SendCloud quote per shipping option at checkout
- [Create fulfillment — `createFulfillment` (§3.6)](./create-fulfillment.md) — announce the shipment to SendCloud and persist tracking + label URL
- [Cancel fulfillment — `cancelFulfillment` (§3.7)](./cancel-fulfillment.md) — cancel a SendCloud shipment (manual or compensation)
- [Variant customs resolution](./variant-customs-resolution.md) — `order.placed` subscriber enriches `order.metadata.sendcloud_variants` so `createFulfillment` can populate `hs_code`, `origin_country`, per-item weight
- [Create return fulfillment — `createReturnFulfillment` (§3.8)](./create-return-fulfillment.md) — inverted-address return parcel via `/api/v3/returns/announce-synchronously`
- [Webhook sync — `parcel_status_changed` + `refund_requested` (§4)](./webhook-sync.md) — HMAC-verified SendCloud → Medusa tracking lifecycle + delivered/exception flags
- [Service-point lookup — `GET /store/sendcloud/service-points` (§5)](./service-points.md) — storefront PUDO pickup-point search proxied to `servicepoints.sendcloud.sc`
- [Bulk label download — `POST /admin/sendcloud/labels/bulk` (§6.3)](./bulk-labels.md) — admin downloads one merged PDF covering up to 20 fulfillments at once
- [Per-fulfillment label — `GET /admin/sendcloud/labels/{fulfillment_id}` (§6.2)](./single-label-download.md) — admin downloads a single PDF via GET with optional paper_size + dpi
- [Admin SendCloud dashboard — `/app/sendcloud` (§15.1)](./admin-settings.md) — connection status, webhook URL, and enabled-carrier list in the admin sidebar

## OpenAPI snapshots

Vendor-authoritative copies of the SendCloud v3 specs the plugin relies on. Kept verbatim (Prettier-ignored) so future reviewers can diff against the live docs.

- [`openapi-snapshots/shipping-options.yaml`](./openapi-snapshots/shipping-options.yaml) — `POST /api/v3/shipping-options`, used by §3.1 / §3.2 / §3.4
- [`openapi-snapshots/shipments.yaml`](./openapi-snapshots/shipments.yaml) — `POST /api/v3/shipments/announce-with-shipping-rules` + `/cancel`, used by §3.6 / §3.7
- [`openapi-snapshots/returns.yaml`](./openapi-snapshots/returns.yaml) — `POST /api/v3/returns/announce-synchronously`, used by §3.8
- [`openapi-snapshots/service-points.yaml`](./openapi-snapshots/service-points.yaml) — v2 `/service-points` on `servicepoints.sendcloud.sc`, used by §5
- [`openapi-snapshots/parcel-documents.yaml`](./openapi-snapshots/parcel-documents.yaml) — v3 `/parcel-documents/{type}` + `/parcels/{id}/documents/{type}`, used by §6.3

## Planning

- [`plans/01-get-fulfillment-options.md`](./plans/01-get-fulfillment-options.md) — cycle 01: `getFulfillmentOptions`
- [`plans/02-validate-option-and-checkout-data.md`](./plans/02-validate-option-and-checkout-data.md) — cycle 02: `validateOption` + `canCalculate` + `validateFulfillmentData`
- [`plans/03-calculate-price.md`](./plans/03-calculate-price.md) — cycle 03: `calculatePrice`
- [`plans/04-create-and-cancel-fulfillment.md`](./plans/04-create-and-cancel-fulfillment.md) — cycle 04: `createFulfillment` + `cancelFulfillment`
- [`plans/05-variant-resolution-for-customs.md`](./plans/05-variant-resolution-for-customs.md) — cycle 05: variant customs resolution via subscriber
- [`plans/06-create-return-fulfillment.md`](./plans/06-create-return-fulfillment.md) — cycle 06: `createReturnFulfillment`
- [`plans/07-webhook-parcel-status-sync.md`](./plans/07-webhook-parcel-status-sync.md) — cycle 07: `parcel_status_changed` + `refund_requested` webhook
- [`plans/08-service-point-lookup.md`](./plans/08-service-point-lookup.md) — cycle 08: storefront service-point proxy
- [`plans/09-bulk-label-download.md`](./plans/09-bulk-label-download.md) — cycle 09: bulk label download
- [`plans/10-single-label-download.md`](./plans/10-single-label-download.md) — cycle 10: per-fulfillment label shortcut
- [`plans/11-admin-settings-widget.md`](./plans/11-admin-settings-widget.md) — cycle 11: admin SendCloud dashboard page

## Roadmap

See `../../chocolaterie/docs/medusa-sendcloud-plugin-spec.md` §19 for the full feature checklist (P0 → P3). P0 complete; P1 progressing (service points ✅, bulk labels ✅, single label ✅, admin settings widget ✅). Next: multi-collo (§8), return cancellation, or ZPL/PNG format variants.
