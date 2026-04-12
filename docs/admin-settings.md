# Admin SendCloud Dashboard — `/app/settings/sendcloud`

Implements spec §15.1. A dedicated admin page that surfaces integration health at a glance: whether the plugin is reaching SendCloud, the webhook URL to paste into SendCloud's own admin, and the list of carrier services currently enabled on the connected account.

## Flow

```
Admin opens /app/settings/sendcloud
  → React route mounts, useQuery kicks off GET /admin/sendcloud/dashboard
  → plugin resolves the fulfillment provider from the container
  → plugin POSTs /api/v3/shipping-options on SendCloud with an empty filter
  → SendCloud returns the enabled shipping-options list
  → route responds { connected: true, shipping_options: [...] }
  → UI renders connection badge + webhook URL + table grouped by carrier
```

Webhook URL is computed **client-side** from `window.location.origin` — the admin user is already hitting the correct host, so no backend round-trip is needed.

## Backend — `GET /admin/sendcloud/dashboard`

Admin session auth (automatic on `/admin/*`).

### Response shape

Always `200 OK` with a JSON body; failures are embedded so the UI can render both states without a separate error path.

```ts
type DashboardResponse = {
  connected: boolean;
  error?: string;
  shipping_options: SendCloudShippingOption[];
};
```

| `connected` | `error`                                                                         | Meaning                                                                          |
| ----------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `true`      | undefined                                                                       | SendCloud accepted the credentials and returned shipping options                 |
| `false`     | `medusa-sendcloud: SendCloud rejected the API credentials (...)`                | Upstream 401/403                                                                 |
| `false`     | `medusa-sendcloud: fulfillment provider not registered in the Medusa container` | Plugin loaded but provider not registered in `medusa-config.ts` `modules:` block |
| `false`     | any other message                                                               | Upstream 5xx, network error, or unexpected failure                               |

### Upstream

`POST /api/v3/shipping-options` with `{}` body — same endpoint as `getFulfillmentOptions` (§3.1). See `docs/openapi-snapshots/shipping-options.yaml`.

## Frontend — `/app/settings/sendcloud`

Mounted under Settings via `defineRouteConfig({ label: "SendCloud" })`. File path `src/admin/routes/settings/sendcloud/page.tsx` — Medusa auto-nests any `src/admin/routes/settings/*` route under the Settings page.

### Sections

1. **Connection** — green "Connected" badge on success; red "Disconnected" + `error` text otherwise
2. **Webhook URL** — copyable code block showing `${window.location.origin}/webhooks/sendcloud`. Paste into SendCloud → Settings → Integrations → Webhooks. The plugin verifies HMAC-SHA256 against the configured `webhookSecret` (spec §4, cycle 07)
3. **Enabled carriers** — grouped table (one sub-heading per carrier) listing shipping-option `code`, `name`, and a "Required" badge on the service-point column when `requirements.is_service_point_required` is true

Refresh button calls `refetch()` — the `useQuery` retry IS the "test connection" action.

## Implementation

- `src/providers/sendcloud/dashboard.ts` — `fetchDashboardSnapshot(container, providerKey)` resolves the provider, calls shipping-options, maps credential errors to a friendly string
- `src/api/admin/sendcloud/dashboard/route.ts` — thin `GET` wrapper returning the snapshot
- `src/admin/lib/sdk.ts` — single `Medusa` SDK instance for admin routes (session auth, `VITE_MEDUSA_BACKEND_URL` fallback)
- `src/admin/routes/settings/sendcloud/page.tsx` — React page using `@medusajs/ui` and `@tanstack/react-query`

## Tests

`src/providers/sendcloud/__tests__/dashboard.unit.spec.ts` — 4 cases:

- Happy path: nock returns v3 shipping-options → `{ connected: true, shipping_options }`
- 401 upstream → `{ connected: false, error: /credentials/, shipping_options: [] }`
- Provider not registered → `{ connected: false, error: /not registered/, shipping_options: [] }`
- Other upstream failure (500 after retries) → `{ connected: false, error, shipping_options: [] }`

Admin UI itself is a thin wrapper over well-tested backend data — Medusa admin testing would need a Vite/Playwright stack that's out of scope for this cycle.

## Out of scope (tracked in `NOTES.md`)

- Default sender-address dropdown (needs a persistent settings store)
- Label format / size preferences editor (same reason)
- Test-connection button (the initial `useQuery` fetch is the test; `refetch()` is the retry)
- Order detail widget (§15.2)
- Fulfillment widget (§15.3)
