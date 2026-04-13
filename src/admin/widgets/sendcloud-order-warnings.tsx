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

const SendcloudOrderWarnings = ({ data }: DetailWidgetProps<AdminOrder>) => {
  const warnings = useMemo<CustomsWarning[]>(() => {
    const fulfillments =
      (data.fulfillments as FulfillmentWithWarnings[] | undefined) ?? [];
    return fulfillments.flatMap(
      (fulfillment) => fulfillment.data?.sendcloud_warnings ?? []
    );
  }, [data.fulfillments]);

  if (warnings.length === 0) return null;

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">SendCloud customs warnings</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          The fulfillment{warnings.length === 1 ? "" : "s"} for this order
          shipped with missing or suspicious customs data. SendCloud may reject
          the customs declaration upstream.
        </Text>
      </div>
      <div className="flex flex-col gap-2 px-6 py-4">
        {warnings.map((warning, index) => (
          <div
            key={`${warning.code}-${warning.line_item_id ?? "shipment"}-${index}`}
            className="flex flex-col gap-1 rounded-md border border-ui-border-strong p-3"
          >
            <div className="flex items-center gap-2">
              <Badge color="orange">{warning.code}</Badge>
              {warning.line_item_id ? (
                <Text size="small" className="text-ui-fg-subtle font-mono">
                  {warning.line_item_id}
                </Text>
              ) : null}
            </div>
            <Text size="small">{warning.message}</Text>
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
