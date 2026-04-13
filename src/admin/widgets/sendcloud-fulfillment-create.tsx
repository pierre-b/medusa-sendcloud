import { defineWidgetConfig } from "@medusajs/admin-sdk";
import type { AdminOrder, DetailWidgetProps } from "@medusajs/types";
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Text,
  clx,
  toast,
} from "@medusajs/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { sdk } from "../lib/sdk";

type ParcelRow = {
  weight: string;
  length: string;
  width: string;
  height: string;
};

type UnfulfilledItem = {
  id: string;
  title: string;
  quantity: number;
  weight: number;
};

const emptyRow = (): ParcelRow => ({
  weight: "",
  length: "",
  width: "",
  height: "",
});

const isRowEmpty = (row: ParcelRow): boolean =>
  !row.weight && !row.length && !row.width && !row.height;

const parseRow = (
  row: ParcelRow
): {
  weight: number;
  length: number;
  width: number;
  height: number;
} => ({
  weight: Number(row.weight),
  length: Number(row.length),
  width: Number(row.width),
  height: Number(row.height),
});

const SendcloudFulfillmentCreate = ({
  data: order,
}: DetailWidgetProps<AdminOrder>) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [parcels, setParcels] = useState<ParcelRow[]>([emptyRow()]);
  const [insurance, setInsurance] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const unfulfilled = useMemo<UnfulfilledItem[]>(() => {
    const items =
      (order.items as
        | Array<{
            id?: string;
            title?: string;
            quantity?: number;
            // Medusa v2 surfaces fulfilled_quantity on the nested OrderItemDTO
            // (item.detail), not on the line item itself. The flat field
            // doesn't exist — reading it gives undefined and treats every
            // item as unfulfilled.
            detail?: { fulfilled_quantity?: number | string } | null;
            variant?: { weight?: number | null } | null;
          }>
        | undefined) ?? [];
    return items
      .map((item) => ({
        id: item.id ?? "",
        title: item.title ?? "",
        quantity:
          (Number(item.quantity ?? 0) || 0) -
          (Number(item.detail?.fulfilled_quantity ?? 0) || 0),
        weight: Number(item.variant?.weight ?? 0) || 0,
      }))
      .filter((item) => item.id && item.quantity > 0);
  }, [order.items]);

  const servicePointId = useMemo<string | null>(() => {
    const methods =
      (order.shipping_methods as
        | Array<{ data?: { service_point_id?: unknown } | null }>
        | undefined) ?? [];
    const id = methods[0]?.data?.service_point_id;
    return typeof id === "string" || typeof id === "number" ? String(id) : null;
  }, [order.shipping_methods]);

  const totalWeight = useMemo(
    () =>
      unfulfilled.reduce((sum, item) => sum + item.weight * item.quantity, 0),
    [unfulfilled]
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const filledRows = parcels.filter((row) => !isRowEmpty(row));
      const metadata: Record<string, unknown> = {};
      if (filledRows.length > 0) {
        metadata.sendcloud_parcels = filledRows.map(parseRow);
      }
      if (insurance.trim() !== "") {
        const parsed = Number(insurance);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(
            "Insurance override must be a non-negative number (e.g., 50 for €50 per parcel)."
          );
        }
        metadata.sendcloud_insurance_amount = parsed;
      }
      return sdk.admin.order.createFulfillment(order.id, {
        items: unfulfilled.map((item) => ({
          id: item.id,
          quantity: item.quantity,
        })),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    },
    onSuccess: () => {
      setErrorMessage(null);
      setParcels([emptyRow()]);
      setInsurance("");
      setOpen(false);
      toast.success("SendCloud fulfillment created");
      queryClient.invalidateQueries({ queryKey: ["orders", order.id] });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      setErrorMessage(message);
    },
  });

  if (unfulfilled.length === 0) return null;

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">SendCloud fulfillment</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Create a SendCloud shipment with optional parcel split + insurance
            override.
          </Text>
        </div>
        <Button
          size="small"
          variant="secondary"
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "Hide form" : "Show form"}
        </Button>
      </div>

      {open ? (
        <div className="flex flex-col gap-4 px-6 py-4">
          {servicePointId ? (
            <div className="flex items-center gap-2">
              <Badge color="blue">Service point</Badge>
              <Text size="small" className="font-mono">
                {servicePointId}
              </Text>
            </div>
          ) : null}

          <Text size="small" className="text-ui-fg-subtle">
            Will fulfill {unfulfilled.length} unfulfilled item
            {unfulfilled.length === 1 ? "" : "s"} (total weight ~{totalWeight}{" "}
            base unit). Leave parcels blank to use auto-derived single-parcel
            mode.
          </Text>

          <div className="flex flex-col gap-2">
            <Label>Parcels</Label>
            {parcels.map((row, index) => (
              <div
                key={index}
                className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2"
              >
                <Input
                  placeholder="weight"
                  value={row.weight}
                  onChange={(e) => {
                    const next = [...parcels];
                    next[index] = { ...row, weight: e.target.value };
                    setParcels(next);
                  }}
                />
                <Input
                  placeholder="L (cm)"
                  value={row.length}
                  onChange={(e) => {
                    const next = [...parcels];
                    next[index] = { ...row, length: e.target.value };
                    setParcels(next);
                  }}
                />
                <Input
                  placeholder="W (cm)"
                  value={row.width}
                  onChange={(e) => {
                    const next = [...parcels];
                    next[index] = { ...row, width: e.target.value };
                    setParcels(next);
                  }}
                />
                <Input
                  placeholder="H (cm)"
                  value={row.height}
                  onChange={(e) => {
                    const next = [...parcels];
                    next[index] = { ...row, height: e.target.value };
                    setParcels(next);
                  }}
                />
                <Button
                  size="small"
                  variant="transparent"
                  disabled={parcels.length === 1}
                  onClick={() =>
                    setParcels(parcels.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              size="small"
              variant="transparent"
              onClick={() => setParcels([...parcels, emptyRow()])}
              disabled={parcels.length >= 15}
            >
              + Add parcel
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <Label>Insurance override (EUR, optional)</Label>
            <Input
              placeholder="Leave empty to use plugin default"
              value={insurance}
              onChange={(e) => setInsurance(e.target.value)}
            />
          </div>

          {errorMessage ? (
            <div
              className={clx(
                "rounded-md border border-ui-tag-red-border",
                "bg-ui-tag-red-bg p-3"
              )}
            >
              <Text size="small" className="text-ui-tag-red-text">
                {errorMessage}
              </Text>
            </div>
          ) : null}

          <Button
            size="small"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Creating…" : "Create SendCloud fulfillment"}
          </Button>
        </div>
      ) : null}
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
});

export default SendcloudFulfillmentCreate;
