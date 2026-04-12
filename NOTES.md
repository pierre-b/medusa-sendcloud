# Internal Notes

Dev-facing notes for contributors. Not shipped — `files` in `package.json` excludes this path.

## Resolved in cycle 01 (getFulfillmentOptions, 2026-04-12)

### ✅ `SendCloudClient.getAuthHeader()` visibility

Flipped to `private buildAuthHeader()` when `request()` was implemented. Authorization header is now asserted indirectly via `nock().matchHeader("authorization", …)` in the request and provider tests.

### ✅ `SendCloudClient.logger` field

Now actively used inside `request()` for debug logging on retries and network errors.

### ✅ `baseUrl` plugin option

Added to `SendCloudPluginOptions` (alongside `maxRetries` and `retryBaseDelayMs`) so integration tests and future test environments can retarget the client.

### ✅ HTTP mock library choice

The plan originally picked `msw/node` on a second-opinion recommendation. In practice `msw` v2.13.2 pulls in `rettime` which is ESM-only, and `@swc/jest` 0.2.36 emits CJS that can't `require()` ESM. After two attempts at `transformIgnorePatterns` workarounds, we fell back to `nock` per the plan's pre-declared guardrail. `nock` works out of the box with Node 20's global `fetch` and `@swc/jest`. See `src/__tests__/setup-nock.ts`.

---

## Added in cycle 02 (validateOption / canCalculate / validateFulfillmentData, 2026-04-12)

### Service-point round-trip to `servicepoints.sendcloud.sc`

`validateFulfillmentData` currently checks the **presence** and **shape** of `data.service_point_id` but does **not** verify the id still resolves on SendCloud's service-points API (`https://servicepoints.sendcloud.sc/api/v2/service-points/{id}`). SendCloud will reject invalid ids at `createFulfillment` time, but earlier surfacing would improve the checkout UX. Deferred to the dedicated service-points cycle per spec §5.

### Weight-range and country-support validation

Spec §3.3 also wants `validateFulfillmentData` to verify the cart total weight is within `weight.min/max` and that the destination country is supported by the chosen option. Both checks need option-data fields we haven't mapped yet (`weight.min/max`, plus a round-trip with `to_country_code` filter), and realistic cart-context fixtures. Deferred.

---

## Added in cycle 03 (calculatePrice, 2026-04-12)

### Multi-parcel splitting

`calculatePrice` aggregates the whole cart into a single parcel (summed weight + cubic bounding box). For heavy or large orders this will under-quote vs. SendCloud's actual multi-collo pricing. Spec §8 covers multicollo — its own cycle once we have a strategy for per-parcel weight/dimension assignments.

### Currency assumption

SendCloud quotes in EUR by default (and the shipping-options snapshot only lists EUR/GBP/USD in the `SendCloudPrice` currency enum). `calculatePrice` returns `Number(value)` without currency conversion; non-EUR stores will see prices in EUR units despite whatever the store currency is. Until we have an FX source, document that the plugin is EUR-first.

### Tax-inclusive quotes

`is_calculated_price_tax_inclusive` is hardcoded `false`. B2B stores running SendCloud quotes tax-inclusive will need a `pricesIncludeTax` plugin option — add when a customer asks.

---

## Resolved in cycle 05 (variant customs resolution, 2026-04-12)

### ✅ Variant resolution for full customs

Cycle-04 gap closed via an `order.placed` subscriber. Plugin resolves Query from the Medusa container, fetches `hs_code`, `origin_country`, and `weight` for every variant in the order, and merges them into `order.metadata.sendcloud_variants`. `buildParcelItems` reads from this metadata at fulfillment time and populates the corresponding SendCloud fields. Customer-placed orders now ship with full customs out of the gate.

Known gap (parked, see below): admin-created manual orders that skip `order.placed` still miss customs.

---

## Added in cycle 05 (variant customs resolution, 2026-04-12)

### Admin-created / manual-order customs gap

Admin creates an order directly (no checkout flow → no `order.placed` event) → subscriber never fires → `order.metadata.sendcloud_variants` stays empty → fulfillment ships without per-item customs. Workarounds for now: re-enrich manually via a custom admin call, or ship internationally only for customer-placed orders. A future cycle can add an explicit re-resolve endpoint / admin button.

### Subscriber race window

`order.placed` emits at checkout completion; the subscriber runs asynchronously. In theory an admin fulfilling an order _during_ the subscriber's Query latency window sees empty metadata. In practice admins fulfil minutes+ after order placement, so we accept the race.

---

## Added in cycle 04 (createFulfillment + cancelFulfillment, 2026-04-12)

### Multi-collo single-parcel assumption

`createFulfillment` builds `parcels: [single_parcel]`. Orders that exceed a carrier's max box weight or dimensions need multi-collo splitting (spec §8). Tracked as a dedicated cycle.

### Label base64 embedding

We persist `label_url` only. Admin needs live SendCloud access to download the PDF. A future `embedLabelAsBase64` option can fetch + embed for offline retrieval, at the cost of one extra HTTP call per fulfillment.

### Partial customs fields on parcel_items

`parcel_items[].price` requires `order.items[].unit_price` to match `line_item_id`. Items created without a matching order line item (rare, but possible in manual workflows) will ship without a price. SendCloud accepts this for EU-internal, rejects for customs.

---

## Still parked

### `noopLogger` test helper duplication

Currently lives in `src/providers/sendcloud/__tests__/service.unit.spec.ts`. Extract to `src/__tests__/noop-logger.ts` the moment a second test file needs it.

### Scaffolder leftovers to reconsider

- `src/admin/i18n/index.ts` — empty `export default {}`. Keep if we plan to localize admin widgets; remove otherwise. Decision deferred until the first admin widget lands.
- Top-level READMEs under `src/{api,jobs,links,modules,providers,subscribers,workflows}/` — scaffolder boilerplate. They don't hurt, but can be trimmed once each folder has real content.

### Retry jitter determinism

`computeBackoffMs` uses `Math.random()` for ±20% jitter. Tests currently pass because `retryBaseDelayMs: 0` collapses jitter to zero; if we ever want to assert exact backoff timings, inject a seeded RNG or expose a `jitter: false` knob.

### Error-mapping breadth

`STATUS_TO_ERROR_TYPE` covers the statuses the spec calls out (400, 401, 403, 404, 409, 422). Other 4xx default to `UNEXPECTED_STATE`. Expand as we see real SendCloud responses in the wild.

---

## Conventions reinforced during cycles

- Every new HTTP client method ships with (a) a unit test that mocks the wire via `nock`, (b) a corresponding doc in `docs/`, (c) a row in the feature checklist index `docs/README.md`.
- Every SendCloud v3 endpoint touched gets its request/response types extracted from the official OpenAPI spec into `src/types/sendcloud-api.ts`. No hand-written types from documentation summaries.
- OpenAPI snapshots are committed verbatim under `docs/openapi-snapshots/` and listed in `.prettierignore` — they are vendor-authoritative and must not be reformatted.
- Each cycle leaves an `it.todo(...)` marker pointing to the next cycle's RED test.
