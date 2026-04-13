import { defineWidgetConfig } from "@medusajs/admin-sdk";
import type { AdminOrder, DetailWidgetProps } from "@medusajs/types";
import { Badge, Container, Heading, Text } from "@medusajs/ui";
import { useMemo } from "react";

type CustomsWarning = {
  code: string;
  line_item_id?: string;
  message: string;
};

type FulfillmentWithWarnings = {
  data?: { sendcloud_warnings?: CustomsWarning[] } | null;
};

type GroupedWarning = {
  code: string;
  message: string;
  line_item_ids: string[];
};

const SendcloudOrderWarnings = ({ data }: DetailWidgetProps<AdminOrder>) => {
  const grouped = useMemo<GroupedWarning[]>(() => {
    const fulfillments =
      (data.fulfillments as FulfillmentWithWarnings[] | undefined) ?? [];
    const flat = fulfillments.flatMap(
      (fulfillment) => fulfillment.data?.sendcloud_warnings ?? []
    );
    const byCode = new Map<string, GroupedWarning>();
    for (const w of flat) {
      const entry = byCode.get(w.code) ?? {
        code: w.code,
        message: w.message,
        line_item_ids: [],
      };
      if (w.line_item_id && !entry.line_item_ids.includes(w.line_item_id)) {
        entry.line_item_ids.push(w.line_item_id);
      }
      byCode.set(w.code, entry);
    }
    return Array.from(byCode.values()).sort((a, b) =>
      a.code.localeCompare(b.code)
    );
  }, [data.fulfillments]);

  if (grouped.length === 0) return null;

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">SendCloud customs warnings</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          The fulfillment{grouped.length === 1 ? "" : "s"} for this order
          shipped with missing or suspicious customs data. SendCloud may reject
          the customs declaration upstream.
        </Text>
      </div>
      <div className="flex flex-col gap-2 px-6 py-4">
        {grouped.map((entry) => (
          <div
            key={entry.code}
            className="flex flex-col gap-1 rounded-md border border-ui-border-strong p-3"
          >
            <div className="flex items-center gap-2">
              <Badge color="orange">{entry.code}</Badge>
              <Text size="small" className="text-ui-fg-subtle">
                {entry.line_item_ids.length > 0
                  ? `${entry.line_item_ids.length} item${entry.line_item_ids.length === 1 ? "" : "s"}`
                  : "shipment-wide"}
              </Text>
            </div>
            <Text size="small">{entry.message}</Text>
            {entry.line_item_ids.length > 0 ? (
              <Text size="xsmall" className="text-ui-fg-subtle font-mono">
                {entry.line_item_ids.join(", ")}
              </Text>
            ) : null}
          </div>
        ))}
      </div>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
});

export default SendcloudOrderWarnings;
