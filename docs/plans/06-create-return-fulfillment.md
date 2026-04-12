# Plan 06 — `createReturnFulfillment` (spec §3.8)

## Context

Completes the P0 shipping lifecycle. When a customer initiates a return, Medusa's core-flow `createReturnFulfillmentWorkflow` calls our provider. The plugin creates a **return parcel** in SendCloud — same carrier endpoint family as outbound, different payload semantics (addresses inverted: customer → warehouse) and a different response shape.

**Why now:** the `it.todo("createReturnFulfillment — §3.8")` marker is the outstanding P0/P1 piece. Cycle 05's variant-customs resolution applies unchanged to returns (spec §7.3 makes customs _mandatory_ for non-EU returns), so landing this cycle gives international returns out of the gate.

### Spec-verified inputs

`createReturnFulfillment(fulfillment: Record<string, unknown>): Promise<CreateFulfillmentResult>`

Single parameter. Medusa's core-flow wraps a `CreateFulfillmentDTO`-shaped blob into the argument and passes it down. Verified fields available on the blob (from `@medusajs/types/dist/fulfillment/mutations/fulfillment.d.ts`):

- `data` — arbitrary provider data (our `sendcloud_code`, any flags)
- `location` — stock location object, including `location.address` → the **warehouse address** (SendCloud `to_address`)
- `delivery_address` — **customer address** (SendCloud `from_address`)
- `items` — return items (array of `CreateFulfillmentItemDTO`: `title`, `quantity`, `sku`, `barcode`, `line_item_id`, …)
- `order` — optional partial `OrderDTO` (has `display_id`, `currency_code`, `items`, `metadata` with `sendcloud_variants`)

This means customs data (`hs_code`, `origin_country`, per-item weight) flows through the same `order.metadata.sendcloud_variants` path cycle 05 established — no new subscriber or workflow needed.

### User decisions (answered implicitly; call out any objections)

- **Endpoint:** `POST /api/v3/returns/announce-synchronously` (operationId `sc-public-v3-scp-post-returns_create_new_return_synchronously`). Sync. The alternative `POST /api/v3/returns` is async — the sync variant is safer for a provider contract that must hand back `{ data, labels }` immediately. SendCloud flags sync as "for debugging" because of latency, but for our single-parcel foundation volume it's fine.
- **Label URL:** the sync response returns only `{ return_id, parcel_id, multi_collo_ids }` — no label URL / tracking number. Construct the label URL as `${baseUrl}/api/v3/parcels/${parcel_id}/documents/label` (stable, documented pattern). `tracking_number` stays `null` in `fulfillment.data` until a tracking webhook arrives (future cycle).
- **Scope:** single parcel; multi-collo stays deferred.

### Scope constraints

- Single parcel. If `multi_collo_ids` comes back non-empty, we log at `debug` but only populate the primary parcel in the fulfillment data.
- No rule-based label fetching — the label URL we emit is a SendCloud-authenticated link; admin opens it in a browser while logged into SendCloud. Offline / base64 embedding stays parked.
- Brand, insurance (`total_insured_value`), return fee, reason — not wired this cycle; defer until a consumer asks.

---

## External API verification (verified against `docs/openapi-snapshots/returns.yaml`)

### `POST /api/v3/returns/announce-synchronously`

**Request body** — `Return` schema. Fields we send:

| Field                  | Source                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `from_address`         | `fulfillment.delivery_address` → `buildToAddress`                                                                         |
| `to_address`           | `fulfillment.location.address` → `buildToAddress` (reused helper; name derivation handled inside)                         |
| `shipping_option.code` | `data.sendcloud_code`                                                                                                     |
| `weight`               | aggregated from `parcel_items[].weight` when variant customs resolved, else omitted (SendCloud applies shipping defaults) |
| `parcel_items[]`       | per-return-item via `buildParcelItems` (reuses cycle-05 customs path)                                                     |
| `order_number`         | `order.display_id ?? order.id`                                                                                            |
| `customs_invoice_nr`   | same as `order_number`                                                                                                    |
| `send_tracking_emails` | `true`                                                                                                                    |
| `brand_id`             | `options.brandId` if configured (already declared in plugin options; first wiring)                                        |

**Response (201)** — `{ return_id: number, parcel_id: number, multi_collo_ids: number[] }`. Required by the spec. No tracking number, no label URL.

### Label URL pattern

`${baseUrl}/api/v3/parcels/${parcel_id}/documents/label` — same pattern used by `createFulfillment`'s label document links. Stable per the shipments docs.

---

## Behaviour spec

### `createReturnFulfillment(fulfillment: Record<string, unknown>): Promise<CreateFulfillmentResult>`

1. `const code = readSendCloudCode(fulfillment.data as Record<string, unknown> ?? {})`
2. `const fromAddress = buildToAddress(fulfillment.delivery_address)` (customer → sender)
3. `const toAddress = buildToAddress((fulfillment.location as { address?: unknown })?.address)` (warehouse → receiver)
4. `const variantsMap = readSendcloudVariantsFromOrder(fulfillment.order as Partial<FulfillmentOrderDTO>)`
5. `const parcelItems = buildParcelItems(fulfillment.items, fulfillment.order, { variantsMap, weightUnit: options.weightUnit ?? "g" })`
6. Build the return payload:
   ```ts
   {
     from_address: fromAddress,
     to_address: toAddress,
     shipping_option: { code },
     parcel_items: parcelItems.length > 0 ? parcelItems : undefined,
     order_number: orderReference,
     customs_invoice_nr: orderReference,
     send_tracking_emails: true,
     brand_id: options.brandId,
   }
   ```
