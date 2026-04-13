import crypto from "node:crypto";

import { processSendcloudWebhook } from "../webhook-handler";
import { verifySendcloudSignature } from "../helpers";

const updateFulfillmentRun = jest.fn(async (_args: unknown) => ({}));

jest.mock("@medusajs/medusa/core-flows", () => ({
  updateFulfillmentWorkflow: jest.fn(() => ({
    run: (args: unknown) => updateFulfillmentRun(args),
  })),
}));

const loggerStub = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

type FulfillmentRow = {
  id: string;
  data?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  canceled_at?: string | null;
  delivered_at?: string | null;
};

const buildContainer = (fulfillments: FulfillmentRow[] = []) => {
  const graph = jest.fn(async () => ({ data: fulfillments }));
  const scope: Record<string, unknown> = {
    query: { graph },
    logger: loggerStub,
  };
  return {
    resolve: jest.fn((key: string) => scope[key]),
    __graph: graph,
  } as unknown as Parameters<typeof processSendcloudWebhook>[0] & {
    __graph: jest.Mock;
  };
};

const SECRET = "super-secret";
const signBody = (body: unknown, secret: string = SECRET) => {
  const raw = JSON.stringify(body);
  const signature = crypto
    .createHmac("sha256", secret)
    .update(raw)
    .digest("hex");
  return { raw, signature };
};

const DEFAULT_OPTIONS = {
  publicKey: "pub",
  privateKey: "priv",
  webhookSecret: SECRET,
  webhookLookbackDays: 60,
};

