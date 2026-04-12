# Plan 08 — Service-point lookup storefront route (spec §5)

## Context

P1 next target. Customers picking a **service point / PUDO** (pick-up, drop-off) at checkout need to see available carrier pickup locations near their address. Spec §5 documents the flow: the storefront queries our plugin, which proxies to SendCloud's service-points API.

**Goal:** `GET /store/sendcloud/service-points?country=NL&postal_code=1012AB&carrier=postnl&radius=2000` — proxies to `GET https://servicepoints.sendcloud.sc/api/v2/service-points?...`, returns the normalized service-point list as JSON to the storefront.

**Why now:** the `it.todo("service-point lookup storefront route — §5")` marker is the outstanding hand-off. Cycle 02's `validateFulfillmentData` already plumbs `sendcloud_service_point_id` through to `createFulfillment` (§3.6 cycle 04 wires it into the request body) — but until today, the storefront has no way to present options for the customer to pick from.

### Scope constraints (pragmatic defaults)

- **Proxy-only**. No caching, no persistence, no database. Service-point IDs are ephemeral per spec §5.3 — a short in-memory TTL (if ever needed) would land as a follow-up.
- **Whitelist of query params**: `country` (required), `postal_code`, `city`, `house_number`, `radius`, `carrier`, `latitude`, `longitude`. Other less-useful params (`ne_latitude`, `sw_latitude`, `weight`, `shop_type`, `pudo_id`, `access_token`, `general_shop_type`) stay deferred — add on demand.
- **Pass-through response**: we forward SendCloud's JSON response as-is under `{ service_points: [...] }`. Not re-shaping fields lets storefronts use SendCloud's documented schema directly.
- **No authentication forwarding** beyond Basic Auth for now. The spec notes `access_token` + OAuth2 variants exist but Basic Auth is the main path, and our client already carries those credentials.

---

## External API verification

### `GET https://servicepoints.sendcloud.sc/api/v2/service-points`

Snapshot committed at `docs/openapi-snapshots/service-points.yaml` (1291 lines, sha256 `e8f99b5b…`). Verified:

- **Base URL:** `https://servicepoints.sendcloud.sc/api/v2` (different subdomain from the main `panel.sendcloud.sc` — motivates the per-request `baseUrl` override on our `SendCloudClient.request()`).
- **Required query param:** `country` (ISO 3166-1 alpha-2).
- **Auth:** HTTP Basic supported alongside OAuth2 and `access_token`. We reuse the plugin's `publicKey`/`privateKey`.
- **Response:** array of service-point objects with `id`, `code`, `name`, `street`, `house_number`, `postal_code`, `city`, `latitude`, `longitude`, `email`, `phone`, `homepage`, `carrier`, `country`, `formatted_opening_times`, `open_tomorrow`, `open_upcoming_week`, `distance`, and richer metadata (`extra_data`, `shop_type`, `general_shop_type`, `is_active`).

### What to forward vs. drop

**Accepted** from the storefront query string (each is optional unless marked):

| Param          | Medusa route query   | SendCloud query | Notes                                                 |
| -------------- | -------------------- | --------------- | ----------------------------------------------------- |
| `country`      | `country` (required) | `country`       | ISO 3166-1 alpha-2, validated to 2 upper-case letters |
| `postal_code`  | `postal_code`        | `postal_code`   | max 12 chars                                          |
| `city`         | `city`               | `city`          |                                                       |
| `house_number` | `house_number`       | `house_number`  |                                                       |
| `radius`       | `radius`             | `radius`        | integer, meters                                       |
| `carrier`      | `carrier`            | `carrier`       | e.g. `"postnl"` — filters to one carrier              |
| `latitude`     | `latitude`           | `latitude`      | string, decimal                                       |
| `longitude`    | `longitude`          | `longitude`     | string, decimal                                       |

All other SendCloud params (`ne_*`, `sw_*`, `pudo_id`, `weight`, `shop_type`, etc.) are accepted as **unknown, ignored**. We don't forward them — allowlist only. This tightens the public surface and means a future cycle that wants `pudo_id` support is a one-line addition.

---

## Behaviour spec

### Route `src/api/store/sendcloud/service-points/route.ts`

```ts
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const options = resolvePluginOptions(req.scope); // reuse cycle-07 path
  const query = parseServicePointsQuery(req.query); // validates + filters
  if (!query.ok) return res.status(400).json({ message: query.error });

  const result = await fetchSendcloudServicePoints(
    req.scope,
    options,
    query.value
  );
  res.status(result.status).json(result.body);
};
```

### `parseServicePointsQuery(raw)`

Pure helper in `helpers.ts`:

