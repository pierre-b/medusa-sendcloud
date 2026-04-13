# Plan 15 — Fulfillment creation widget (spec §15.3)

## Context

Cycle 12 enabled multi-collo via `fulfillment.metadata.sendcloud_parcels`, but the only way to populate it today is curl + raw JSON. This cycle adds an admin-friendly form on the order details page so admins can create SendCloud fulfillments with parcel splits + per-shipment insurance without leaving the dashboard.

### User decisions

- **Coexistence:** the new widget renders a "Create SendCloud fulfillment" button **alongside** Medusa's standard "Create fulfillment" button. Admins choose. Our button opens our own form modal/inline, then POSTs to the standard `/admin/orders/:id/fulfillments` endpoint with metadata pre-built. Standard Medusa button stays untouched.
- **MVP scope (3 fields):** parcel split table, service point display (read-only), insurance amount override.
- **Deferred:** sender address override (needs a new SendCloud sender-address API + cache; bigger than the rest combined), shipping method override (order's method is fixed at checkout), per-item quantity selector (MVP fulfills all unfulfilled items).

### Constraints

- Form sends the standard Medusa fulfillment payload — no new admin route. Reuses the cycle 12 trigger (`fulfillment.metadata.sendcloud_parcels`).
- Widget zone: `order.details.side.after` (stacks below the cycle 14 customs warnings widget).
- Service point info is read-only from the order's `shipping_methods[0].data.service_point_id` (set by storefront at checkout, cycle 02).
- Insurance override needs a new metadata key (`sendcloud_insurance_amount`) — the only backend extension this cycle.

---

## Backend — insurance override (small extension)

### New metadata key

`fulfillment.metadata.sendcloud_insurance_amount: number` — overrides the plugin's `defaultInsuranceAmount` for this single fulfillment. If absent, falls back to the plugin option (current cycle 04 behaviour).

### Helper

In `helpers.ts`, add:

```ts
export const readInsuranceOverride = (
  metadata: Record<string, unknown> | null | undefined
): number | null => {
  const raw = metadata?.sendcloud_insurance_amount;
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-sendcloud: sendcloud_insurance_amount must be a non-negative number"
    );
  }
  return value;
};
```

Returns `null` when not set, throws on invalid (negative / NaN).

### `createFulfillment` integration

Before building parcels, resolve effective insurance:

```ts
const insuranceOverride = readInsuranceOverride(fulfillment?.metadata);
const effectiveInsurance =
  insuranceOverride ?? this.options_.defaultInsuranceAmount;
```

Pass `effectiveInsurance` everywhere we currently pass `this.options_.defaultInsuranceAmount`:

- `buildShipmentParcel(items, order, { insuranceAmount: effectiveInsurance, ... })`
- `buildParcelFromHint(hint, weightUnit, effectiveInsurance)`

Single-parcel and multi-collo paths both honour the override.

---

## Frontend — `sendcloud-fulfillment-create.tsx` widget

### File

`src/admin/widgets/sendcloud-fulfillment-create.tsx`

```tsx
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import type { AdminOrder, DetailWidgetProps } from "@medusajs/types";
import {} from /* Medusa UI primitives */ "@medusajs/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sdk } from "../lib/sdk";

const SendcloudFulfillmentCreate = ({
  data: order,
}: DetailWidgetProps<AdminOrder>) => {
  // 1. Compute unfulfilled items from order.items (quantity - fulfilled_quantity)
  // 2. Read service_point_id from order.shipping_methods[0].data
  // 3. Form state: parcels[] (default 1 row), insurance override (default empty)
  // 4. Mutation calls sdk.admin.order.createFulfillment(order.id, payload)
  //    where payload.metadata.sendcloud_parcels = parcels (when length > 1 or admin entered dims)
  //    and payload.metadata.sendcloud_insurance_amount = insurance (when set)
  // 5. On success: invalidate order query, show success toast, collapse form
  // 6. On error: display error inline
};

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
});

export default SendcloudFulfillmentCreate;
```

### Form sections

1. **Header** — "SendCloud fulfillment" + collapsible toggle ("Show form" / "Hide form")
2. **Service point** — read-only block. If `order.shipping_methods[0]?.data?.service_point_id` exists, render `<Badge>Service point</Badge> {id}`. Otherwise nothing (no opinion).
3. **Items summary** — read-only count of unfulfilled items: "Will fulfill 3 unfulfilled items" (no selector in MVP).
4. **Parcels** — table with rows. Default: 1 row pre-populated with computed total weight from order items (best-effort — sum `variant.weight × quantity` from order.items). Admin can:
   - Edit row dims (length / width / height in cm, weight in plugin's `weightUnit` — show unit hint)
   - Click "Add parcel" to append a row
   - Click "Remove" on any row (disabled when only 1 row remains)
5. **Insurance override** — number input, optional. Placeholder text: `"Plugin default: ${defaultInsuranceAmount ?? 'none'} EUR"`. Empty value = use plugin default.
6. **Submit** — "Create SendCloud fulfillment" button. Disabled while submitting.

### Submit flow

```ts
const payload: AdminCreateOrderFulfillment = {
  items: unfulfilledItems.map((item) => ({
    id: item.id,
    quantity: item.quantity,
  })),
  metadata: {
    ...(parcels.length > 1 || hasNonDefaultDims(parcels)
      ? { sendcloud_parcels: parcels }
      : {}),
    ...(insurance !== ""
      ? { sendcloud_insurance_amount: Number(insurance) }
      : {}),
  },
};
sdk.admin.order.createFulfillment(order.id, payload);
```

When the parcels table has exactly 1 row AND the admin didn't change the prefilled dims, **omit** `sendcloud_parcels` so the backend uses its existing single-parcel auto-derivation (avoids inflating data with redundant hints).

### Error display

Surface SendCloud's error message (e.g., "carrier doesn't support multi-collo") inline above the submit button. Keep the form open on error so admin can adjust.

### Item quantity selector deferred

MVP fulfills ALL unfulfilled items in one shot. Partial fulfillment requires a per-item quantity input — added when a merchant asks. Standard Medusa "Create fulfillment" button still allows partial fulfillment without our metadata.

---

## Tests

### `src/providers/sendcloud/__tests__/helpers.unit.spec.ts` or extend service.spec — `readInsuranceOverride`

Add to service.spec under a new describe block (4 cases):

1. `null` metadata / `undefined` key → returns `null` (no override)
2. Number value → returns the number
3. String numeric ("50") → returns 50 (Number coercion accepted)
4. Negative or non-numeric → throws `INVALID_DATA`

### `service.unit.spec.ts` — `createFulfillment` insurance override path (3 cases)

1. `metadata.sendcloud_insurance_amount: 100` set, plugin's `defaultInsuranceAmount: 50` → parcel uses **100** (override wins)
2. No `metadata.sendcloud_insurance_amount`, plugin's `defaultInsuranceAmount: 50` → parcel uses **50** (existing cycle 04 behaviour, regression guard)
3. Multi-collo + `metadata.sendcloud_insurance_amount: 75` → ALL parcels carry `additional_insured_price.value: "75"` (override applies per-parcel like cycle 12)

Total: **181 + 7 = 188** unit tests post-cycle (1 todo).

### Admin UI

No automated tests — same rationale as cycles 11 + 14. Manual verification: build the plugin, mount in sample app, hit order detail page, walk through the form for an EU + an international order.

---

## Critical files

| Path                                                     | Action                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `src/providers/sendcloud/helpers.ts`                     | edit — add `readInsuranceOverride`                         |
| `src/providers/sendcloud/service.ts`                     | edit — resolve `effectiveInsurance` in `createFulfillment` |
| `src/admin/widgets/sendcloud-fulfillment-create.tsx`     | create                                                     |
| `src/providers/sendcloud/__tests__/service.unit.spec.ts` | edit — +7 cases, swap `it.todo` marker                     |
| `docs/fulfillment-widget.md`                             | create                                                     |
| `docs/create-fulfillment.md`                             | edit — link to insurance override doc                      |
| `docs/multi-collo.md`                                    | edit — note that the widget is the recommended trigger     |
| `docs/README.md`                                         | index + roadmap update                                     |
| `NOTES.md`                                               | parked items                                               |

---

## Gate + push

1. `make check && npm run test:unit` — 181 → 188 passing, 1 todo
2. `npx medusa plugin:build` — green (admin extensions compile)
3. Single commit: _"Add SendCloud fulfillment creation widget with parcel split + insurance override"_
4. `git push origin main`

---

## Out of scope

- Sender address override (needs new SendCloud sender-address API + persistent settings store)
- Shipping method override (order's method is fixed at checkout; would require canceling + re-creating the shipping method)
- Per-item quantity selector for partial fulfillment (MVP fulfills all unfulfilled items)
- "Test fit" calculator that suggests parcel split based on cart weight + carrier max
- Hooking into Medusa's standard "Create fulfillment" dialog (chosen against — too tight a coupling to Medusa internals)
- `it.todo` next target: **ZPL / PNG label format options — §6 (label format selector + per-fulfillment override)**