describe("verifySendcloudSignature", () => {
  it("accepts a correct HMAC-SHA256 hex digest", () => {
    const { raw, signature } = signBody({ hello: "world" });
    expect(verifySendcloudSignature(raw, signature, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { signature } = signBody({ hello: "world" });
    expect(
      verifySendcloudSignature('{"hello":"tampered"}', signature, SECRET)
    ).toBe(false);
  });

  it("rejects a signature computed with a different secret", () => {
    const { raw } = signBody({ hello: "world" });
    const other = crypto
      .createHmac("sha256", "other-secret")
      .update(raw)
      .digest("hex");
    expect(verifySendcloudSignature(raw, other, SECRET)).toBe(false);
  });

  it("rejects non-hex signature input without throwing", () => {
    expect(verifySendcloudSignature("{}", "nothex!", SECRET)).toBe(false);
  });

  it("rejects length-mismatched hex strings without throwing", () => {
    expect(verifySendcloudSignature("{}", "abcd", SECRET)).toBe(false);
  });
});

describe("processSendcloudWebhook", () => {
  beforeEach(() => {
    updateFulfillmentRun.mockClear();
    loggerStub.debug.mockClear();
  });

  it("returns 401 when webhookSecret is not configured", async () => {
    const container = buildContainer();
    const { raw, signature } = signBody({ action: "parcel_status_changed" });

    const result = await processSendcloudWebhook(
      container,
      { ...DEFAULT_OPTIONS, webhookSecret: undefined },
      { signature, rawBody: raw, payload: JSON.parse(raw) }
    );

    expect(result.status).toBe(401);
    expect(result.message).toMatch(/webhookSecret/);
    expect(updateFulfillmentRun).not.toHaveBeenCalled();
  });

  it("returns 401 when signature header is missing", async () => {
    const container = buildContainer();
    const { raw } = signBody({ action: "parcel_status_changed" });

    const result = await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature: undefined,
      rawBody: raw,
      payload: JSON.parse(raw),
    });

    expect(result.status).toBe(401);
    expect(result.message).toMatch(/Sendcloud-Signature/);
  });

  it("returns 401 when signature fails verification", async () => {
    const container = buildContainer();
    const { raw } = signBody({ action: "parcel_status_changed" });

    const result = await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature:
        "0000000000000000000000000000000000000000000000000000000000000000",
      rawBody: raw,
      payload: JSON.parse(raw),
    });

    expect(result.status).toBe(401);
    expect(result.message).toMatch(/verification failed/);
  });

  it("updates fulfillment data for parcel_status_changed with a matching parcel", async () => {
    const fulfillment = {
      id: "ful_1",
      data: {
        sendcloud_parcel_id: 12345,
        status_updated_at: 0,
      },
    };
    const container = buildContainer([fulfillment]);
    const payload = {
      action: "parcel_status_changed",
      timestamp: 1700000000000,
      parcel: {
        id: 12345,
        tracking_number: "3S-NEW",
        tracking_url: "https://tracking.example/3S-NEW",
        status: { id: 3, message: "En route to sorting centre" },
      },
    };
    const { raw, signature } = signBody(payload);

    const result = await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature,
      rawBody: raw,
      payload,
    });

    expect(result.status).toBe(200);
    expect(updateFulfillmentRun).toHaveBeenCalledWith({
      input: {
        id: "ful_1",
        data: {
          status: payload.parcel.status,
          status_updated_at: 1700000000000,
          tracking_number: "3S-NEW",
          tracking_url: "https://tracking.example/3S-NEW",
        },
      },
    });
  });

  it("sets delivered_at on the fulfillment when status.id === 11", async () => {
    const fulfillment = {
      id: "ful_2",
      data: { sendcloud_parcel_id: 777 },
      delivered_at: null,
    };
    const container = buildContainer([fulfillment]);
    const payload = {
      action: "parcel_status_changed",
      timestamp: 1700000000001,
      parcel: {
        id: 777,
        tracking_number: "3S-DELIVERED",
        status: { id: 11, message: "Delivered" },
      },
    };
    const { raw, signature } = signBody(payload);

    await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature,
      rawBody: raw,
      payload,
    });

    const call = updateFulfillmentRun.mock.calls[0]?.[0] as {
      input: { delivered_at?: Date };
    };
    expect(call.input.delivered_at).toBeInstanceOf(Date);
  });

  it("does not set delivered_at when fulfillment.delivered_at is already set", async () => {
    const fulfillment = {
      id: "ful_3",
      data: { sendcloud_parcel_id: 42 },
      delivered_at: "2026-01-01T00:00:00Z",
    };
    const container = buildContainer([fulfillment]);
    const payload = {
      action: "parcel_status_changed",
      timestamp: 1700000000002,
      parcel: { id: 42, status: { id: 11, message: "Delivered" } },
    };
    const { raw, signature } = signBody(payload);

    await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature,
      rawBody: raw,
      payload,
    });

    const call = updateFulfillmentRun.mock.calls[0]?.[0] as {
      input: { delivered_at?: Date };
    };
    expect(call.input.delivered_at).toBeUndefined();
  });

  it("flags sendcloud_exception metadata when status.id === 80", async () => {
    const fulfillment = {
      id: "ful_4",
      data: { sendcloud_parcel_id: 99 },
      metadata: { some_existing_key: "keep-me" },
    };
    const container = buildContainer([fulfillment]);
    const payload = {
      action: "parcel_status_changed",
      timestamp: 1700000000003,
      parcel: {
        id: 99,
        status: { id: 80, message: "Exception" },
      },
    };
    const { raw, signature } = signBody(payload);

    await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature,
      rawBody: raw,
      payload,
    });

    expect(updateFulfillmentRun).toHaveBeenCalledWith({
      input: expect.objectContaining({
        id: "ful_4",
        metadata: expect.objectContaining({
          some_existing_key: "keep-me",
          sendcloud_exception: {
            timestamp: 1700000000003,
            message: "Exception",
          },
        }),
      }),
    });
  });

  it("skips stale webhooks whose timestamp <= stored status_updated_at", async () => {
    const fulfillment = {
      id: "ful_5",
      data: {
        sendcloud_parcel_id: 5,
        status_updated_at: 2000000000000,
      },
    };
    const container = buildContainer([fulfillment]);
    const payload = {
      action: "parcel_status_changed",
      timestamp: 1900000000000, // older than stored
      parcel: { id: 5, status: { id: 3, message: "En route" } },
    };
    const { raw, signature } = signBody(payload);

    const result = await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature,
      rawBody: raw,
      payload,
    });

    expect(result.status).toBe(200);
    expect(updateFulfillmentRun).not.toHaveBeenCalled();
  });

  it("returns 200 with no-match when no fulfillment has the parcel id", async () => {
    const container = buildContainer([
      { id: "ful_other", data: { sendcloud_parcel_id: 1 } },
    ]);
    const payload = {
      action: "parcel_status_changed",
      timestamp: 1700000000004,
      parcel: { id: 999, status: { id: 3, message: "En route" } },
    };
    const { raw, signature } = signBody(payload);

    const result = await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature,
      rawBody: raw,
      payload,
    });

    expect(result.status).toBe(200);
    expect(result.message).toBe("no-match");
    expect(updateFulfillmentRun).not.toHaveBeenCalled();
  });

  it("stores refund flag on metadata for refund_requested", async () => {
    const fulfillment = {
      id: "ful_6",
      data: { sendcloud_parcel_id: 321 },
      metadata: { existing: "preserve" },
    };
    const container = buildContainer([fulfillment]);
    const payload = {
      action: "refund_requested",
      timestamp: 1700000000005,
      parcel: { id: 321 },
      refund_reason: "damaged",
    };
    const { raw, signature } = signBody(payload);

    const result = await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature,
      rawBody: raw,
      payload,
    });

    expect(result.status).toBe(200);
    expect(updateFulfillmentRun).toHaveBeenCalledWith({
      input: expect.objectContaining({
        id: "ful_6",
        metadata: expect.objectContaining({
          existing: "preserve",
          sendcloud_refund_requested: {
            timestamp: 1700000000005,
            reason: "damaged",
          },
        }),
      }),
    });
  });

  describe("multi-collo aggregation", () => {
    const baseMultiData = {
      sendcloud_shipment_id: "ship_multi",
      sendcloud_parcel_id: 700,
      is_multicollo: true,
      aggregate_status: "pending" as const,
      parcels: [
        {
          sendcloud_parcel_id: 700,
          tracking_number: "3S700",
          tracking_url: "https://tr/700",
          status: null,
          label_url: null,
        },
        {
          sendcloud_parcel_id: 701,
          tracking_number: "3S701",
          tracking_url: "https://tr/701",
          status: null,
          label_url: null,
        },
      ],
    };

    it("partial delivery updates the matching parcel and flags partially_delivered", async () => {
      const fulfillment = { id: "ful_multi_1", data: { ...baseMultiData } };
      const container = buildContainer([fulfillment]);
      const payload = {
        action: "parcel_status_changed",
        timestamp: 1800000000001,
        parcel: {
          id: 700,
          tracking_number: "3S700",
          tracking_url: "https://tr/700",
          status: { id: 11, message: "Delivered" },
        },
      };
      const { raw, signature } = signBody(payload);

      await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
        signature,
        rawBody: raw,
        payload,
      });

      const call = updateFulfillmentRun.mock.calls[0]?.[0] as {
        input: {
          data: {
            parcels: Array<{ status: unknown }>;
            aggregate_status: string;
          };
          delivered_at?: Date;
        };
      };
      expect(call.input.data.aggregate_status).toBe("partially_delivered");
      expect(call.input.data.parcels[0].status).toEqual({
        id: 11,
        message: "Delivered",
      });
      expect(call.input.data.parcels[1].status).toBeNull();
      expect(call.input.delivered_at).toBeUndefined();
    });

    it("marks delivered_at only when every parcel has status.id 11", async () => {
      const fulfillment = {
        id: "ful_multi_2",
        data: {
          ...baseMultiData,
          parcels: [
            {
              ...baseMultiData.parcels[0],
              status: { id: 11, message: "Delivered" },
            },
            baseMultiData.parcels[1],
          ],
        },
      };
      const container = buildContainer([fulfillment]);
      const payload = {
        action: "parcel_status_changed",
        timestamp: 1800000000002,
        parcel: {
          id: 701,
          status: { id: 11, message: "Delivered" },
        },
      };
      const { raw, signature } = signBody(payload);

      await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
        signature,
        rawBody: raw,
        payload,
      });

      const call = updateFulfillmentRun.mock.calls[0]?.[0] as {
        input: {
          data: { aggregate_status: string };
          delivered_at?: Date;
        };
      };
      expect(call.input.data.aggregate_status).toBe("delivered");
      expect(call.input.delivered_at).toBeInstanceOf(Date);
    });

    it("flags aggregate_status 'exception' on parcel status.id 80 without setting delivered_at", async () => {
      const fulfillment = { id: "ful_multi_3", data: { ...baseMultiData } };
      const container = buildContainer([fulfillment]);
      const payload = {
        action: "parcel_status_changed",
        timestamp: 1800000000003,
        parcel: {
          id: 701,
          status: { id: 80, message: "Exception: customs hold" },
        },
      };
      const { raw, signature } = signBody(payload);

      await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
        signature,
        rawBody: raw,
        payload,
      });

      const call = updateFulfillmentRun.mock.calls[0]?.[0] as {
        input: {
          data: { aggregate_status: string };
          metadata?: Record<string, unknown>;
          delivered_at?: Date;
        };
      };
      expect(call.input.data.aggregate_status).toBe("exception");
      expect(call.input.metadata).toMatchObject({
        sendcloud_exception: {
          timestamp: 1800000000003,
          message: "Exception: customs hold",
        },
      });
      expect(call.input.delivered_at).toBeUndefined();
    });

    it("uses per-parcel status_updated_at for stale-checking — older event for parcel B not rejected because parcel A processed later", async () => {
      const fulfillment = {
        id: "ful_multi_4",
        data: {
          ...baseMultiData,
          parcels: [
            {
              ...baseMultiData.parcels[0],
              status: { id: 11, message: "Delivered" },
              status_updated_at: 1900000000000,
            },
            baseMultiData.parcels[1],
          ],
        },
      };
      const container = buildContainer([fulfillment]);
      const payload = {
        action: "parcel_status_changed",
        timestamp: 1800000000000, // older than parcel A's stored timestamp
        parcel: { id: 701, status: { id: 3, message: "En route" } },
      };
      const { raw, signature } = signBody(payload);

      const result = await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
        signature,
        rawBody: raw,
        payload,
      });

      expect(result.message).toBe("processed");
      const call = updateFulfillmentRun.mock.calls[0]?.[0] as {
        input: {
          data: {
            parcels: Array<{
              sendcloud_parcel_id: number;
              status_updated_at?: number;
            }>;
          };
        };
      };
      const updatedB = call.input.data.parcels.find(
        (p) => p.sendcloud_parcel_id === 701
      );
      expect(updatedB?.status_updated_at).toBe(1800000000000);
    });

    it("rejects truly-stale per-parcel webhooks (same parcel, older timestamp)", async () => {
      const fulfillment = {
        id: "ful_multi_5",
        data: {
          ...baseMultiData,
          parcels: [
            {
              ...baseMultiData.parcels[0],
              status: { id: 11, message: "Delivered" },
              status_updated_at: 1900000000000,
            },
            baseMultiData.parcels[1],
          ],
        },
      };
      const container = buildContainer([fulfillment]);
      const payload = {
        action: "parcel_status_changed",
        timestamp: 1800000000000, // older than parcel A's own stored timestamp
        parcel: { id: 700, status: { id: 3, message: "En route" } },
      };
      const { raw, signature } = signBody(payload);

      const result = await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
        signature,
        rawBody: raw,
        payload,
      });

      expect(result.message).toBe("stale");
      expect(updateFulfillmentRun).not.toHaveBeenCalled();
    });
  });

  it("ignores unknown actions and returns 200", async () => {
    const container = buildContainer();
    const payload = {
      action: "integration_connected",
      timestamp: 1700000000006,
    };
    const { raw, signature } = signBody(payload);

    const result = await processSendcloudWebhook(container, DEFAULT_OPTIONS, {
      signature,
      rawBody: raw,
      payload,
    });

    expect(result.status).toBe(200);
    expect(updateFulfillmentRun).not.toHaveBeenCalled();
  });
});
