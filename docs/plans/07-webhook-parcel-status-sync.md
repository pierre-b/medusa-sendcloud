# Plan 07 — Webhook `parcel_status_changed` + `refund_requested` (spec §4)

## Context

P0 completion. Cycles 04-06 push shipments + returns into SendCloud; this cycle closes the loop by consuming SendCloud's webhook back into Medusa's fulfillment status.

**Goal:** `POST /webhooks/sendcloud` receives SendCloud's parcel-level events, verifies HMAC-SHA256, and:

- `parcel_status_changed` → updates the matching `fulfillment.data` with `{ status, tracking_number, tracking_url, status_updated_at }`. When the parcel's v2 status id is `11` (DELIVERED), invoke Medusa's `markOrderFulfillmentAsDeliveredWorkflow` so the order moves to delivered.
- `refund_requested` → flag the matching fulfillment's `metadata.sendcloud_refund_requested = { timestamp, reason? }` for admin visibility.
- Any other known or unknown event → log at debug, respond 200 OK so SendCloud stops retrying.

### User decisions (confirmed)

- **Events this cycle:** `parcel_status_changed` + `refund_requested`. Lifecycle events (integration_connected/deleted/modified) log-and-200; future cycle.
- **Signature policy:** reject with **401** if `options.webhookSecret` is not configured. Strict by default; admins set it when registering the webhook URL in the SendCloud dashboard.
- **Fulfillment lookup:** `query.graph` on `fulfillment`, filter in memory by `data.sendcloud_parcel_id === payload.parcel.id`. Plugin option `webhookLookbackDays` (default **60**) bounds the query to fulfillments created within the window, keeping the scan proportional to recent activity.

### Scope constraints

- Idempotency via **timestamp ordering** only. Payload's `timestamp` vs `fulfillment.data.status_updated_at` — skip if incoming ≤ stored.
- No event deduplication store. SendCloud retries up to 10× with backoff; a stale retry simply no-ops because its timestamp trails the one already stored.
- No admin UI notification channel for exceptions (status 80) — just the metadata flag. Dedicated notifications/channels cycle later.
- No webhook retry queue in the plugin — we trust SendCloud's retries. If our workflow call throws transiently, SendCloud retries.

---

## External API verification (spec §4.2, §4.3)

### Request

- **URL:** `POST /webhooks/sendcloud`
- **Signature header:** `Sendcloud-Signature` — HMAC-SHA256 of the **raw body** using `webhookSecret`. Lowercase hex.
- **Body (JSON):**
  ```json
  {
    "action": "parcel_status_changed" | "refund_requested" | ...,
    "timestamp": 1525271885993,
    "parcel": {
      "id": 12345,
      "tracking_number": "3SYZXG132912330",
      "status": { "id": 1000, "message": "Ready to send" },
      "order_number": "ORD12334",
      "external_reference": "order_abc123",
      ...
    }
  }
  ```
  The `parcel` object shape is v2-format (numeric status id + message). SendCloud emits webhooks in v2 format even for shipments created via v3 — verified in spec §4.3 and cross-checked against SendCloud's webhook docs.

### Status mapping (v2 id → Medusa action)

Only **delivered** triggers a workflow this cycle. All other statuses are stored verbatim on `fulfillment.data.status` for admin visibility; no Medusa-side side effect.

| v2 ID     | Meaning                 | Action                                                                                                               |
| --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `11`      | Delivered               | call `markOrderFulfillmentAsDeliveredWorkflow(container).run({ input: { id: fulfillment.id } })` after updating data |
| `80`      | Exception               | persist status; `fulfillment.metadata.sendcloud_exception = { timestamp, message }`                                  |
| any other | miscellaneous in-flight | persist status + tracking fields; no workflow                                                                        |

---

## Plugin options added

| Option                | Type     | Default | Purpose                                                 |
| --------------------- | -------- | ------- | ------------------------------------------------------- |
| `webhookLookbackDays` | `number` | `60`    | Upper bound (in days) for the fulfillment query window. |

`webhookSecret` is already declared in plugin options since cycle 01; first real use.

---

## Behaviour spec

### `processSendcloudWebhook(container, input)`

Pure async function — separates from the HTTP route for testability.

```ts
type WebhookInput = {
  signature: string | undefined;
  rawBody: Buffer | string;
  payload: unknown;
};

type WebhookResult = {
  status: 200 | 202 | 401;
  message: string;
};

export async function processSendcloudWebhook(
  container: MedusaContainer,
  options: SendCloudPluginOptions,
  input: WebhookInput
): Promise<WebhookResult>;
```

