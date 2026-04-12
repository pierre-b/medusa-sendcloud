# Plan 05 — Variant resolution for customs

## Context

Cycle 04 deferred per-item customs fields (`hs_code`, `origin_country`, per-item `weight`) on `parcel_items[]` because the fulfillment provider can't resolve them from its method signatures. `FulfillmentItemDTO` has no variant; `FulfillmentOrderLineItemDTO` has `variant_sku` but no variant-level customs fields. Medusa's module isolation forbids fulfillment providers from resolving Query (or other modules' services) directly — verified against Medusa docs on module isolation (`/learn/fundamentals/modules/isolation`).

**Goal:** when a customer places an order, resolve the customs fields for every variant in the cart once and store them on `order.metadata.sendcloud_variants`, keyed by variant id. When `createFulfillment` runs later, the provider reads from the metadata and merges the customs fields into each `parcel_items` entry. International non-EU shipments work end-to-end.

**Why now:** directly unblocks cycle 04's customs gap. Necessary for any real cross-border ops. Establishes the workflow/subscriber pattern that later cycles (webhooks, return flow) will reuse.

### User decision

- Approach: variant resolution for customs. Confirmed in the cycle-04 review follow-up.

### Scope constraints

- **Customs fields only** — `hs_code`, `origin_country`, `weight`. Other variant fields (`material_content`, `intended_use`, `mid_code`) stay deferred to a future cycle when a merchant actually asks.
- **Single enrichment point**: the `order.placed` event subscriber. Admin-created manual orders that skip `order.placed` will fall back to the cycle-04 behaviour (customs basics only). Documented, not coded around.
- **Race-tolerant**: if `order.metadata.sendcloud_variants` is missing or incomplete when `createFulfillment` runs, the provider ships the item without those fields — same failure mode as cycle 04. No synchronous re-resolution.

---

## Architecture

```
customer places order
  → Medusa emits `order.placed`
  → plugin subscriber src/subscribers/sendcloud-resolve-variants.ts fires
      → resolves Query from the Medusa container (ContainerRegistrationKeys.QUERY)
      → extracts distinct variant_ids from order.items[].variant_id
      → query.graph({ entity: "product_variant", filters: { id: variantIds },
                      fields: ["id", "hs_code", "origin_country", "weight"] })
      → runs the enrichSendcloudVariantsWorkflow step
          → calls the order module's updateOrders API to set
            order.metadata.sendcloud_variants = { [variantId]: { hs_code, origin_country, weight } }
  → (later) admin clicks "Create fulfillment"
  → Medusa fulfillment workflow calls provider.createFulfillment(data, items, order, fulfillment)
  → provider.createFulfillment reads order.metadata.sendcloud_variants
  → buildParcelItems merges variant customs fields per line_item → variant_id lookup
  → SendCloud receives parcel_items with hs_code / origin_country / weight populated
```

### Why a subscriber (not a workflow hook)

Workflow hooks on Medusa core-flows are possible but invasive and tied to private core-flow structures that can drift. A subscriber on a stable public event (`order.placed`) is idiomatic, isolated, and easy to replace if Medusa deprecates the event later. The trade-off is the race window (see below).

### The race window

`order.placed` and the admin's "Create fulfillment" action are independent. In theory an admin could create a fulfillment inside the subscriber's latency window. In practice: orders are placed by customers; admins fulfil later. The subscriber's Query call is single-shot and completes in ~10–50 ms against a hot cache. Acceptable for foundation.

Documented fallback: when `order.metadata.sendcloud_variants` is absent, `createFulfillment` still ships (without per-item customs) exactly as cycle 04 did.

---

## External API — no new SendCloud endpoints

The SendCloud payload shape for `parcel_items` was already established in cycle 04. We just fill in optional fields we previously left undefined. Verified against the shipments OpenAPI snapshot (`parcel-item-with-optional-fields` schema, lines ~5253 of `docs/openapi-snapshots/shipments.yaml`): `hs_code?: string`, `origin_country?: string`, `weight?: { value, unit }` are all optional and ignored for EU-internal shipments.

Per-item weight units: convert `variant.weight` from `options.weightUnit` (default `"g"`) to kg for SendCloud. Reuse `convertToKg` from cycle 03.

---

## Behaviour spec

### Subscriber — `src/subscribers/sendcloud-resolve-variants.ts`

Signature:

```ts
export default async function handleOrderPlaced({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>): Promise<void>;

export const config: SubscriberConfig = {
  event: "order.placed",
};
```

Logic:

1. `const query = container.resolve(ContainerRegistrationKeys.QUERY)`
2. Fetch the order: `query.graph({ entity: "order", filters: { id: data.id }, fields: ["id", "items.variant_id", "metadata"] })`
3. Extract distinct `variant_id` values from the line items
4. If empty → return (nothing to enrich)
5. Fetch variants: `query.graph({ entity: "product_variant", filters: { id: variantIds }, fields: ["id", "hs_code", "origin_country", "weight"] })`
6. Build the metadata map: `{ [variant.id]: { hs_code, origin_country, weight } }`, skipping entries with all-null values
7. Call `enrichSendcloudVariantsWorkflow(container).run({ input: { orderId, variants } })`

### Workflow — `src/workflows/enrich-sendcloud-variants.ts`

One step: merges the variant customs map into the existing `order.metadata.sendcloud_variants` (preserving any unrelated metadata keys), then calls Medusa's `updateOrderWorkflow` (or the order module's service directly via Query) to persist.

