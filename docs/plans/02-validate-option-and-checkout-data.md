# Plan 02 — `validateOption` + `canCalculate` + `validateFulfillmentData` (spec §3.2, §3.5, §3.3)

## Context

Cycle 01 landed `getFulfillmentOptions`: admin can list SendCloud shipping options. This cycle closes the admin-create + checkout-time validation gap so those options can actually be picked and carried through to a cart.

**Goal:** three provider methods, three Medusa lifecycle hooks:

- **§3.2 `validateOption(data)`** — fires when admin saves a new shipping option. Confirms the `sendcloud_code` still exists on the SendCloud side.
- **§3.5 `canCalculate(data)`** — fires for `type: "calculated"` options. We always return `true` because the v3 shipping-options endpoint can quote every option.
- **§3.3 `validateFulfillmentData(optionData, data, context)`** — fires at checkout when a customer selects a shipping method. Ensures service-point requirements are met; returns the enriched data that will be persisted on the shipping method.

**Why bundled:** all three share the same input shape (option's `data` property produced by `getFulfillmentOptions` in cycle 01), have no net-new dependencies, and their tests reuse the existing nock setup. Landing them together gives Medusa admins and customers a functional end-to-end dry run without a payment integration.

**Scope constraint:** weight-range and country-support validation inside `validateFulfillmentData` are explicitly **out of scope** — spec §3.3 lists them but they need extra option-data fields we haven't mapped yet (`weight.min`, `weight.max`, country list). A follow-up cycle adds them once we have stronger cart-context fixtures.

---

## Prerequisites

None. The OpenAPI snapshot at `docs/openapi-snapshots/shipping-options.yaml` already covers both endpoints this cycle needs, and `nock` is wired up.

---

## External API verification

Re-using the `POST /api/v3/shipping-options` endpoint from cycle 01. The request body for `validateOption` uses the `shipping_option_code` filter field (optional in the `shipping-option-filter` schema, already typed in `src/types/sendcloud-api.ts`):

```ts
{
  shipping_option_code: "postnl:standard/signature";
}
```

SendCloud returns:

- `{ data: [ShippingOption], message: null }` if the code resolves
- `{ data: [], message: "…" }` if it doesn't

**Decision:** `validateOption` returns `true` iff `response.data` contains at least one option whose `code` strictly equals the input code. A defensive equality check (rather than trusting non-empty data) guards against SendCloud's fuzzy-matching behaviour.

`validateFulfillmentData` does **not** round-trip to SendCloud in this cycle — the only required check (service-point presence) is answerable from `optionData.sendcloud_requires_service_point` that cycle 01 already persisted.

---

## Behaviour specs

### `validateOption(data: Record<string, unknown>): Promise<boolean>`

- Extract `sendcloud_code` as string. If missing, non-string, or empty → throw `MedusaError.Types.INVALID_DATA` with message `medusa-sendcloud: option data is missing sendcloud_code`.
- Call `client_.request({ method: "POST", path: "/api/v3/shipping-options", body: { shipping_option_code: code } })`.
- Return `true` iff `response.data?.some((option) => option.code === code)`.
- Any `MedusaError` thrown by the client propagates (a 401 shouldn't be swallowed as "option invalid").

### `canCalculate(_data): Promise<boolean>`

- Unconditionally `return true`. Per spec §3.5 — we always support SendCloud's quote engine.

### `validateFulfillmentData(optionData, data, _context): Promise<Record<string, unknown>>`

- Extract `optionData.sendcloud_code` (string). If missing → throw `INVALID_DATA`.
- Extract `optionData.sendcloud_requires_service_point` (boolean, optional — treat `undefined` as `false`).
- If `sendcloud_requires_service_point === true`:
  - Extract `data.service_point_id`. If missing, non-string/non-number, or empty → throw `INVALID_DATA` with message referencing the carrier-service combination.
  - Return `{ ...data, sendcloud_service_point_id: String(data.service_point_id) }` — the string coercion lets storefronts pass either the SendCloud numeric id or the carrier's alphanumeric id verbatim.
- Otherwise return `data` unchanged (optionally stripped of an accidental `service_point_id`? No — trust the payload).

The Medusa contract types `validateFulfillmentData`'s return as `Promise<any>`; we tighten to `Promise<Record<string, unknown>>` in our override.

---

## TDD sequence

One bundled commit at the end. Intermediate commits only if a phase gets large enough to review separately.

### Red

1. **`validateOption` tests** (new describe block in `src/providers/sendcloud/__tests__/service.unit.spec.ts`):
   - returns `true` when SendCloud response contains a matching code
   - returns `false` when response `data` is empty
   - returns `false` when response contains options but none match the requested code (defensive equality)
   - throws `INVALID_DATA` when `data.sendcloud_code` is missing
   - throws `INVALID_DATA` when `data.sendcloud_code` is an empty string
   - propagates client error type (401 → `UNAUTHORIZED`) without catching

2. **`canCalculate` test:**
   - returns `true` for any `data` (pass a minimal `{ id: "so_x" }`)

3. **`validateFulfillmentData` tests:**
   - returns `data` unchanged when option does not require service point
   - returns `{ ...data, sendcloud_service_point_id: "…" }` when required and present
   - throws `INVALID_DATA` when required but `service_point_id` missing
   - throws `INVALID_DATA` when `optionData.sendcloud_code` missing (sanity input check)

Run tests → expect all new ones red.

### Green

1. Override `validateOption`, `canCalculate`, `validateFulfillmentData` on `SendCloudFulfillmentProvider`.
2. Add one helper: `readSendCloudCode(data: Record<string, unknown>): string` that extracts + throws on missing. Reused by `validateOption` and `validateFulfillmentData`.
3. Re-run tests → green.

### Refactor

- Consider moving `SHIPPING_OPTIONS_PATH` from `service.ts` into a shared constants file once a second provider method needs it. Defer if only two sites use it.
- Rerun the five Ultrathink passes from `CLAUDE.md`.

---

## Docs

- **`docs/validate-option.md`** — new feature doc: purpose, flow, endpoint, error cases, covers `validateOption` and `canCalculate` together since they're both admin-time hooks
- **`docs/validate-fulfillment-data.md`** — new feature doc for the checkout-time hook; includes the service-point requirement table and the scope-deferred weight/country items
- **`docs/README.md`** — add both entries to the feature index, under the existing §3.1 row
- **NOTES.md** — add any newly surfaced parked items; the noopLogger duplication watch point is likely hit by `service.unit.spec.ts` growing, so consider extraction here
- **`it.todo`** hand-off — replace the `§3.2 validateOption` todo with `it.todo("returns quote price for calculatePrice — §3.4")` pointing to the next cycle

---

## Critical files to be created or modified

| Path                                                     | Action                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/providers/sendcloud/service.ts`                     | Override `validateOption`, `canCalculate`, `validateFulfillmentData`; add `readSendCloudCode` helper |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts` | Add three describe blocks + replace the `§3.2` todo with `§3.4`                                      |
| `src/types/sendcloud-api.ts`                             | No change — `shipping_option_code` filter field already typed                                        |
| `docs/validate-option.md`                                | create                                                                                               |
| `docs/validate-fulfillment-data.md`                      | create                                                                                               |
| `docs/README.md`                                         | add feature entries                                                                                  |
| `NOTES.md`                                               | update parked items if extraction happens                                                            |

---

## Gate + push

1. `make check && npm run test:unit` — all green, new tests included
2. `npx medusa plugin:build` still clean
3. Single commit: _"Implement validateOption, canCalculate, validateFulfillmentData"_
4. `git push origin main` — CI runs on the commit

---

## Out of scope (next plans)

- **§3.4 `calculatePrice`** — the quote engine. Next cycle's RED test marker.
- **§3.3 weight/country validation** — needs option-data fields we haven't mapped yet.
- **§3.6 `createFulfillment`** — the big one. Likely multiple plans.
- Service-point storefront lookup API (spec §5) — separate cycle.