Flow:

1. **Signature check:**
   - `options.webhookSecret` missing/empty → `401` `"medusa-sendcloud: webhookSecret plugin option is required"`
   - `signature` header missing → `401`
   - `verifySendcloudSignature(rawBody, signature, secret)` fails → `401`
2. **Parse payload:** reject malformed JSON (shouldn't happen, middleware handles parsing) → `200` with debug log.
3. **Route by `payload.action`:**
   - `parcel_status_changed` → `handleParcelStatusChanged(container, payload, options)`
   - `refund_requested` → `handleRefundRequested(container, payload, options)`
   - other → `200` with debug log
4. Return `{ status: 200, message: "ok" }`.

### `handleParcelStatusChanged(container, payload, options)`

1. Resolve `parcel_id = payload.parcel?.id` — if missing/non-number, `200` + debug log ("payload missing parcel.id").
2. Query fulfillments via `query.graph`:
   ```ts
   query.graph({
     entity: "fulfillment",
     filters: { created_at: { $gte: since } }, // since = now - webhookLookbackDays
     fields: ["id", "data", "canceled_at", "delivered_at"],
   });
   ```
3. Filter in memory: `fulfillment.data?.sendcloud_parcel_id === parcel_id`. No match → `200` with debug log.
4. **Timestamp ordering:** if `fulfillment.data.status_updated_at >= payload.timestamp`, skip (`200`, debug log "older webhook").
5. Call `updateFulfillmentWorkflow(container).run({ input: { id: fulfillment.id, data: { status: parcel.status, tracking_number: parcel.tracking_number, tracking_url: payload.parcel.tracking_url, status_updated_at: payload.timestamp } } })`. Medusa shallow-merges `data`.
6. If `parcel.status?.id === 11` and `!fulfillment.delivered_at`, call `markOrderFulfillmentAsDeliveredWorkflow(container).run({ input: { id: fulfillment.id } })`.
7. If `parcel.status?.id === 80`, extend the updateFulfillment payload with `metadata: { ...existing, sendcloud_exception: { timestamp, message: parcel.status.message } }`.

### `handleRefundRequested(container, payload, options)`

1. Resolve parcel_id, find fulfillment (same pattern).
2. Shallow-merge `metadata.sendcloud_refund_requested = { timestamp: payload.timestamp, reason: payload.refund_reason ?? null }` via `updateFulfillmentWorkflow`.
3. Return `200`.

### `verifySendcloudSignature(rawBody, signature, secret)`

Pure function:

```ts
import crypto from "node:crypto";

export const verifySendcloudSignature = (
  rawBody: Buffer | string,
  signatureHeader: string,
  secret: string
): boolean => {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? rawBody : rawBody)
    .digest("hex");
  const provided = Buffer.from(signatureHeader, "hex");
  const computed = Buffer.from(digest, "hex");
  return (
    provided.length === computed.length &&
    crypto.timingSafeEqual(provided, computed)
  );
};
```

`timingSafeEqual` prevents timing side-channels. Length-mismatch guard prevents the throw.

---

## Route — `src/api/webhooks/sendcloud/route.ts`

Minimal wrapper over `processSendcloudWebhook`:

```ts
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { processSendcloudWebhook } from "../../../subscribers/sendcloud-webhook-handler";
// … resolve plugin options from the provider (see below)

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const result = await processSendcloudWebhook(req.scope, options, {
    signature: req.headers["sendcloud-signature"] as string | undefined,
    rawBody: req.rawBody as Buffer,
    payload: req.body,
  });
  res.status(result.status).json({ message: result.message });
};
```

### Resolving plugin options inside the route

Options are registered on the fulfillment provider, not directly on the container. The route resolves the fulfillment provider by its identifier, reads the options:

```ts
const provider = req.scope.resolve("fp_sendcloud_sendcloud");
const options = provider.options_ as SendCloudPluginOptions;
```

If that resolution is fragile across Medusa versions, fall back to a module loader that registers `sendcloudPluginOptions` in the container at boot. **Decision for this cycle:** use the provider-resolve path. If Medusa's container key naming changes, swap to a loader in a follow-up.

---

## TDD sequence

### Red

New `src/subscribers/__tests__/sendcloud-webhook-handler.unit.spec.ts` — 10+ cases (no HTTP boot, all via mocked container):

1. `verifySendcloudSignature` — helper unit tests: valid, mismatch, length-mismatch, empty secret
2. Processor rejects 401 when `webhookSecret` is empty
3. Processor rejects 401 when signature header missing
4. Processor rejects 401 when signature doesn't verify
5. Processor routes `parcel_status_changed` → updates matching fulfillment via workflow
6. Processor calls `markOrderFulfillmentAsDeliveredWorkflow` when status.id === 11
7. Processor flags `sendcloud_exception` metadata when status.id === 80
8. Processor skips older-timestamp webhooks
9. Processor returns 200 + debug log when no matching fulfillment found
10. Processor handles `refund_requested` → updates `metadata.sendcloud_refund_requested`
11. Processor returns 200 + debug log for unknown actions

### Green

1. Add `webhookLookbackDays` to `plugin-options.ts`
2. Add `SendcloudWebhookPayload`, `SendcloudWebhookStatus` types to `sendcloud-api.ts`
3. Add `verifySendcloudSignature` to `helpers.ts`
4. Create `src/subscribers/sendcloud-webhook-handler.ts` exporting `processSendcloudWebhook` (subscribers folder because it's container-driven glue; file name is `sendcloud-webhook-handler.ts`, not a subscriber in the Medusa sense — subscriber convention but this file has no default subscriber export)
5. Create `src/api/webhooks/sendcloud/route.ts`
6. Tests pass

**File placement note:** `processSendcloudWebhook` is NOT a Medusa subscriber; it's a container-aware handler called from an API route. Put it under `src/providers/sendcloud/webhook-handler.ts` to keep plugin-provider-specific code grouped. The route imports from there.

### Refactor

- Re-run the 5 Ultrathink passes
- Consider extracting workflow-call wrappers (`updateFulfillmentData`, `markDelivered`) for future-cycle reuse. Defer.

---

## Docs

- **`docs/webhook-sync.md`** — endpoint URL, HMAC setup instructions, event coverage, plugin options, error responses, how the SendCloud dashboard webhook should be configured
- **`docs/create-fulfillment.md`** — mention that tracking_number / tracking_url / delivered_at land via the webhook
- **`docs/create-return-fulfillment.md`** — same mention (plus note that return tracking also syncs through this path)
- **`docs/README.md`** — feature + plan index
- **NOTES.md** — mark "tracking_number arrives via webhook" (cycle 06 parked) as ✅ resolved; park lifecycle events, admin notification channels, dedicated event queue
- Replace `it.todo("parcel_status_changed webhook — §4")` with `it.todo("service-point lookup storefront route — §5")`

---

## Critical files to be created or modified

| Path                                                             | Action                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/api/webhooks/sendcloud/route.ts`                            | create                                                                       |
| `src/providers/sendcloud/webhook-handler.ts`                     | create — exports `processSendcloudWebhook`                                   |
| `src/providers/sendcloud/helpers.ts`                             | add `verifySendcloudSignature`                                               |
| `src/providers/sendcloud/__tests__/webhook-handler.unit.spec.ts` | create                                                                       |
| `src/types/sendcloud-api.ts`                                     | `SendcloudWebhookPayload`, `SendcloudParcelStatus`, `SendcloudWebhookAction` |
| `src/types/plugin-options.ts`                                    | `webhookLookbackDays`                                                        |
| `docs/webhook-sync.md`                                           | create                                                                       |
| `docs/create-fulfillment.md`                                     | cross-link                                                                   |
| `docs/create-return-fulfillment.md`                              | cross-link                                                                   |
| `docs/README.md`                                                 | index                                                                        |
| `NOTES.md`                                                       | move tracking-via-webhook item to resolved; new parked items                 |

---

## Gate + push

1. `make check && npm run test:unit` — existing 78 + ~11 new = 89 green, 1 todo
2. `npx medusa plugin:build` — clean
3. Single commit: _"Add parcel_status_changed + refund_requested webhook handler with HMAC-SHA256"_
4. `git push origin main`

---

## Out of scope (next plans)

- **Integration lifecycle webhooks** (`integration_connected/deleted/modified`) — dedicated log-only cycle when operational needs surface
- **§5 service-point storefront lookup** — next cycle target (storefront picks a pickup point before checkout)
- **Admin UI widget** for tracking / exception flags
- **Return cancellation via PATCH /api/v3/returns/{id}/cancel** — pair naturally with future webhook extensions
- **Event deduplication store** (idempotency key → processed timestamp) — we rely on timestamp ordering for now
