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

## Added in cycle 15 (fulfillment creation widget, 2026-04-13)

### Widget submits to standard `/admin/orders/:id/fulfillments`

No new admin route. The widget builds the metadata payload and calls `sdk.admin.order.createFulfillment`. Backend triggers (cycles 12 + 15) read `fulfillment.metadata.sendcloud_parcels` + `fulfillment.metadata.sendcloud_insurance_amount`. Trade-off: admins can also use Medusa's standard "Create fulfillment" button — but they'd need to type metadata as raw JSON via the standard dialog's free-form metadata field. Document the widget as the recommended path.

### Insurance override is per-fulfillment, applies per-parcel

`metadata.sendcloud_insurance_amount` overrides the plugin option for one fulfillment, then propagates to every parcel in multi-collo mode (matching cycle 12's spec interpretation). 3 parcels × override €75 = €225 total coverage. Documented in `fulfillment-widget.md`.

### MVP fulfills all unfulfilled items

No per-item quantity selector. Admin who needs partial fulfillment falls back to Medusa's standard dialog. Acceptable for MVP — most chocolaterie orders are fulfilled in one shot. Add per-item rows when a merchant asks.

`fulfilled_quantity` lives on the nested `item.detail.fulfilled_quantity` (Medusa v2 `OrderItemDTO`), NOT as a top-level field on the line item. The widget reads from the right path post review fix; if Medusa restructures `OrderItemDTO`, the widget shows all items as unfulfilled regardless of prior fulfillments — risk of duplicate fulfillment attempts. Worth re-verifying on each Medusa upgrade.

### Total weight hint is "best effort" and weightless-variant prone

Widget computes a "total weight ~X" hint by summing `item.variant.weight × quantity`. If the variant has no weight set, the hint reads as 0 — could mislead admin. Acceptable since the parcel weight is admin-input anyway; the hint is just a starting point.

### Service point shown read-only

Admin sees the customer-selected service point (`shipping_methods[0].data.service_point_id`) but cannot change it. Changing service points post-checkout would require a refund flow + new shipping method — out of scope and rarely needed.

### React Query invalidation key

Widget invalidates `["orders", order.id]` on success. Matches the convention Medusa's admin uses internally (verified manually in this cycle). If Medusa changes their query keys in a future version, the page won't auto-refresh after creating a fulfillment — admin has to F5. Low risk; revisit on Medusa upgrade.

### No widget-level integration tests

Same rationale as cycles 11 + 14. Plugin build verifies the admin extension compiles. Manual verification path: `npx medusa plugin:build` + sample app + create a fulfillment with single + multi-parcel inputs + insurance override.

---

## Added in cycle 14 (customs validation + admin surfaces, 2026-04-13)

### `defaultFromCountryCode` is the gate for per-fulfillment customs warnings

If the option is unset, the per-fulfillment validation is skipped entirely. Merchants get a single config warning in the settings page instead of dozens of per-fulfillment warnings. Trade-off: a careless merchant might miss the settings warning if they don't visit `/app/settings/sendcloud`. Acceptable — the settings page is the documented landing zone for SendCloud config, and the badge is orange + visible at the top of the page.

### EU country list is hand-maintained

`EU_COUNTRY_CODES` hardcodes the 27 current member states (2026 list). Source comment in `customs-validation.ts` points at europa.eu. Next likely accessions (Albania, North Macedonia, Montenegro) are not before 2027. When the list updates, `EU_COUNTRY_CODES` + tests + docs all need a touch — keep the change atomic.

### `low_total_value` is currency-agnostic

The rule `totalDeclared < 1` reads raw decimal regardless of currency. Catches the common case (€0.50 of free samples, $0 promo items). For high-denomination currencies (JPY ¥10000 ≈ €60), the rule never triggers — acceptable for now since under-declared values are typically near-zero, not realistic-but-low. If a JPY merchant complains, expose `customsMinValueWarning` plugin option.

### Per-variant deduplication, not per-line

`validateCustomsData` walks distinct variant_ids. A 50-line invoice referencing one broken variant produces 2 warnings, not 100. Trade-off: if line A and line B reference the same variant but only line A has unit_price 0, only line A gets the `zero_value_item` warning (correct — the issue is per-line for prices, per-variant for HS code/origin).

### Admin widget reads from AdminOrder.fulfillments[].data

The order details widget uses `DetailWidgetProps<AdminOrder>` — Medusa's standard order DTO already includes `fulfillments[].data` as `Record<string, unknown>`. No new admin endpoint needed; widget is purely client-side rendering. Hidden when no warnings on any fulfillment of the order.

### Admin UI tests still deferred

Cycle 11's stance held: no admin test harness, manual verification via `npx medusa plugin:build` + sample app. Settings section + new widget verified in the build output (admin extensions compiled). Same risk surface as before.

### `config_warnings: []` even when the provider can't be resolved

Dashboard's `not registered` branch returns `config_warnings: []` because we have no `provider.options_` to inspect. The settings page can't tell the difference between "no warnings" and "couldn't compute". Mitigated post-review: settings page also handles `isError` separately, but the `not-registered` branch returns 200 with the empty array, not an error. If a merchant's provider truly isn't registered, they'll see "All required plugin options are configured" — misleading. Acceptable because the Connection section right below shows the actual not-registered error message. Revisit if it confuses someone.

### Stored warnings persist forever

Warnings live on `fulfillment.data` and stay there — even after the merchant fixes the variant data, old fulfillments keep their warnings. This is correct as audit history (the warning describes what shipped, not the variant's current state). If a merchant wants a "clear warnings" admin button, that's a future small cycle.

---

## Added in cycle 13 (return cancellation, 2026-04-13)

### Cancellation is a request, not a guarantee

SendCloud's `PATCH /returns/:id/cancel` returns 202 even when the carrier doesn't support upstream label cancellation — the carrier may still ship the return. Admin needs to confirm via `parent_status` (we surface the immediate value) plus the next webhook update. Documented in `docs/return-cancellation.md`.

### 409 reason extraction parses the wrapped error message

The plugin's client wraps non-2xx into MedusaError with the raw upstream body as a string suffix. `cancelReturn.extractUpstreamMessage` slices from the first `{` and JSON.parses the suffix to read `errors[0].message ?? .detail ?? .title` (post review fix). Any 409 reason SendCloud returns surfaces verbatim. The dependency on the client's prefix shape is still fragile — if the client refactors `buildErrorMessage` to a non-JSON format, our parser silently returns null and the fallback "Return is not cancellable" surfaces. Cheap-fix candidate: have the client surface the parsed `errors[0]` on a structured field of MedusaError instead of stuffing it into the message string.

### `parent_status` follow-up GET is best-effort

If the GET fails (5xx after retries, network blip), we return `parent_status: null` and the PATCH success message stands. Admin can re-fetch the fulfillment after the next webhook for an updated value. The GET failure is silently swallowed (not logged at WARN level) to avoid noise — revisit if merchants report missing `parent_status` consistently.

### Outbound shipment cancel (cycle 04) unchanged

`cancelFulfillment` only branches on the absence of `sendcloud_shipment_id`. All cycle-04 cancel-shipment behavior (POST `/api/v3/shipments/:id/cancel`, 409 → CONFLICT mapping) stays identical. The two paths share no error handling — they target different upstream endpoints with different semantics.

---

## Added in cycle 12 (multi-collo shipments, 2026-04-12)

### Admin trigger is `fulfillment.metadata.sendcloud_parcels`

`POST /admin/orders/:id/fulfillments` body has `metadata` natively. Medusa core attaches it to the fulfillment record; the provider reads `fulfillment.metadata.sendcloud_parcels` from `createFulfillment`'s 4th arg. No new admin route, no workflow hook. Verified via MedusaDocs MCP — `POST /admin/orders/:id/fulfillments` does NOT accept a `data` pass-through (data is copied from shipping_option.data); `POST /admin/fulfillments` does but bypasses the core workflow.

### Parcel items live on parcels[0] only

Spec §8 doesn't say whether line items should be distributed across parcels. MVP keeps all `parcel_items` on the primary parcel; the rest carry only weight + dimensions. Per-parcel item distribution is a §9 follow-up if customers need per-parcel customs declarations.

### Multi-collo capability check every call

`assertCarrierSupportsMulticollo` hits `/api/v3/shipping-options` on every multi-collo fulfillment (~100ms). Not cached this cycle. Add request-scoped or TTL cache if it becomes hot.

### sendcloud_parcel_id stays a scalar pointing at parcels[0]

Cycles 09 (bulk labels) and 10 (single label) keep working unchanged for multi-collo fulfillments — they just download the primary label. Secondary parcel labels live on `fulfillment.data.parcels[i].label_url`. A follow-up cycle can extend the bulk-label route to auto-explode multi-collo fulfillments into their parcel ids.

### Multi-collo returns deferred

Spec §7 only covers single-parcel returns-announce. Cycle 06 already persists `sendcloud_multi_collo_ids[]` from the response for visibility but doesn't split returns on input.

### Async `/api/v3/shipments` endpoint not wired

Sync `announce-with-shipping-rules` caps at 15 parcels. If a merchant needs >15, async `/api/v3/shipments` (up to 50) requires webhook-driven completion polling — defer until a real request lands.

### Aggregate status uses cycle-07 exception id set

Only status.id 80 drives `aggregate_status === "exception"` right now. If SendCloud adds richer exception ids (1500, 1999 are listed in spec §4 but not in our handler), extend both cycle-07 single-parcel AND the multi-collo `computeAggregateStatus` at the same time so the rules stay symmetric.

### Insurance is per-parcel, not per-shipment (matches SendCloud API + spec §10.1)

`defaultInsuranceAmount` applies to **every** parcel in a multi-collo shipment (post review fix). Spec §10.1 says "every parcel is insured automatically", and SendCloud's `additional_insured_price` is a per-parcel field. Effective coverage on a 3-parcel shipment with `defaultInsuranceAmount: 100` is €300 total, not €100. Document this clearly to merchants who configure the option — if anyone needs a per-shipment cap, expose a separate `insuranceMode: "per-shipment" | "per-parcel"` option later.

### Lost-update race window when concurrent parcel webhooks land at SendCloud retry boundaries

Per-parcel `status_updated_at` (post review fix) prevents the over-aggressive false-stale rejection that the shared root timestamp caused. But two truly concurrent webhooks for **different** parcels of the same fulfillment can still clobber each other if Node processes them in parallel: each handler reads `fulfillment.data.parcels[]` from a pre-state snapshot, computes its update, and `updateFulfillmentWorkflow` does a full-replace on `data`. Whichever write lands second carries forward the older snapshot for the parcel it didn't touch. SendCloud webhooks for different parcels are usually seconds apart in practice, and SendCloud retries up to 10× with exponential backoff (5min → 1h) — so the lost update tends to be re-applied on the next retry. A truly safe fix needs DB-level locking (SELECT FOR UPDATE inside a transaction), optimistic concurrency on a version token, or a per-fulfillment serialisation queue — none of which Medusa exposes natively. Park as a known limitation; revisit if a merchant reports stuck parcel statuses.

---

## Added in cycle 11 (admin settings dashboard, 2026-04-12)

### Default sender-address selector deferred

Spec §15.1 also lists a dropdown to pick a default SendCloud sender address. Implementing that needs a persistent plugin-settings store (we don't have one yet — plugin options only come from `medusa-config.ts` at boot). Same story for label-format / label-size preferences. Park until we stand up a settings module.

### No admin-side unit tests

Medusa admin UI testing requires a Vite + Playwright (or React Testing Library + jsdom-compatible admin harness) stack we haven't set up. The React page is a thin wrapper over `/admin/sendcloud/dashboard`, which has 4 backend unit cases (happy path, 401 credentials, provider not registered, upstream 5xx). Deferred until a second admin route lands and the infra cost amortizes.

### Refresh = test-connection

No dedicated "Test connection" button. The initial `useQuery` fetch IS the connection test; `refetch()` on the "Refresh" button is the retry. If SendCloud credentials are rotated, admins click refresh and the dashboard flips green.

### Webhook URL is client-computed

`${window.location.origin}/webhooks/sendcloud` is built in the browser — whatever host the admin is hitting (local.chocolateriedunouveaumonde.com, staging, prod) is exactly the host SendCloud should POST back to. No backend plumbing for the URL. Trade-off: if the admin ever runs on a different hostname than the API (e.g. split admin CDN), this URL becomes wrong. Not a concern today; revisit if we ever split the admin out.

### `fp_sendcloud_sendcloud` container key assumption (reinforced)

Dashboard route resolves the provider via `buildProviderRegistrationKey("sendcloud")` → `fp_sendcloud_sendcloud`. Same fragility flagged in cycle 07: if Medusa renames the base-class convention across versions, this breaks. Keep the helper centralized so the fix is one-file.

---

## Added in cycle 10 (per-fulfillment label shortcut, 2026-04-12)

### ✅ Extracted `buildProviderRegistrationKey` to `registration.ts`

Four callers now import this helper (webhook route, service-points route, bulk-labels route, single-label route). Moved out of `service-points.ts` into a dedicated `src/providers/sendcloud/registration.ts`. The old re-export from `service-points.ts` is kept for one cycle as a soft-deprecation shim — drop in a later cleanup pass.

### Single-label route mirrors bulk behaviour

The per-fulfillment route reuses cycle-09's `requestBinary`, `buildProviderRegistrationKey`, and the 502-wrap pattern. Admin gets identical `Content-Disposition` headers; filename prefixes ISO date + parcel id for on-disk sorting.

### DPI support where bulk doesn't have it

SendCloud's single-parcel endpoint accepts `dpi`, the bulk one doesn't. Single-label route exposes the `dpi` query param; bulk route doesn't. Matches the upstream OpenAPI — not a cycle-09 omission, just a SendCloud API asymmetry.

---

## Added in cycle 09 (bulk label download, 2026-04-12)

### Hard cap of 20 fulfillments per bulk request

SendCloud's `/api/v3/parcel-documents/{type}` caps `parcels[]` at 20 items. We reject >20 with 400 so admins paginate client-side. Server-side batching with ZIP merging is a future cycle — would likely need a pdf-merge library (e.g. `pdf-lib`) or a zip stream.

### Labels only — customs + air waybills deferred

The same upstream endpoint supports `customs-declaration` and `air-waybill` document types. Current route hardcodes `label`. Adding a `document_type` body field is a small follow-up when a customer surfaces the need.

### PDF only — ZPL / PNG deferred

`Accept: application/pdf` hardcoded. ZPL (native thermal-printer format) and PNG are supported by SendCloud but not wired. A plugin option or body param can pick the format later.

### No single-label shortcut route

Admin selecting exactly one fulfillment still goes through the bulk path. A dedicated `GET /admin/sendcloud/labels/{fulfillment_id}` would simplify the client code and let consumers stream without JSON encoding a body. Low priority — bulk works for n=1.

### Array query serialization

`SendCloudClient.buildUrl` uses `URLSearchParams.append` for array values → `?parcels=1&parcels=2&...`. Matches OpenAPI v3 default `style: form, explode: true`. If a SendCloud endpoint ever requires comma-joined arrays (`?parcels=1,2,3`), callers can pre-join into a scalar string.

---

## Added in cycle 08 (service-point lookup, 2026-04-12)

### No TTL cache on service-point lookups

Per SendCloud spec §5.3, service-point IDs are ephemeral — caching beyond a minute or two is incorrect. A future cycle could add a request-scoped in-memory cache (dedupe identical query params within a single HTTP request) but nothing longer-lived.

### Narrow query-param allowlist

Forwards `country`, `postal_code`, `city`, `house_number`, `radius`, `carrier`, `latitude`, `longitude` only. SendCloud accepts ~18 params; the others (`ne_*`, `sw_*`, `pudo_id`, `weight`, `shop_type`, `general_shop_type`, `access_token`) land on demand.

### Basic Auth only

OAuth2 + `access_token` alt auth modes supported by SendCloud aren't wired. Basic Auth reuses the plugin's `publicKey`/`privateKey`.

### No route-level integration test

`parseServicePointsQuery` + `fetchSendcloudServicePoints` are unit-tested with `nock`. The route file is a thin wrapper and not covered by `medusaIntegrationTestRunner` — would require booting Postgres on CI.

---

## Added in cycle 07 (webhook parcel_status_changed + refund_requested, 2026-04-12)

### Integration-lifecycle events log-and-ignore

`integration_connected`, `integration_deleted`, `integration_modified` all return 200 with a debug log. No Medusa-side action. Park until a concrete need (e.g. surface in an admin dashboard) emerges.

### No admin notification channel for exceptions

Status id 80 writes `metadata.sendcloud_exception` but nothing notifies an admin live. A dedicated channel (email, slack, admin widget) is a future cycle.

### No event deduplication store

Relies on timestamp ordering (`fulfillment.data.status_updated_at`) to drop stale SendCloud retries. If two webhooks share an identical timestamp and arrive out of order, behaviour is undefined. Low-probability; add a processed-id store later if it becomes a real failure mode.

### `fp_sendcloud_sendcloud` container key assumption

The route resolves the fulfillment provider by its Medusa-convention key `fp_{identifier}_{id}` to read plugin options. If Medusa changes container-registration naming across versions, route breaks. Short-term fine; if it flickers, introduce a module loader that publishes `sendcloudPluginOptions` under a stable container key.

### Webhook retry policy

SendCloud retries up to 10× with exponential backoff (5min → 1h). We don't implement our own queue — failed processing results in a non-2xx response that SendCloud retries. Document for ops.

### Order-level delivered status sync

`parcel_status_changed` with status.id 11 currently sets `fulfillment.delivered_at` directly via `updateFulfillmentWorkflow`, but does **not** invoke `markOrderFulfillmentAsDeliveredWorkflow` because that workflow requires `orderId` — and `FulfillmentDTO` has no direct `order_id` field, so we'd need either a reverse `query.graph` link traversal (order → shipping_methods → fulfillments) or to stash `order_id` on `fulfillment.data` at `createFulfillment` time. Deferred. Medusa may still auto-propagate the delivered fulfillment to the order status via its own subscribers; worth verifying in production.

---

## Resolved in cycle 07 (2026-04-12)

### ✅ Tracking number / URL for shipments AND returns

Previously parked in cycle 04 and cycle 06. Webhook now populates `fulfillment.data.tracking_number`, `tracking_url`, and `status` via `updateFulfillmentWorkflow` on each `parcel_status_changed` event. Returns share the same parcel-id path so return tracking lands identically.

---

## Added in cycle 06 (createReturnFulfillment, 2026-04-12)

### ~~Tracking number / URL for returns arrive via webhook~~

✅ Resolved in cycle 07. See above.

### Multi-collo returns

Response's `multi_collo_ids[]` is persisted on `fulfillment.data.sendcloud_multi_collo_ids` but only the primary `parcel_id` gets a label entry. Multi-collo split / aggregation is still its own cycle (spec §8).

### ~~Return cancellation~~

✅ Resolved in cycle 13. `cancelFulfillment` now routes return-shaped data to `cancelReturn(client, id)`, which PATCHes `/api/v3/returns/{id}/cancel` and reads `parent_status` via a follow-up GET. See `docs/return-cancellation.md`.

### `send_tracking_emails` opt-out

`createReturnFulfillment` hardcodes `send_tracking_emails: true` on the return payload. A future `sendTrackingEmails` plugin option can default to `true` and let B2B stores opt out.

### Return portal + brand / insurance / refund / reason

Spec §7.1 hosted portal and optional return fields (`total_insured_value`, `return_fee`, `reason`) deferred until a merchant needs them.

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
