# Plan 04 — `createFulfillment` + `cancelFulfillment` (spec §3.6, §3.7)

## Context

Biggest cycle so far. Announces parcels to real carriers, persists tracking numbers and label URLs, and closes the compensation path so failed creations can be cleaned up.

**Goal:** when a Medusa admin creates a fulfillment for an order, the plugin calls SendCloud to create + announce the shipment in one sync round trip, returns `{ data, labels }` that Medusa stores on the fulfillment. When the fulfillment is cancelled (manually or via Medusa's workflow compensation), the plugin cancels the matching shipment in SendCloud.

**Why bundled:** `createFulfillment` without `cancelFulfillment` leaves Medusa's compensation path broken. They share `sendcloud_shipment_id` as their only contract with each other. One commit, two methods.

### User decisions

- **Endpoint:** `POST /api/v3/shipments/announce-with-shipping-rules` (sync, max 15 parcels, applies rules + defaults per spec §3.6)
- **Customs:** include `hs_code`, `origin_country`, `export_reason` (enables international shipments out of the gate)
- **Label:** persist the label URL only; the admin downloads the PDF on demand. No base64 embedding.

### Scope constraints

- Single-parcel only. Multi-collo (spec §8) stays deferred.
- Insurance only if `options.defaultInsuranceAmount` is set (per-parcel `additional_insured_price`). Rule-based insurance is still driven by SendCloud's dashboard via `apply_shipping_rules: true`.
- No return flow (`createReturnFulfillment`, spec §3.8) — separate cycle.
- No webhook handling (spec §4) — separate cycle.

---

## Prerequisites

Snapshot the SendCloud v3 shipments OpenAPI spec (already downloaded in this session as `docs/openapi-snapshots/shipments.yaml`, 6108 lines, sha256 `88a6e519…`) and commit it with the plan.

---

## External API verification (verified against the real OpenAPI)

### `POST /api/v3/shipments/announce-with-shipping-rules` (operationId `sc-public-v3-scp-post-announce_shipment_with_rules`)

Only `to_address` is truly required when `apply_shipping_rules` or `apply_shipping_defaults` is `true` (both default `true`). Body fields we send:

| Field                                       | Source                                                                     | Required?                         |
| ------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------- |
| `to_address`                                | `fulfillment.shipping_address ?? order.shipping_address`                   | yes                               |
| `ship_with.type`                            | `"shipping_option_code"` (literal)                                         | via ship_with                     |
| `ship_with.properties.shipping_option_code` | `data.sendcloud_code`                                                      | via ship_with                     |
| `parcels[]`                                 | single parcel from `aggregateParcel(items, weightUnit)`                    | optional per spec, we always send |
| `parcels[0].parcel_items[]`                 | per-line-item — maps to fulfillment items                                  | required for customs              |
| `order_number`                              | `order.display_id ?? order.id`                                             | no                                |
| `external_reference_id`                     | `fulfillment.id`                                                           | no                                |
| `total_order_price`                         | `{ value: String(order.total), currency: order.currency_code }` if present | no                                |
| `to_service_point.id`                       | `data.sendcloud_service_point_id` if present                               | no                                |
| `customs_information.export_reason`         | `options.defaultExportReason ?? "commercial_goods"`                        | required for international        |
| `customs_information.invoice_number`        | `order.display_id ?? order.id`                                             | required for international        |
| `apply_shipping_rules`                      | `true`                                                                     | defaults true                     |
| `apply_shipping_defaults`                   | `true`                                                                     | defaults true                     |

The `address-with-required-fields` schema requires `name, address_line_1, postal_code, city, country_code`. Medusa ships `first_name + last_name` which we join into `name`. `house_number`, `address_line_2`, `state_province_code`, `email`, `phone_number`, `company_name` are optional — we pass them when the Medusa address has them.

### Response (201) — `sync-shipment-with-rules-response`

```
data: {
  id: "XXX-Shipment-id",                    # string
  parcels: [{
    id: 383707309,                          # integer
    status: { code: "READY_TO_SEND", message: "Ready to send" },
    documents: [{ type: "label", size: "a6", link: "https://panel.sendcloud.sc/api/v3/parcels/.../documents/label" }],
    tracking_number: "3SYZXG8498635",
    tracking_url: "https://tracking.eu-central-1-0.sendcloud.sc/forward?...",
    announced_at: "2024-06-06T17:11:14.712398Z",
    weight: { value: "1.320", unit: "kg" },
    dimensions: { ... },
    parcel_items: [...],
  }],
  label_details: { mime_type: "application/pdf", dpi: 72 },
  applied_shipping_rules: [...],
}
```

We extract:

- `data.id` → `sendcloud_shipment_id`
- `data.parcels[0].id` → `sendcloud_parcel_id`
- `data.parcels[0].tracking_number` → `tracking_number`
- `data.parcels[0].tracking_url` → `tracking_url`
- `data.parcels[0].status` → `status`
- `data.parcels[0].documents` → find `type === "label"` → `link` used for `labels[0].label_url`
- `data.parcels[0].announced_at` → `announced_at`

### `POST /api/v3/shipments/{id}/cancel` (spec §3.7)

No request body. Response branches:

- `200`: `{ data: { status: "cancelled", message: "Shipment has been cancelled" } }`
- `202`: `{ data: { status: "queued", message: "Shipment cancellation has been queued" } }` — happens for `READY_TO_SEND` parcels; SendCloud watches them for 14 days and cancels if unchanged
- `409`: already cancelled / delivered / >42 days → surfaced as `MedusaError.Types.CONFLICT` by the client's status mapping

Both `200` and `202` are success paths for us. We return `{ status: body.data.status, message: body.data.message }` to be stored on `fulfillment.data.cancellation` for audit.

---

## Plugin options added

| Option                   | Type                                                                 | Default              | Purpose                                                                                                       |
| ------------------------ | -------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `defaultExportReason`    | `"gift" \| "documents" \| "commercial_goods" \| "commercial_sample"` | `"commercial_goods"` | Customs reason for international shipments; applied to `customs_information.export_reason`                    |
| `defaultInsuranceAmount` | `number` (EUR, min 2)                                                | `undefined`          | (Already declared in plugin options; wired here for the first time via `parcels[0].additional_insured_price`) |

---

## Behaviour spec

### `createFulfillment(data, items, order, fulfillment): Promise<CreateFulfillmentResult>`

1. `const code = readSendCloudCode(data)` — existing guard
2. Build `to_address` from `fulfillment.shipping_address ?? order?.shipping_address` via a new `buildToAddress` helper. Throws `INVALID_DATA` if required fields missing.
3. `const parcel = aggregateParcel(items, weightUnit)` — reuses cycle-03 helper; but wait — `items` in `createFulfillment` is `Partial<FulfillmentItemDTO>[]`, not the cart's enriched items. New `buildParcelForFulfillment(items, weightUnit)` variant that iterates `FulfillmentItemDTO` and reads from `item.variant?.weight`, etc.
4. Build `parcel_items[]` — one entry per fulfillment item with `description`, `quantity`, `price`, `weight`, `sku`, `hs_code`, `origin_country` drawn from `item.variant`.
5. Attach `to_service_point: { id: data.sendcloud_service_point_id }` if present.
6. Attach `customs_information: { invoice_number, export_reason }` unconditionally — SendCloud ignores it for EU-internal shipments.
7. Attach `parcels[0].additional_insured_price` if `options.defaultInsuranceAmount` set.
8. POST and parse:
   - `data.id` missing → `UNEXPECTED_STATE`
   - `data.parcels` empty → `UNEXPECTED_STATE`
9. Return:
   ```ts
   {
     data: {
       sendcloud_shipment_id,
       sendcloud_parcel_id,
       tracking_number,
       tracking_url,
       label_url,              // from documents[type="label"].link
       status,                  // { code, message }
       announced_at,
       applied_shipping_rules,  // pass through
     },
     labels: [{
       tracking_number,
       tracking_url,
       label_url,
     }],
   }
   ```

### `cancelFulfillment(data): Promise<any>`

1. `const shipmentId = requireString(data.sendcloud_shipment_id, "data.sendcloud_shipment_id")`
2. POST `/api/v3/shipments/{shipmentId}/cancel` — no body
3. Accept 200 and 202 as success (both return `{ data: { status, message } }`)
4. Return `{ sendcloud_cancellation: { status, message } }` — Medusa merges this onto `fulfillment.data`
5. 409 already propagates as `MedusaError.Types.CONFLICT` via the client — admin sees the reason

The client's existing retry logic + error mapping handles network faults and rate-limit edge cases.

---

## Types

New in `src/types/sendcloud-api.ts`:

```ts
export type SendCloudAddress = {
  name: string;
  company_name?: string;
  address_line_1: string;
  house_number?: string;
  address_line_2?: string;
  postal_code: string;
  city: string;
  po_box?: string | null;
  state_province_code?: string;
  country_code: string;
  email?: string;
  phone_number?: string;
};

export type SendCloudShipWith = {
  type: "shipping_option_code" | "shipping_product_code";
  properties: {
    shipping_option_code?: string;
    shipping_product_code?: string;
    contract_id?: number | null;
  };
};

export type SendCloudCustomsExportReason =
  | "gift"
  | "documents"
  | "commercial_goods"
  | "commercial_sample"
  | "returned_goods";

export type SendCloudCustomsInformation = {
  invoice_number?: string;
  export_reason?: SendCloudCustomsExportReason;
};

export type SendCloudParcelItemRequest = {
  description: string;
  quantity: number;
  weight?: SendCloudWeight;
  price?: SendCloudPrice;
  hs_code?: string;
  origin_country?: string;
  sku?: string;
  item_id?: string;
  product_id?: string;
};

export type SendCloudParcelRequest = {
  weight?: SendCloudWeight;
  dimensions?: SendCloudDimension;
  parcel_items?: SendCloudParcelItemRequest[];
  additional_insured_price?: SendCloudPrice | null;
};

export type SendCloudShipmentRequest = {
  label_details?: { mime_type?: string; dpi?: number };
  to_address: SendCloudAddress;
  from_address?: SendCloudAddress;
  ship_with?: SendCloudShipWith;
  apply_shipping_defaults?: boolean;
  apply_shipping_rules?: boolean;
  order_number?: string;
  external_reference_id?: string;
  total_order_price?: SendCloudPrice;
  parcels?: SendCloudParcelRequest[];
  to_service_point?: { id?: string; carrier_service_point_id?: string };
  customs_information?: SendCloudCustomsInformation;
  brand_id?: number;
};

export type SendCloudParcelDocument = {
  type: string; // "label" | "customs-declaration" | ...
  size?: string; // "a4" | "a6" | ...
  link: string;
};

export type SendCloudParcelStatus = {
  code: string;
  message: string;
};

export type SendCloudParcelResponse = {
  id: number;
  status: SendCloudParcelStatus;
  documents: SendCloudParcelDocument[];
  tracking_number: string;
  tracking_url: string;
  announced_at?: string;
  weight?: SendCloudWeight;
  dimensions?: SendCloudDimension;
};

export type SendCloudShipmentResponse = {
  data: {
    id: string;
    parcels: SendCloudParcelResponse[];
    label_details?: { mime_type?: string; dpi?: number };
    applied_shipping_rules?: unknown[];
  };
};

export type SendCloudShipmentCancelResponse = {
  data: { status: "cancelled" | "queued"; message: string };
};
```

---

## TDD sequence

### Red

New `describe("createFulfillment")` block with seven cases:

1. Domestic happy path — minimal payload, asserts `to_address`, `ship_with`, `parcels[0].weight`, `apply_shipping_rules: true`; asserts the returned `data.*` fields and a single `labels[0]`
2. International — items with `hs_code` + `origin_country` surface on `parcels[0].parcel_items[]`
3. Service point forwarded — when `data.sendcloud_service_point_id` is set, body contains `to_service_point: { id }`
4. Insurance — when `options.defaultInsuranceAmount` is set, body's `parcels[0].additional_insured_price` matches
5. Throws `INVALID_DATA` when `sendcloud_code` missing on data
6. Throws `INVALID_DATA` when `to_address.country_code` missing
7. Throws `UNEXPECTED_STATE` when response has empty `parcels[]`

New `describe("cancelFulfillment")` with four cases:

1. 200 cancelled — returns `{ sendcloud_cancellation: { status: "cancelled", message: … } }`
2. 202 queued — same shape, different status value
3. 409 → `CONFLICT` MedusaError (via client mapping)
4. Throws `INVALID_DATA` when `data.sendcloud_shipment_id` missing

### Green

1. Extend `src/types/plugin-options.ts` with `defaultExportReason`
2. Add the new SendCloud types from the section above to `src/types/sendcloud-api.ts`
3. Add helpers to `src/providers/sendcloud/helpers.ts`:
   - `buildToAddress(address, fallback?)` — maps Medusa address → `SendCloudAddress`, throws on missing required
   - `buildParcelItemsFromFulfillment(items)` — iterates `FulfillmentItemDTO`
   - `buildShipmentRequest(params)` — composes the full payload
4. Override `createFulfillment` and `cancelFulfillment` on the provider
5. Run tests → green

### Refactor

- Re-run the five Ultrathink passes
- If the fixtures in the test file grow further, extract to `src/__tests__/fixtures.ts` (trigger met in cycle 03; now truly unavoidable)

---

## Docs

- `docs/create-fulfillment.md` — new
- `docs/cancel-fulfillment.md` — new
- `docs/README.md` — feature index + snapshots list (add `shipments.yaml`)
- `NOTES.md` — parked items: multi-collo split, return label generation, webhook handling, label base64 embedding (when offline retrieval becomes necessary)
- Replace `it.todo("createFulfillment — §3.6")` with `it.todo("createReturnFulfillment — §3.8")`

---

## Critical files to be created or modified

| Path                                                     | Action                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `docs/openapi-snapshots/shipments.yaml`                  | commit snapshot                                                             |
| `src/providers/sendcloud/service.ts`                     | override `createFulfillment`, `cancelFulfillment`                           |
| `src/providers/sendcloud/helpers.ts`                     | `buildToAddress`, `buildParcelItemsFromFulfillment`, `buildShipmentRequest` |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts` | 11 new tests (7 create + 4 cancel)                                          |
| `src/types/sendcloud-api.ts`                             | new types for request/response/cancel                                       |
| `src/types/plugin-options.ts`                            | `defaultExportReason`                                                       |
| `docs/create-fulfillment.md`                             | create                                                                      |
| `docs/cancel-fulfillment.md`                             | create                                                                      |
| `docs/README.md`                                         | feature + snapshot index                                                    |
| `NOTES.md`                                               | parked items                                                                |

---

## Gate + push

1. `make check && npm run test:unit` — existing 51 + 11 new = 62 tests green, 1 todo
2. `npx medusa plugin:build` — still clean
3. Single commit: _"Implement createFulfillment + cancelFulfillment with v3 announce-with-rules"_
4. `git push origin main`

---

## Out of scope (next plans)

- **§3.8 `createReturnFulfillment`** — next cycle target
- §4 webhook handling (parcel_status_changed sync to Medusa)
- §8 multi-collo
- Label base64 embedding (when offline retrieval becomes a user requirement)
- Admin UI widget (spec §15)
