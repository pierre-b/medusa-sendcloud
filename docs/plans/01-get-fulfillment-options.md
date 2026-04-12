# Plan 01 — `getFulfillmentOptions` (spec §3.1)

## Context

First real feature cycle. The foundation is in place; the `it.todo("returns SendCloud shipping methods from getFulfillmentOptions")` marker in `src/providers/sendcloud/__tests__/service.unit.spec.ts` is the hand-off point.

**Goal:** the Medusa admin can list a SendCloud carrier's available shipping methods when creating a shipping option under Settings → Locations.

**Why:** this is the first endpoint any admin workflow touches — every later cycle (`validateOption`, `createFulfillment`, etc.) depends on the provider having a working authenticated HTTP client and at least one round-trip to SendCloud. Implementing it first proves the resilience layer end-to-end.

**Scope (narrow, per user decision):** spec §3.1 only. `validateOption` (§3.2), `canCalculate` (§3.5), `calculatePrice` (§3.4), etc. are deferred to their own plan cycles.

**Resilience scope (wide, per user decision):** the HTTP client that backs this method ships with full spec §18 behaviour — Basic Auth, JSON body, 429 and 5xx retry with exponential backoff, `Retry-After` support, SendCloud error → `MedusaError` mapping. Every subsequent endpoint benefits.

---

## Prerequisites

0. **Push the foundation.** The two local commits (`034240e`, `e537830`) need to land on `github.com/pierre-b/medusa-sendcloud`. Once the user has created the empty repo, run `git push -u origin main`. CI should then go green on its first run.

---

## External API verification (per CLAUDE.md)

SendCloud publishes per-domain OpenAPI YAML files. The relevant one is confirmed accessible:

- `https://sendcloud.dev/.openapi/v3/shipping-options/openapi.yaml` (HTTP 200, 88 KB)

**First step of the cycle:** download and snapshot the spec at `docs/openapi-snapshots/shipping-options.yaml` (commit the snapshot so future reviewers can diff against it).

### What the v3 spec actually says (verified against the real OpenAPI file)

The spec doc in `chocolaterie/docs/medusa-sendcloud-plugin-spec.md` §3.1 used fields that **do not exist** in v3 (`sendcloud_shipping_method_id`, `min_weight`/`max_weight` flat, `service_point_input` enum, `countries[]`). Before writing any code, override those assumptions with what the real spec says:

**Endpoint:** `POST https://panel.sendcloud.sc/api/v3/shipping-options` (operationId `sc-public-v3-scp-post-shipping_options`). The neighbouring `POST /api/v3/fetch-shipping-options` is **deprecated as of 2026-01-14** — do not use it.

**Request body** (`shipping-option-filter`) — every field optional; for `getFulfillmentOptions()` we POST `{}`. Full list (for later cycles): `from_country_code`, `to_country_code`, `from_postal_code`, `to_postal_code`, `to_service_point`, `parcels[]`, `functionalities`, `carrier_code`, `contract_id`, `shipping_product_code`, `shipping_option_code`, `lead_time`, `calculate_quotes`.

**Response** — `{ data: ShippingOption[] | null, message: string | null }`. Each `ShippingOption` has:

- `code` (string, e.g. `"postnl:standard/signature"`) — the stable identifier we key off of
- `name` (string, human-readable)
- `carrier: { code, name }`
- `product: { code, name }`
- `functionalities` — rich object with ~40 flags (`b2c`, `tracked`, `insurance`, `last_mile`, `signature`, `multicollo`, `service_area`, …)
- `contract: { id, client_id, carrier_code, name }`
- `weight: { min: { value: string, unit }, max: { value: string, unit } }` — values are strings, not numbers
- `max_dimensions: { length, width, height, unit }` — strings
- `parcel_billed_weights[]`
- `requirements: { fields[], export_documents: boolean, is_service_point_required: boolean }` — real home of service-point requirement, NOT `service_point_input`
- `charging_type` (e.g. `"label_creation"`)
- `quotes[]` — only populated when both country codes + parcels + `calculate_quotes: true` are sent (irrelevant for `getFulfillmentOptions()`)

**Mapping to Medusa `FulfillmentOption`** — the spec allows `[k: string]: unknown`, so we key off `code` and preserve the fields we'll need downstream:

```ts
{
  id: `sendcloud_${option.code}`,
  name: option.name,
  sendcloud_code: option.code,
  sendcloud_carrier_code: option.carrier.code,
  sendcloud_product_code: option.product.code,
  sendcloud_requires_service_point: option.requirements.is_service_point_required,
  sendcloud_functionalities: option.functionalities,
}
```

(Verified against `@medusajs/types/dist/fulfillment/provider.d.ts` — `FulfillmentOption = { id: string; is_return?: boolean; [k: string]: unknown }`.)

---

## HTTP mocking — `msw/node`

Per second-opinion review:

