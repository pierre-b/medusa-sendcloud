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
