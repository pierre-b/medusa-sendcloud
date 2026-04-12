# medusa-sendcloud — Medusa v2 Fulfillment Plugin

## Overview

Standalone Medusa v2 plugin that provides a SendCloud fulfillment module provider: shipping rates, label generation, tracking, returns, multi-collo, service points, and admin UI. Published to npm and consumed by Medusa applications via `medusa-config.ts`.

Feature spec (authoritative source of truth): see the sibling repo at `../chocolaterie/docs/medusa-sendcloud-plugin-spec.md`.

```
medusa-sendcloud/
├── src/
│   ├── providers/sendcloud/    # Fulfillment Module Provider (index.ts + service.ts)
│   ├── services/               # SendCloud HTTP client
│   ├── api/
│   │   ├── middlewares.ts      # preserveRawBody for /webhooks/*
│   │   ├── admin/              # Admin API routes
│   │   ├── store/              # Storefront API routes
│   │   └── webhooks/           # SendCloud webhook receivers
│   ├── subscribers/            # order.placed, order.fulfillment_created, etc.
│   ├── workflows/              # Business logic with rollback
│   ├── admin/                  # Admin UI widgets & routes
│   └── types/                  # Plugin options + SendCloud API types
├── integration-tests/http/     # HTTP integration tests
├── docs/                       # Feature docs (keep up to date on every change)
├── .github/workflows/          # CI
├── Makefile                    # Single CLI entry point
├── jest.config.js
├── medusa-sendcloud package exports: ./providers/*, ./workflows, ./admin, ./*
```

## Makefile — Single Entry Point

All CLI operations go through the Makefile. Run `make help` for the full list.

| Command                 | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `make dev`              | Watch + rebuild + republish to local yalc registry |
| `make build`            | `medusa plugin:build`                              |
| `make publish-local`    | `medusa plugin:publish` (yalc)                     |
| `make lint`             | ESLint with autofix                                |
| `make format`           | Prettier                                           |
| `make check`            | Full CI gate (lint + format check + type check)    |
| `make test`             | Run all tests (unit + integration + http)          |
| `make test-unit`        | Unit tests only                                    |
| `make test-integration` | Module integration tests                           |
| `make test-http`        | HTTP integration tests                             |
| `make clean`            | Remove build artifacts                             |

When adding new scripts, add a Makefile target — never leave a command undocumented.

---

## Consumer Registration

In a consuming Medusa app's `medusa-config.ts`:

```ts
module.exports = defineConfig({
  plugins: [{ resolve: "medusa-sendcloud", options: {} }],
  modules: [
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          { resolve: "@medusajs/medusa/fulfillment-manual", id: "manual" },
          {
            resolve: "medusa-sendcloud/providers/sendcloud",
            id: "sendcloud",
            options: {
              publicKey: process.env.SENDCLOUD_PUBLIC_KEY,
              privateKey: process.env.SENDCLOUD_PRIVATE_KEY,
              // …
            },
          },
        ],
      },
    },
  ],
});
```

Both entries are required: `plugins:` loads API routes, subscribers, workflows, and admin extensions; `modules:` attaches the provider to the Fulfillment Module. The stored provider ID follows the base-class convention `fp_{identifier}_{id}` → `fp_sendcloud_sendcloud`.

---

## Development Methodology: TDD

Every feature and bugfix follows Red-Green-Refactor:

1. **Red** — write a failing test first. The test MUST fail before any implementation code is written.
2. **Green** — write the minimum implementation to make the test pass.
3. **Refactor** — clean up while keeping tests green. Run the affected test suite after.

### Test file conventions

- Unit tests: `src/**/__tests__/**/*.unit.spec.ts`
- Module integration tests: `src/modules/*/__tests__/**/*.spec.ts`
- HTTP integration tests: `integration-tests/http/*.spec.ts`
- Use `@medusajs/test-utils` (`medusaIntegrationTestRunner`) for integration tests

### What to test

- Every provider method (`getFulfillmentOptions`, `validateOption`, `validateFulfillmentData`, `calculatePrice`, `canCalculate`, `createFulfillment`, `cancelFulfillment`, `createReturnFulfillment`, document methods): happy path, error path, edge cases
- Every SendCloud client method: request shape, auth, error mapping, retries
- Webhook route: HMAC signature verification (valid, invalid, missing), event dispatch, timestamp ordering
- Every workflow step: happy path, compensation, idempotency
- Every subscriber: triggers on the correct event, calls the expected workflow
- If it has a branch, test both paths

### TDD hand-off marker

Use `it.todo(...)` in a `__tests__/` file to mark the next RED test. A follow-up feature session turns the todo into an `it(...)` that fails, then makes it pass.

---

## Linting & Formatting

- **ESLint**: `eslint.config.mjs` — TypeScript recommended, warn on `any`, error on unused vars (ignores `^_`)
- **Prettier**: `.prettierrc` — 2-space indent, semicolons, double quotes, 80-char width, trailing commas ES5
- Run `make check` before committing. Zero warnings policy.
- Never disable lint rules silently. Discuss first.

---

## Documentation (`docs/`)

Every feature MUST have a corresponding doc in `docs/`. When code changes, update the doc in the same changeset.