7. POST `/api/v3/returns/announce-synchronously`
8. Parse `{ return_id, parcel_id, multi_collo_ids }`. If `return_id` or `parcel_id` missing → `UNEXPECTED_STATE`.
9. Build the label URL: `${baseUrl}/api/v3/parcels/${parcel_id}/documents/label`
10. Return:
    ```ts
    {
      data: {
        sendcloud_return_id,
        sendcloud_parcel_id,
        sendcloud_multi_collo_ids,
        label_url,
        tracking_number: null,
        tracking_url: null,
        status: null,
      },
      labels: [{ tracking_number: "", tracking_url: "", label_url }],
    }
    ```

`tracking_number` is `""` (empty string) in the label entry because Medusa's `FulfillmentLabel.tracking_number` is `string`. Not ideal but the type forces us; the real tracking number lands via webhook later. Alternatively we could return `labels: []` until we have the tracking number — matching cycle-04's "no label → empty labels" pattern. The label URL exists so skipping the label would lose it. Pick "empty strings for tracking" and document.

### Errors

| Condition                                            | Error                                 |
| ---------------------------------------------------- | ------------------------------------- |
| `fulfillment.data.sendcloud_code` missing/whitespace | `INVALID_DATA`                        |
| `fulfillment.delivery_address` missing/invalid       | `INVALID_DATA` (via `buildToAddress`) |
| `fulfillment.location.address` missing/invalid       | `INVALID_DATA` (via `buildToAddress`) |
| SendCloud returns no `return_id` / `parcel_id`       | `UNEXPECTED_STATE`                    |
| Any HTTP error                                       | Mapped by `SendCloudClient.request`   |

---

## Types

New in `src/types/sendcloud-api.ts`:

```ts
export type SendCloudReturnShippingOption = {
  code: string;
};

export type SendCloudReturnRequest = {
  from_address: SendCloudAddress;
  to_address: SendCloudAddress;
  shipping_option?: SendCloudReturnShippingOption;
  dimensions?: SendCloudDimension;
  weight?: SendCloudWeight;
  collo_count?: number;
  parcel_items?: SendCloudParcelItemRequest[];
  send_tracking_emails?: boolean;
  brand_id?: number;
  order_number?: string;
  customs_invoice_nr?: string;
};

export type SendCloudReturnResponse = {
  return_id: number;
  parcel_id: number;
  multi_collo_ids: number[];
};
```

`SendCloudAddress`, `SendCloudParcelItemRequest`, etc. already exist from cycle 04.

---

## TDD sequence

### Red

New `describe("createReturnFulfillment")` in the service spec, 6 cases:

1. Happy path — asserts outbound body (`from_address` = customer, `to_address` = warehouse, `shipping_option.code`, `parcel_items[]`), asserts returned `data` + `labels[0].label_url`
2. Customs — when `fulfillment.order.metadata.sendcloud_variants` is populated, `parcel_items[]` carry `hs_code` / `origin_country` / per-item weight (reuses the cycle-05 enrichment path)
3. Throws `INVALID_DATA` when `sendcloud_code` is missing
4. Throws `INVALID_DATA` when `delivery_address` is missing
5. Throws `INVALID_DATA` when `location.address` is missing
6. Throws `UNEXPECTED_STATE` when SendCloud response lacks `return_id`

### Green

1. Add types to `src/types/sendcloud-api.ts`
2. Add `buildReturnRequest(fulfillment, options)` helper to `helpers.ts` — composes the body from the blob
3. Override `createReturnFulfillment` on the provider
4. Tests pass

### Refactor

- Re-run the 5 Ultrathink passes
- Fixture extraction trigger is truly urgent now; still defer to keep cycle scope

---

## Docs

- **`docs/create-return-fulfillment.md`** — flow, inputs, response mapping, deferred items
- **`docs/create-fulfillment.md`** — mention returns share the same provider contract and customs path
- **`docs/README.md`** — feature index + snapshot index (add `returns.yaml`)
- **NOTES.md** — park: tracking number / tracking URL arrive via webhook (spec §4); brand/insurance/refund fields; multi-collo returns
- Replace `it.todo("createReturnFulfillment — §3.8")` with `it.todo("parcel_status_changed webhook — §4")`

---

## Critical files to be created or modified

| Path                                                     | Action                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `docs/openapi-snapshots/returns.yaml`                    | commit snapshot (already downloaded, 2742 lines)                                     |
| `src/types/sendcloud-api.ts`                             | `SendCloudReturnShippingOption`, `SendCloudReturnRequest`, `SendCloudReturnResponse` |
| `src/providers/sendcloud/helpers.ts`                     | `buildReturnRequest`                                                                 |
| `src/providers/sendcloud/service.ts`                     | override `createReturnFulfillment`                                                   |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts` | 6 new tests                                                                          |
| `docs/create-return-fulfillment.md`                      | create                                                                               |
| `docs/README.md`                                         | feature + snapshot index                                                             |
| `NOTES.md`                                               | parked items                                                                         |

---

## Gate + push

1. `make check && npm run test:unit` — existing 71 + 6 new = 77 green, 1 todo
2. `npx medusa plugin:build` — clean
3. Single commit: _"Implement createReturnFulfillment via v3 announce-synchronously"_
4. `git push origin main`

---

## Out of scope (next plans)

- **§4 webhooks** — tracking sync (parcel_status_changed → Medusa fulfillment status) — the natural next cycle
- Async return creation (`POST /api/v3/returns`)
- Return cancellation (`PATCH /api/v3/returns/{id}/cancel`) — will pair with webhooks
- Return portal integration (spec §7.1 approach A)
- Multi-collo returns
- Brand / insurance / refund / reason wiring