- `jest.spyOn(global, 'fetch')` — painful for Web API `Headers`/`ReadableStream` assertions, and a global spy pollutes `medusaIntegrationTestRunner` later
- `nock` — historically brittle against `undici` (Node's fetch backend)
- **`msw/node` (chosen)** — Web-API-native handlers, `http.post(url, handler, { once: true })` composes cleanly for "429 then 200" retry tests, `onUnhandledRequest: "bypass"` lets the future integration test runner coexist, handlers become a living SendCloud contract reusable across the 15-ish endpoints on the roadmap

### Setup

- `npm install --save-dev msw`
- `src/__tests__/mocks/server.ts` — `setupServer(...handlers)` with a default handler registry per SendCloud domain
- `src/__tests__/mocks/handlers/shipping-options.ts` — the handlers for this cycle
- `src/__tests__/setup-msw.ts` — `beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }))`, `afterEach(() => server.resetHandlers())`, `afterAll(() => server.close())`
- Wire via `jest.config.js` → **`setupFilesAfterEnv: ["./src/__tests__/setup-msw.ts"]`** (NOT `setupFiles` — that runs before the test framework and can't use `beforeAll`/`afterEach`; NOT `setupFilesAfterEach` — no such option). Source: `jest-config/build/ValidConfig.js`.
- The file path `src/__tests__/mocks/server.ts` does not match the `*.unit.spec.ts` testMatch pattern, so Jest will import it as a module without trying to run it as a test file.

### Risk flag

`@swc/jest` + `msw` v2 have historically required `transformIgnorePatterns` adjustments because `msw` v2 ships as ESM internally (`@mswjs/interceptors`, `outvariant`, `@bundled-es-modules/*`). If `require()` from the setup file fails with a module-not-found or unexpected-token error, fix by adding:

```js
transformIgnorePatterns: [
  "/node_modules/(?!(msw|@mswjs|@bundled-es-modules|outvariant|headers-polyfill|strict-event-emitter)/)",
];
```

Verify compatibility as the first action after `npm install msw` — if it breaks, fall back to `nock` rather than spending the cycle on Jest config tuning.

---

## Rate-limit / retry semantics (spec §18)

SendCloud limits: safe ops 1000/min, unsafe ops 100/min + 15/sec burst.

`SendCloudClient.request()` implements:

- Up to **3 retries** on HTTP `429` or any `5xx`
- Backoff: honour `Retry-After` header (seconds) when present; otherwise exponential — `200 ms, 600 ms, 1800 ms` with a small ±20 % jitter to avoid thundering herd
- Fail fast on `4xx` other than `429` — no retry
- Final failure → `MedusaError`, mapped by status:
  - `400`, `422` → `INVALID_DATA`
  - `401` → `UNAUTHORIZED`
  - `403` → `FORBIDDEN`
  - `404` → `NOT_FOUND`
  - `409` → `CONFLICT`
  - `429` after retries exhausted → `UNEXPECTED_STATE` (we did our best)
  - `5xx` after retries exhausted → `UNEXPECTED_STATE`
  - Network errors / abort → `UNEXPECTED_STATE`
  - (Full palette available: `DB_ERROR, DUPLICATE_ERROR, INVALID_ARGUMENT, INVALID_DATA, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, NOT_ALLOWED, UNEXPECTED_STATE, CONFLICT` — verified from `@medusajs/utils/dist/common/errors.d.ts`)
- Tests use `jest.useFakeTimers()` + `jest.advanceTimersByTimeAsync(...)` so no real wall-clock wait

---

## TDD sequence

Each step may be one commit or bundled into a single logical commit — preference is one bundled commit per logical change (`"Implement getFulfillmentOptions with SendCloud v3 client + retries"`), not one per phase.

1. **Snapshot the OpenAPI spec and install `msw`.**
   - `curl https://sendcloud.dev/.openapi/v3/shipping-options/openapi.yaml -o docs/openapi-snapshots/shipping-options.yaml`
   - `npm install --save-dev msw`
   - Commit: _"Snapshot SendCloud shipping-options OpenAPI v3 spec; add msw for HTTP mocking"_

2. **Extract types from the snapshot into `src/types/sendcloud-api.ts`.**
   - `ShippingOptionsFilter` (request body)
   - `ShippingOptionV3` (each element of the response `data[]`)
   - Any enum unions (`ServicePointInput`, `Carrier`, …) needed this cycle

3. **RED — resilience tests for `SendCloudClient.request()`.**
   - `src/services/__tests__/sendcloud-client.request.unit.spec.ts`
   - Cases: 200 happy path parses JSON; 429 + `Retry-After` → retry → 200; 500 → exponential backoff → 200; three consecutive 500s → `MedusaError` with captured body; 400 → immediate `MedusaError` no retry; network error → `MedusaError`
   - Assert outbound: method, path, `Authorization` header, `Content-Type: application/json`, serialized body
   - `npm run test:unit` → confirm red

4. **RED — `getFulfillmentOptions` behaviour test.**
   - Unskip the `it.todo` in `src/providers/sendcloud/__tests__/service.unit.spec.ts`
   - msw handler returns a two-element `data[]` fixture shaped per the OpenAPI snapshot (copy `ShippingOptions` example verbatim from the spec and trim to two entries)
   - Provider returns `FulfillmentOption[]` with the mapping defined in the "External API verification" section above (`id: sendcloud_${code}`, plus preserved v3 fields)
   - Also assert outbound request: `POST /api/v3/shipping-options`, empty JSON body `{}`, `Authorization: Basic <b64>` header
   - `npm run test:unit` → confirm red

5. **GREEN — implement `SendCloudClient.request()`.**
   - `fetch(url, { method, headers, body })`
   - `Authorization: this.getAuthHeader()` — **flip `getAuthHeader()` from `public` to `private` in the same commit** (per foundation NOTES.md parked item). Delete the existing direct-assertion unit test in `sendcloud-client.unit.spec.ts` and replace it with an msw handler that reads `request.headers.get("Authorization")` — asserting via the outbound header is more realistic and survives the visibility change.
   - Retry loop + backoff + `Retry-After` handling
   - Error mapping per the status-code table above, with translated user-facing messages (spec §18.3)

6. **GREEN — implement `SendCloudFulfillmentProvider.getFulfillmentOptions()`.**
   - Override the inherited "must be overridden" stub
   - Call `request()`, map response, return

7. **REFACTOR.**
   - Extract any duplicated URL-building / header logic
   - Re-run the five Ultrathink passes from `CLAUDE.md`
   - Clean up any dead code or stray `any`

8. **Docs.**
   - `docs/fulfillment-options.md` — feature doc: purpose, flow, endpoint + request/response, error cases, config flags touched
   - Update `docs/README.md` feature index
   - Update `NOTES.md` — mark "`getAuthHeader()` visibility" resolved, add the next parked items surfaced during implementation
   - Add a fresh `it.todo("validates the selected option exists in SendCloud — §3.2")` as the hand-off to the next cycle

9. **Gate and commit.**
   - `make check && make test-unit`
   - Bundled commit: _"Implement getFulfillmentOptions with resilient SendCloud v3 client"_
   - `git push origin main` — CI runs for real on this commit

---

## Critical files to be created or modified

| Path                                                           | Action                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `docs/openapi-snapshots/shipping-options.yaml`                 | create (snapshot)                                                                   |
| `src/types/sendcloud-api.ts`                                   | populate with v3 types extracted from snapshot                                      |
| `src/services/sendcloud-client.ts`                             | implement `request()`, flip `getAuthHeader()` to `private`                          |
| `src/services/__tests__/sendcloud-client.request.unit.spec.ts` | new — resilience behaviour                                                          |
| `src/services/__tests__/sendcloud-client.unit.spec.ts`         | update auth-header test to go through a request spy once `getAuthHeader` is private |
| `src/providers/sendcloud/service.ts`                           | override `getFulfillmentOptions()`                                                  |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts`       | unskip `it.todo`, add assertion                                                     |
| `src/__tests__/mocks/server.ts`                                | msw server                                                                          |
| `src/__tests__/mocks/handlers/shipping-options.ts`             | msw handlers                                                                        |
| `src/__tests__/setup-msw.ts`                                   | jest lifecycle wire-up                                                              |
| `jest.config.js`                                               | reference the msw setup file                                                        |
| `docs/fulfillment-options.md`                                  | feature doc                                                                         |
| `docs/README.md`                                               | feature index                                                                       |
| `NOTES.md`                                                     | update parked items                                                                 |
| `package.json`                                                 | add `msw` devDependency                                                             |

---

## Verification

1. `make check` — zero errors
2. `npm run test:unit` — all existing tests plus 6-ish new resilience tests plus 1 new behaviour test all green
3. `npx medusa plugin:build` — builds into `.medusa/server/`
4. Manual end-to-end — yalc-publish to `chocolaterie/medusa/`, register the provider with real sandbox SendCloud keys, boot admin, navigate to Settings → Locations → Shipping, create a shipping option, confirm the dropdown lists real SendCloud methods
5. Inspect network tab (or backend logs) to confirm a single `POST /api/v3/shipping-options` with the correct `Authorization` header

---

## Out of scope (next plans)

- §3.2 `validateOption` — next cycle
- §3.5 `canCalculate`
- §3.3 `validateFulfillmentData` — checkout-side
- §3.4 `calculatePrice` — checkout-side
- §3.6 `createFulfillment` — the big one; likely gets multiple plans
- Service-point lookup, webhooks, returns, multi-collo, admin UI, i18n, etc. — each its own plan
