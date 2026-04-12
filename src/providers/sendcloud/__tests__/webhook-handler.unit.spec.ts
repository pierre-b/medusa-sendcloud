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