```ts
type EnrichInput = {
  orderId: string;
  variants: Record<
    string,
    { hs_code?: string; origin_country?: string; weight?: number }
  >;
};
```

Idempotent: re-running on the same order overwrites `metadata.sendcloud_variants` with the freshest resolved values.

### Provider change — `src/providers/sendcloud/service.ts`

In `createFulfillment`, before calling `buildShipmentParcel`:

```ts
const variantsMap = readSendcloudVariantsFromOrder(order);
const parcel = buildShipmentParcel(items, order, {
  insuranceAmount: this.options_.defaultInsuranceAmount,
  variantsMap,
  weightUnit: this.options_.weightUnit ?? "g",
});
```

### Helper change — `src/providers/sendcloud/helpers.ts`

`buildParcelItems` gains two optional parameters:

```ts
export const buildParcelItems = (
  items: FulfillmentItemDTO[] | undefined,
  order: Partial<FulfillmentOrderDTO> | undefined,
  opts?: {
    variantsMap?: Record<string, {
      hs_code?: string
      origin_country?: string
      weight?: number
    }>
    weightUnit?: SendCloudWeightUnitOption
  }
): SendCloudParcelItemRequest[]
```

For each item:

- Look up `line_item_id` → `order.items[i]` → `variant_id`
- If variantsMap has the entry: populate `hs_code`, `origin_country`, `weight: { value: convertToKg(entry.weight, unit).toFixed(3), unit: "kg" }`
- Skip any field whose source value is missing/null — SendCloud accepts partial customs per the OpenAPI

Also add `readSendcloudVariantsFromOrder` to helpers — reads `order.metadata.sendcloud_variants`, tolerates absent/malformed values by returning an empty map.

---

## Types

New in `src/types/sendcloud-api.ts`:

```ts
export type SendCloudVariantCustomsEntry = {
  hs_code?: string;
  origin_country?: string;
  weight?: number;
};

export type SendCloudVariantsMap = Record<string, SendCloudVariantCustomsEntry>;
```

Extend `docs/create-fulfillment.md`'s customs section once the cycle lands.

---

## TDD sequence

### Red

New `describe("buildParcelItems with variantsMap")` in the service spec (or a dedicated `helpers.unit.spec.ts` — extract opportunity):

