# Plan 11 — Admin settings page (spec §15.1)

## Context

First UI cycle. Gives admins a dedicated `/app/sendcloud` page showing whether the plugin is talking to SendCloud, what the webhook URL is, and which carrier-service combinations are currently enabled on the connected account.

**Goal:**

- Backend: `GET /admin/sendcloud/dashboard` — returns `{ connected, error?, shipping_options[] }` (single round-trip per page load).
- Frontend: `src/admin/routes/sendcloud/page.tsx` — React UI route registered in the sidebar. Uses `@medusajs/ui` primitives + `@tanstack/react-query` (pre-installed) + `sdk.client.fetch`.

### User decision (cycle scope)

- Connection status + webhook URL + carrier/method list.
- Default-sender-address dropdown and label-preferences editor stay deferred (would require a persistent settings store we don't have).

### Scope constraints

- No write operations — pure dashboard read.
- Webhook URL is computed **client-side** from `window.location.origin` (the admin visiting the page already has the right host). No backend plumbing for the URL.
- No admin-side unit tests — Medusa admin UI testing requires a test runner stack we haven't set up. Backend cases cover the data shape; the React page is a thin wrapper we verify manually.

---

## Backend — `GET /admin/sendcloud/dashboard`

### Endpoint

Admin-auth via Medusa session. Returns **200 always** with a result body; connection failures are embedded rather than HTTP errors so the UI can render both states without a separate error path.

```ts
type DashboardResponse = {
  connected: boolean;
  error?: string;
  shipping_options: SendCloudShippingOption[];
};
```

### Implementation

New module `src/providers/sendcloud/dashboard.ts` exporting `fetchDashboardSnapshot(container, providerKey)`:

1. Resolve the fulfillment provider (cycle 07 pattern) — if not registered, return `{ connected: false, error: "...", shipping_options: [] }`.
2. Call `provider.client_.request<SendCloudShippingOptionsResponse>({ method: "POST", path: "/api/v3/shipping-options", body: {} })` — same shape as `getFulfillmentOptions` (cycle 01).
3. On 200: `{ connected: true, shipping_options: response.data ?? [] }`.
4. On `MedusaError`:
   - `UNAUTHORIZED` / `FORBIDDEN` → `{ connected: false, error: "SendCloud rejected the API credentials (<reason>)", shipping_options: [] }`.
   - Anything else: `{ connected: false, error: message, shipping_options: [] }`.

The route at `src/api/admin/sendcloud/dashboard/route.ts` is a thin wrapper that calls `fetchDashboardSnapshot` and returns `res.json(...)`.

### Tests

`src/providers/sendcloud/__tests__/dashboard.unit.spec.ts` — 4 cases:

1. Happy path — nock returns v3 shipping-options data → `{ connected: true, shipping_options }`
2. 401 upstream → `{ connected: false, error: /credentials/i, shipping_options: [] }`
3. Provider not registered → `{ connected: false, error: /not registered/i, shipping_options: [] }`
4. Other upstream failure (500 after retries) → `{ connected: false, error, shipping_options: [] }`

---

## Frontend — `/app/sendcloud`

### Files

| Path                                  | Role                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `src/admin/lib/sdk.ts`                | Instantiates `Medusa` SDK client once per bundle                               |
| `src/admin/routes/sendcloud/page.tsx` | UI route, default export + `defineRouteConfig` + `useQuery` for dashboard data |

### SDK file

```ts
import Medusa from "@medusajs/js-sdk";

export const sdk = new Medusa({
  baseUrl: import.meta.env.VITE_MEDUSA_BACKEND_URL ?? "/",
  debug: false,
  auth: { type: "session" },
});
```

Admin pages run under the Medusa admin Vite bundle — `import.meta.env.VITE_MEDUSA_BACKEND_URL` is the standard env var. Falls back to `"/"` so relative paths work when the admin is served by the same host as the API.

### Page component

Renders:

1. **Header** — "SendCloud" title + brief description
2. **Connection card**:
   - Green badge "Connected" when `connected: true`
   - Red badge "Disconnected" + error text when `connected: false`
3. **Webhook card** — copyable code block showing `${window.location.origin}/webhooks/sendcloud` with a "Copy URL" button (uses `navigator.clipboard.writeText`)
4. **Carriers card** — table grouped by carrier (code + name), with rows showing each shipping-option code + name + whether service-point pickup is required. Hidden when `shipping_options` is empty with a friendly empty-state.

`defineRouteConfig({ label: "SendCloud", icon: Package })` — `Package` from `@medusajs/icons`.

Uses `@tanstack/react-query`:

```ts
const { data, isLoading, error } = useQuery({
  queryKey: ["sendcloud-dashboard"],
  queryFn: () =>
    sdk.client.fetch<DashboardResponse>("/admin/sendcloud/dashboard"),
});
```

### Admin UI testing

Deferred. Medusa admin testing needs a Vite/Playwright stack that's larger than this cycle's appetite. The page is a thin wrapper over well-tested backend data.

---

## Critical files to be created or modified

| Path                                                       | Action       |
| ---------------------------------------------------------- | ------------ |
| `src/providers/sendcloud/dashboard.ts`                     | create       |
| `src/api/admin/sendcloud/dashboard/route.ts`               | create       |
| `src/providers/sendcloud/__tests__/dashboard.unit.spec.ts` | create       |
| `src/admin/lib/sdk.ts`                                     | create       |
| `src/admin/routes/sendcloud/page.tsx`                      | create       |
| `docs/admin-settings.md`                                   | create       |
| `docs/README.md`                                           | index        |
| `NOTES.md`                                                 | parked items |

---

## Gate + push

1. `make check && npm run test:unit` — existing 132 + 4 new green, 1 todo
2. `npx medusa plugin:build` — also builds the admin extensions; must succeed
3. Single commit: _"Add admin SendCloud dashboard page with connection + carrier list"_
4. `git push origin main`

---

## Out of scope

- Default sender address selector (needs persistent settings store)
- Label format / size preferences
- Test-connection button (the initial `useQuery` fetch IS the test; react-query's `refetch()` handles retry)
- Order detail widget (§15.2) — separate cycle
- Fulfillment widget (§15.3) — separate cycle
- Admin UI tests (needs test infra)
