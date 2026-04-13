import { defineRouteConfig } from "@medusajs/admin-sdk";
import {
  Badge,
  Button,
  Container,
  Heading,
  Table,
  Text,
  clx,
} from "@medusajs/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { sdk } from "../../../lib/sdk";

type ShippingOption = {
  code: string;
  name: string;
  carrier: { code: string; name: string };
  product?: { code: string; name: string };
  requirements?: { is_service_point_required?: boolean };
};

type ConfigWarning = {
  code: string;
  message: string;
};

type DashboardResponse = {
  connected: boolean;
  error?: string;
  shipping_options: ShippingOption[];
  config_warnings?: ConfigWarning[];
};

const WEBHOOK_PATH = "/webhooks/sendcloud";

const useWebhookUrl = () =>
  useMemo(() => {
    if (typeof window === "undefined") return WEBHOOK_PATH;
    return `${window.location.origin}${WEBHOOK_PATH}`;
  }, []);

const SendcloudSettingsPage = () => {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useQuery<DashboardResponse>({
      queryKey: ["sendcloud-dashboard"],
      queryFn: () =>
        sdk.client.fetch<DashboardResponse>("/admin/sendcloud/dashboard"),
    });

  const webhookUrl = useWebhookUrl();
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    },
    []
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable in some admin contexts; silently ignore
    }
  };

  const grouped = useMemo(() => {
    const byCarrier = new Map<
      string,
      { name: string; options: ShippingOption[] }
    >();
    for (const option of data?.shipping_options ?? []) {
      const carrierCode = option.carrier?.code ?? "unknown";
      const carrierName = option.carrier?.name ?? carrierCode;
      const entry = byCarrier.get(carrierCode) ?? {
        name: carrierName,
        options: [],
      };
      entry.options.push(option);
      byCarrier.set(carrierCode, entry);
    }
    return Array.from(byCarrier.entries()).sort(([, a], [, b]) =>
      a.name.localeCompare(b.name)
    );
  }, [data?.shipping_options]);

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">SendCloud</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Shipping integration status, webhook configuration, and enabled
            carrier services.
          </Text>
        </div>
        <Button
          size="small"
          variant="secondary"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <section className="flex flex-col gap-3 px-6 py-4">
        <Heading level="h2">Configuration & health</Heading>
        {isLoading ? (
          <Text className="text-ui-fg-subtle" size="small">
            Loading…
          </Text>
        ) : isError ? (
          <Text className="text-ui-fg-subtle" size="small">
            Configuration status unavailable — see the Connection section below.
          </Text>
        ) : (data?.config_warnings ?? []).length === 0 ? (
          <Text className="text-ui-fg-subtle" size="small">
            All required plugin options are configured.
          </Text>
        ) : (
          <div className="flex flex-col gap-2">
            {(data?.config_warnings ?? []).map((warning) => (
              <div
                key={warning.code}
                className="flex flex-col gap-1 rounded-md border border-ui-border-strong p-3"
              >
                <div className="flex items-center gap-2">
                  <Badge color="orange">{warning.code}</Badge>
                </div>
                <Text size="small">{warning.message}</Text>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 px-6 py-4">
        <Heading level="h2">Connection</Heading>
        {isLoading ? (
          <Text>Checking credentials…</Text>
        ) : isError ? (
          <div className="flex flex-col gap-1">
            <Badge color="red">Unreachable</Badge>
            <Text className="text-ui-fg-subtle" size="small">
              {error?.message ?? "Unable to reach the plugin API"}
            </Text>
          </div>
        ) : data?.connected ? (
          <Badge color="green">Connected</Badge>
        ) : (
          <div className="flex flex-col gap-1">
            <Badge color="red">Disconnected</Badge>
            <Text className="text-ui-fg-subtle" size="small">
              {data?.error ?? "SendCloud credentials could not be validated."}
            </Text>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 px-6 py-4">
        <Heading level="h2">Webhook URL</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          Paste this URL into SendCloud → Settings → Integrations → Webhooks.
          The plugin verifies each request's HMAC-SHA256 signature against your
          configured <code>webhookSecret</code>.
        </Text>
        <div className="flex items-center gap-2">
          <code
            className={clx(
              "bg-ui-bg-subtle rounded px-3 py-2 font-mono text-sm",
              "flex-1 truncate"
            )}
          >
            {webhookUrl}
          </code>
          <Button size="small" variant="secondary" onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3 px-6 py-4">
        <Heading level="h2">Enabled carriers</Heading>
        {isLoading ? (
          <Text>Loading…</Text>
        ) : !data?.connected ? (
          <Text className="text-ui-fg-subtle" size="small">
            Connect SendCloud to see the enabled carrier services.
          </Text>
        ) : grouped.length === 0 ? (
          <Text className="text-ui-fg-subtle" size="small">
            SendCloud returned no enabled carriers. Activate at least one in the
            SendCloud dashboard → Settings → Integrations.
          </Text>
        ) : (
          <div className="flex flex-col gap-6">
            {grouped.map(([carrierCode, { name, options }]) => (
              <div key={carrierCode} className="flex flex-col gap-2">
                <Heading level="h3">{name}</Heading>
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>Code</Table.HeaderCell>
                      <Table.HeaderCell>Name</Table.HeaderCell>
                      <Table.HeaderCell>Service point</Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {options.map((option) => (
                      <Table.Row key={option.code}>
                        <Table.Cell>
                          <code className="font-mono text-xs">
                            {option.code}
                          </code>
                        </Table.Cell>
                        <Table.Cell>{option.name}</Table.Cell>
                        <Table.Cell>
                          {option.requirements?.is_service_point_required ? (
                            <Badge color="blue">Required</Badge>
                          ) : (
                            <Text size="small" className="text-ui-fg-subtle">
                              No
                            </Text>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            ))}
          </div>
        )}
      </section>
    </Container>
  );
};

export const config = defineRouteConfig({
  label: "SendCloud",
});

export default SendcloudSettingsPage;