1. Populates `hs_code` when variantsMap has the entry
2. Populates `origin_country` when present
3. Converts `weight` to kg string per `weightUnit`
4. Omits customs fields when variantsMap is absent / empty
5. Omits customs fields for items whose `line_item_id` doesn't map to any order line item

New `describe("createFulfillment with variant customs")`:

6. Reads `order.metadata.sendcloud_variants` and merges into parcel_items
7. Falls back to cycle-04 behaviour when metadata is absent

New `describe("subscriber sendcloud-resolve-variants")`:

8. Resolves Query, fetches variants, calls the enrich workflow with the expected map
9. Handles empty variant_ids gracefully (no workflow call)
10. Skips variant entries that return only null fields

(The subscriber test uses a lightweight container mock: `{ resolve: (key) => queryStub }` where `queryStub.graph` is jest.fn().)

### Green

1. Add types to `src/types/sendcloud-api.ts`
2. Add `readSendcloudVariantsFromOrder` helper
3. Extend `buildParcelItems` signature with `opts.variantsMap` + `opts.weightUnit`
4. Extend `buildShipmentParcel` to forward options
5. Update `createFulfillment` to pass the variantsMap
6. Create `src/workflows/enrich-sendcloud-variants.ts` — a Medusa workflow with one step
7. Create `src/subscribers/sendcloud-resolve-variants.ts`
8. Tests pass

### Refactor

- Helpers file is now large (7 exports + internal). Consider splitting `helpers.ts` into `helpers/address.ts`, `helpers/parcel.ts`, `helpers/validation.ts`. Defer unless the next cycle pushes it further.
- Fixture duplication is now painful. Extract `src/__tests__/fixtures.ts`.

---

## Docs

- **`docs/variant-customs-resolution.md`** — new feature doc; cover architecture, race-window caveat, admin-created order fallback, plugin-option surface
- **`docs/create-fulfillment.md`** — update the "Customs limitation" section: now resolved for `order.placed`-originated orders; manual admin orders still fall back to basics
- **`docs/README.md`** — add the feature + plan
- **NOTES.md** — mark cycle-04 variant-resolution parked item as ✅ resolved; park: "admin-created manual orders skip `order.placed`; customs fields are missing for those until a follow-up cycle adds a re-enrichment path"
- Replace `it.todo("createReturnFulfillment — §3.8")` with... keep it as-is. Returns is still the next cycle.

---

## Critical files to be created or modified

| Path                                                                | Action                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/subscribers/sendcloud-resolve-variants.ts`                     | create                                                                                  |
| `src/workflows/enrich-sendcloud-variants.ts`                        | create                                                                                  |
| `src/providers/sendcloud/helpers.ts`                                | extend `buildParcelItems` + `buildShipmentParcel`; add `readSendcloudVariantsFromOrder` |
| `src/providers/sendcloud/service.ts`                                | call with variantsMap                                                                   |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts`            | variantsMap + metadata-read tests                                                       |
| `src/subscribers/__tests__/sendcloud-resolve-variants.unit.spec.ts` | new — subscriber tests                                                                  |
| `src/types/sendcloud-api.ts`                                        | SendCloudVariantCustomsEntry + SendCloudVariantsMap                                     |
| `docs/variant-customs-resolution.md`                                | create                                                                                  |
| `docs/create-fulfillment.md`                                        | update customs limitation                                                               |
| `docs/README.md`                                                    | index                                                                                   |
| `NOTES.md`                                                          | resolve cycle-04 item; park admin-order gap                                             |

---

## Gate + push

1. `make check && npm run test:unit` — existing 63 + new tests, 1 todo unchanged
2. `npx medusa plugin:build` — still clean
3. Single commit: _"Resolve per-item customs fields via order.placed subscriber + variantsMap"_
4. `git push origin main`

---

## Out of scope (next plans)

- **§3.8 `createReturnFulfillment`** — still the cycle after
- Admin-created / manual-order variant enrichment (the documented gap)
- Other variant fields (material_content, intended_use, mid_code, …)
- §4 webhooks — P0 completion
