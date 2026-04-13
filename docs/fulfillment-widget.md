# Fulfillment creation widget (spec §15.3)

Admin UI widget on the order details page that drives SendCloud fulfillment creation with parcel split, service-point display, and per-shipment insurance override. Renders alongside Medusa's standard "Create fulfillment" button — admins choose.

Replaces the curl-with-raw-JSON path that cycle 12 left for multi-collo. The widget is the recommended trigger for any non-trivial SendCloud fulfillment.

## Where it lives

- File: `src/admin/widgets/sendcloud-fulfillment-create.tsx`
- Zone: `order.details.side.after` — stacks below the cycle 14 customs warnings widget on the order's right sidebar.
- Hidden when there are no unfulfilled items on the order.

## Form sections

1. **Header** — title + "Show form" / "Hide form" toggle. Form starts collapsed.
2. **Service point** (read-only) — displays the customer-selected pickup point id from `order.shipping_methods[0].data.service_point_id` (set at checkout, cycle 02). Hidden when no service point applies.
3. **Items summary** — read-only line: "Will fulfill N unfulfilled items (total weight ~X base unit)". MVP fulfills all unfulfilled items in one shot; partial fulfillment uses Medusa's standard dialog instead.
4. **Parcels** — table of rows, each with weight + L/W/H inputs. Default: 1 empty row. Buttons:
   - **+ Add parcel** — appends a row (capped at 15 per spec §8 / cycle 12)
   - **Remove** — drops a row (disabled when only 1 row remains)
   - Leave all rows empty to use the auto-derived single-parcel mode (cycle 04 default).
5. **Insurance override** — optional number input. Empty = use plugin's `defaultInsuranceAmount`. Set = `metadata.sendcloud_insurance_amount` flows through cycle 15's backend extension (applies per-parcel in multi-collo mode).
6. **Submit** — "Create SendCloud fulfillment" button. Disabled while `useMutation.isPending`.

## Submit payload

```ts
sdk.admin.order.createFulfillment(order.id, {
  items: unfulfilled.map((item) => ({ id: item.id, quantity: item.quantity })),
  metadata: {
    sendcloud_parcels?: [{ weight, length, width, height }, ...],   // omitted when all rows are empty
    sendcloud_insurance_amount?: number,                            // omitted when input is empty
  },
});
```

The widget submits to Medusa's standard `POST /admin/orders/:id/fulfillments` endpoint — no new admin route. Backend reads `fulfillment.metadata.sendcloud_parcels` (cycle 12) and `fulfillment.metadata.sendcloud_insurance_amount` (cycle 15) to drive the SendCloud announce.

On success: form collapses, react-query invalidates `["orders", order.id]` so the page refreshes with the new fulfillment.

On error: SendCloud's error message renders inline above the submit button (e.g., "carrier doesn't support multi-collo"). Form stays open so admin can adjust.

## Backend extension — `metadata.sendcloud_insurance_amount`

| Source                                        | Effective insurance per parcel        |
| --------------------------------------------- | ------------------------------------- |
| `metadata.sendcloud_insurance_amount` set     | The override value (per-parcel)       |
| Override absent, `defaultInsuranceAmount` set | Plugin default (per-parcel, cycle 12) |
| Both absent                                   | No insurance                          |

`readInsuranceOverride` (in `helpers.ts`) validates the metadata key as a non-negative number; throws `INVALID_DATA` otherwise.

## Tests

- `src/providers/sendcloud/__tests__/service.unit.spec.ts` — 4 new cases under `createFulfillment > insurance override`:
  - Override wins over `defaultInsuranceAmount`
  - Falls back to default when override absent (regression guard)
  - Multi-collo applies override per-parcel
  - Negative / non-numeric override throws `INVALID_DATA`

Widget itself has no automated tests — same rationale as cycles 11 + 14. Manual verification: build the plugin, hit an order details page, create a fulfillment with both single-parcel and multi-parcel inputs.

## Out of scope

- Sender address override (needs new SendCloud sender-address API + persistent settings store)
- Shipping method override (order's method is fixed at checkout)
- Per-item quantity selector for partial fulfillment (use Medusa's standard dialog if needed)
- "Test fit" calculator suggesting parcel split based on cart weight + carrier max
- Replacing Medusa's standard "Create fulfillment" button