A feature doc includes:

- Purpose & motivation
- API endpoints exposed (method, path, request/response)
- Provider methods touched
- Workflows and steps
- Admin UI customizations
- Plugin option flags relevant to the feature

The `docs/README.md` index must list every feature doc.

---

## Code Review Protocol: Double-Check Ultrathink

Every piece of code MUST pass self-review before presenting to the user.

### Pass 1 — Correctness

- [ ] Does it do what was asked? Re-read the original request.
- [ ] Edge cases handled? (null, empty, duplicate, concurrent)
- [ ] Types strict? No `any`, no unsafe casts.
- [ ] All new code paths have tests?
- [ ] Medusa patterns followed? (query MedusaDocs MCP if unsure)

### Pass 2 — Security

- [ ] No hardcoded secrets (use plugin options from env)
- [ ] Webhook HMAC verified with `crypto.timingSafeEqual`
- [ ] Admin routes protected (automatic under `/admin/*`)
- [ ] Storefront routes validated + require publishable API key (automatic under `/store/*`)
- [ ] Input validation on every user-facing endpoint
- [ ] Error responses don't leak internals (SendCloud raw errors must be translated)

### Pass 3 — Quality

- [ ] Readable without comments (rename > comment)
- [ ] No dead code, no commented-out code, no stale TODOs
- [ ] Single responsibility per function / file
- [ ] Naming consistent with codebase
- [ ] No premature abstractions

### Pass 4 — Medusa-Specific

- [ ] Provider service extends `AbstractFulfillmentProviderService` and sets `static identifier`
- [ ] Module provider exported via `ModuleProvider(Modules.FULFILLMENT, { services: [...] })`
- [ ] Plugin exports in `package.json` intact (`./providers/*`, `./workflows`, `./admin`, `./package.json`)
- [ ] Business logic in workflows, not routes or services
- [ ] Cross-module data via links or `query.graph()`, never direct service calls
- [ ] Admin widgets use correct injection zones (e.g., `order.details.side.after`)
- [ ] Webhook route under `/webhooks/*` with `preserveRawBody: true`
- [ ] HTTP methods are GET / POST / DELETE only (never PUT / PATCH — Medusa convention)

### Pass 5 — Documentation

- [ ] Feature doc in `docs/` created or updated
- [ ] `docs/README.md` index updated
- [ ] Makefile target added if a new command was introduced
- [ ] This CLAUDE.md updated if a convention or folder was added

### If any check fails → fix before presenting. No disclaimers, no known issues left behind.

---

## External API Verification

SendCloud exposes an OpenAPI spec. When working on any SendCloud API integration:

1. **Fetch the raw OpenAPI/Swagger spec first** — `WebFetch` the YAML/JSON URL, then `grep`/`Read` the downloaded file for exact field names, types, required status, enum values.
2. **Never rely on web search summaries or agent-summarized docs** — every AI summarization layer loses precision (drops enum values, confuses field names, wrong types).
3. **Compare mechanically** — extract field from source spec, extract field from our code, diff. Don't ask a model "does this look right?"
4. **If no machine-readable spec exists for an endpoint, say so explicitly** — don't present secondary sources as verified facts.

Applies to: writing integration code, verifying payloads, reviewing API responses, debugging SendCloud errors.

---

## Agent Skills

- Use `medusa-dev:building-with-medusa` for provider service, workflows, API routes
- Use `medusa-dev:building-admin-dashboard-customizations` for admin widgets and routes
- Use the MedusaDocs MCP tool (`ask_medusa_question`) before implementing any Medusa-specific pattern
- Use `medusa-dev:db-generate` / `db-migrate` only if models are added (foundation has none)

---

## Git Conventions

- Commit messages: imperative mood, explain "why"
- One logical change per commit
- Never commit `.env`, `node_modules/`, `.medusa/`
- Run `make check && make test-unit` before every commit
- Never skip hooks (`--no-verify`) or amend pushed commits

---

## Plugin Options

Consult `src/types/plugin-options.ts` for the authoritative list. Values come from the consumer's `medusa-config.ts` options object.

| Option                   | Required | Purpose                                         |
| ------------------------ | -------- | ----------------------------------------------- |
| `publicKey`              | yes      | SendCloud API public key                        |
| `privateKey`             | yes      | SendCloud API private key                       |
| `defaultSenderAddressId` | no       | Default sender address in SendCloud             |
| `webhookSecret`          | no       | HMAC secret for webhook verification            |
| `labelFormat`            | no       | `"pdf"` or `"zpl"` (default `"pdf"`)            |
| `labelSize`              | no       | `"a4"` or `"a6"` (default `"a6"`)               |
| `defaultInsuranceAmount` | no       | Auto-apply insurance (EUR, min 2)               |
| `enableReturns`          | no       | Enable return label generation (default true)   |
| `enableServicePoints`    | no       | Enable PUDO service-point flow (default true)   |
| `syncTrackingToOrder`    | no       | Auto-update Medusa order from tracking webhooks |
| `brandId`                | no       | SendCloud brand ID for multi-brand setups       |
| `environment`            | no       | `"live"` or `"test"`                            |
