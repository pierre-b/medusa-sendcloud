# Internal Notes

Dev-facing notes for contributors. Not shipped — `files` in `package.json` excludes this path.

## Parked items from foundation review (2026-04-12)

These are intentional reservations — not blockers on foundation, but should be addressed before 1.0.

### `SendCloudClient.getAuthHeader()` visibility

Currently `public` so the foundation unit test can assert the header value directly. Once `SendCloudClient.request()` is implemented and can be spy-tested via `fetch`, flip `getAuthHeader()` to `private` and assert auth indirectly (via the `Authorization` header on the outbound request).

Tracked location: `src/services/sendcloud-client.ts` → `getAuthHeader()`.

### `SendCloudClient.logger` field

Declared and assigned in the constructor but never read yet. Reserved for `request()` logging (rate-limit hits, 5xx retries, structured debug logs). Keep the field — removing and re-adding during the next TDD cycle is pure churn.

### `noopLogger` test helper duplication

Two test files (`service.unit.spec.ts` and future `sendcloud-client.unit.spec.ts` extensions) will build their own `noopLogger` stub. Extract to `src/__test-utils__/noop-logger.ts` the moment a second site copies it.

### `baseUrl` plugin option

`SendCloudPluginOptions` does not expose `baseUrl`. The client already accepts it. Consider adding `baseUrl?: string` to `SendCloudPluginOptions` once integration tests need to hit a local mock server (e.g. `nock`, `msw`, or a WireMock container).

### Scaffolder leftovers to reconsider

- `src/admin/i18n/index.ts` — empty `export default {}`. Keep if we plan to localize admin widgets; remove otherwise. Decision deferred until the first admin widget lands.
- Top-level READMEs under `src/{api,jobs,links,modules,providers,subscribers,workflows}/` — scaffolder boilerplate. They don't hurt, but can be trimmed once each folder has real content.

---

## Conventions reinforced during foundation

- Every new HTTP client method ships with (a) a unit test that mocks `fetch`, (b) a corresponding doc in `docs/`, (c) a row in the feature checklist index `docs/README.md`.
- Every SendCloud v3 endpoint touched gets its request/response types extracted from the official OpenAPI spec into `src/types/sendcloud-api.ts`. No hand-written types from documentation summaries.