1. `country` required, must be a 2-char string; coerce to upper-case → else `{ ok: false, error: "country must be a 2-letter ISO code" }`
2. Walk the whitelist: `postal_code`, `city`, `house_number`, `radius`, `carrier`, `latitude`, `longitude` — string-coerce, drop blank/undefined
3. `radius` parsed as integer; non-numeric → drop (don't 400 — the SendCloud request just omits it)
4. Return `{ ok: true, value: ServicePointsQuery }`

### `fetchSendcloudServicePoints(container, options, query)`

In `src/providers/sendcloud/service-points.ts`:

```ts
export async function fetchSendcloudServicePoints(
  container: MedusaContainer,
  options: SendCloudPluginOptions,
  query: ServicePointsQuery
): Promise<{ status: 200 | 502; body: unknown }>;
```

1. Resolve the fulfillment provider from the container → same path as cycle 07, to reuse the already-constructed `SendCloudClient`.
2. Call `client.request({ method: "GET", path: "/api/v2/service-points", query, baseUrl: "https://servicepoints.sendcloud.sc" })` — **requires extending `SendCloudClient.request()`** to accept a per-request `baseUrl` override.
3. Response is a plain array; wrap as `{ service_points: response }` for storefront convenience.
4. Client errors (4xx/5xx) are already mapped to `MedusaError` by `request()` — wrap as `{ status: 502, body: { message } }` so the storefront sees a clear "upstream failed" rather than a raw 500.

### `SendCloudClient.request()` extension

Add `baseUrl?: string` to `SendCloudRequestInit`. In `buildUrl`, prefer `init.baseUrl` over `this.baseUrl` when present. Non-breaking; all existing callers keep the default.

### Query serialization

`SendCloudClient.request()` already supports the `query` param — it appends values via `URLSearchParams`. Reuse as-is.

---

## Types

New in `src/types/sendcloud-api.ts`:

```ts
export type SendCloudServicePointsQuery = {
  country: string;
  postal_code?: string;
  city?: string;
  house_number?: string;
  radius?: number;
  carrier?: string;
  latitude?: string;
  longitude?: string;
};

export type SendCloudServicePoint = {
  id: number;
  code: string;
  name: string;
  street: string;
  house_number: string;
  postal_code: string;
  city: string;
  latitude: string;
  longitude: string;
  email?: string;
  phone?: string;
  homepage?: string;
  carrier: string;
  country: string;
  formatted_opening_times?: Record<string, string[]>;
  open_tomorrow?: boolean;
  open_upcoming_week?: boolean;
  distance?: number;
  is_active?: boolean;
  shop_type?: string | null;
  general_shop_type?: string | null;
  extra_data?: Record<string, unknown>;
};
```

---

## TDD sequence

### Red

`src/providers/sendcloud/__tests__/service-points.unit.spec.ts` (pure-function + nock-backed):

1. `parseServicePointsQuery` — missing `country` → `ok: false`
2. `parseServicePointsQuery` — 1-char or 3-char country → `ok: false`
3. `parseServicePointsQuery` — coerces country to upper-case
4. `parseServicePointsQuery` — drops blank strings, undefined, and non-numeric `radius`
5. `parseServicePointsQuery` — allowed params pass through
6. `fetchSendcloudServicePoints` — happy path — nock asserts outbound URL contains `https://servicepoints.sendcloud.sc/api/v2/service-points?country=NL&...`, returns 200 with wrapped body
7. `fetchSendcloudServicePoints` — upstream 401 → returns `{ status: 502, body: { message: /.../ } }`
8. `fetchSendcloudServicePoints` — network error → `{ status: 502 }`

We deliberately **don't** boot the Medusa HTTP runner — pure-function testing is cheap, and the route file is a thin glue layer. If CI needs a route-level integration test later, it's a separate cycle.

### Green

1. Extend `SendCloudRequestInit` with `baseUrl?: string`; honour in `SendCloudClient.buildUrl`
2. Add `SendCloudServicePoint` + `SendCloudServicePointsQuery` to `sendcloud-api.ts`
3. Add `parseServicePointsQuery` helper
4. Create `src/providers/sendcloud/service-points.ts` — exports `fetchSendcloudServicePoints`
5. Create `src/api/store/sendcloud/service-points/route.ts`
6. Tests pass

### Refactor

- Re-run the 5 Ultrathink passes
- Consider extracting the provider-options-from-container path into a shared helper (repeated in cycle 07's webhook route and now cycle 08) — defer unless a third caller appears

---

## Docs

- **`docs/service-points.md`** — storefront integration guide + query params + response shape + an example React+SDK snippet
- **`docs/README.md`** — feature index + snapshot list (`service-points.yaml`)
- **`docs/create-fulfillment.md`** — cross-link to service-points as the source of `sendcloud_service_point_id` that feeds §3.3 `validateFulfillmentData`
- **NOTES.md** — park TTL caching, unused query params, OAuth2 / access_token auth variants
- Replace `it.todo("service-point lookup storefront route — §5")` with `it.todo("bulk label download — §6.3")` or `it.todo("admin settings widget — §15.1")` depending on appetite

---

## Critical files to be created or modified

| Path                                                            | Action                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `docs/openapi-snapshots/service-points.yaml`                    | commit snapshot (already downloaded)                                |
| `src/types/sendcloud-api.ts`                                    | `SendCloudServicePointsQuery`, `SendCloudServicePoint`              |
| `src/services/sendcloud-client.ts`                              | extend `SendCloudRequestInit` with `baseUrl?`; honour in `buildUrl` |
| `src/providers/sendcloud/helpers.ts`                            | `parseServicePointsQuery`                                           |
| `src/providers/sendcloud/service-points.ts`                     | create — exports `fetchSendcloudServicePoints`                      |
| `src/api/store/sendcloud/service-points/route.ts`               | create                                                              |
| `src/providers/sendcloud/__tests__/service-points.unit.spec.ts` | create                                                              |
| `docs/service-points.md`                                        | create                                                              |
| `docs/README.md`                                                | feature + snapshot index                                            |
| `NOTES.md`                                                      | parked items                                                        |

---

## Gate + push

1. `make check && npm run test:unit` — existing 94 + ~8 new green, 1 todo
2. `npx medusa plugin:build` — clean
3. Single commit: _"Proxy storefront service-point lookups to SendCloud v2"_
4. `git push origin main`

---

## Out of scope (next plans)

- In-memory TTL cache for service-point queries (§5.3 warns IDs are ephemeral — caching more than a few minutes is wrong)
- Bulk label download (§6.3)
- Admin settings widget (§15.1)
- Tests covering the HTTP route wiring via `medusaIntegrationTestRunner` — adds a Postgres dependency on CI
- Expanding `SendCloudServicePointsQuery` to the full ~18-param surface documented on SendCloud's API
