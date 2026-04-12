import nock from "nock";

import {
  DEFAULT_SENDCLOUD_BASE_URL,
  SendCloudClient,
} from "../../../services/sendcloud-client";
import { parseLabelQuery } from "../helpers";
import {
  buildSingleLabelPath,
  fetchSendcloudLabel,
} from "../fulfillment-label";
import { buildProviderRegistrationKey } from "../registration";

const PROVIDER_KEY = buildProviderRegistrationKey("sendcloud");

describe("parseLabelQuery", () => {
  it("defaults paper_size to a6 and leaves dpi unset", () => {
    const result = parseLabelQuery({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ paperSize: "a6" });
    }
  });

  it("accepts valid paper_size and dpi", () => {
    const result = parseLabelQuery({ paper_size: "a4", dpi: "300" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ paperSize: "a4", dpi: 300 });
    }
  });

  it("rejects invalid paper_size", () => {
    expect(parseLabelQuery({ paper_size: "letter" })).toMatchObject({
      ok: false,
    });
  });

  it("rejects invalid dpi", () => {
    expect(parseLabelQuery({ dpi: "123" })).toMatchObject({ ok: false });
    expect(parseLabelQuery({ dpi: "abc" })).toMatchObject({ ok: false });
  });

  it("treats empty dpi string as absent", () => {
    const result = parseLabelQuery({ dpi: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dpi).toBeUndefined();
  });
});

describe("fetchSendcloudLabel", () => {
  const client = new SendCloudClient({
    publicKey: "pub",
    privateKey: "priv",
    retryBaseDelayMs: 0,
  });

  type Scope = Record<string, unknown>;
  const buildContainer = (
    fulfillments: Array<{ id: string; data?: Record<string, unknown> | null }>
  ) => {
    const graph = jest.fn(async () => ({ data: fulfillments }));
    const scope: Scope = {
      [PROVIDER_KEY]: { client_: client },
      query: { graph },
    };
    return {
      resolve: jest.fn((key: string) => {
        if (!(key in scope)) throw new Error(`no registration for ${key}`);
        return scope[key];
      }),
    } as unknown as Parameters<typeof fetchSendcloudLabel>[0];
  };

  it("streams the PDF from the single-parcel endpoint with query params", async () => {
    const pdfBody = Buffer.from("%PDF-1.4 single");
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get(buildSingleLabelPath(12345))
      .query({ paper_size: "a6", dpi: "300" })
      .reply(200, pdfBody, { "content-type": "application/pdf" });

    const container = buildContainer([
      { id: "ful_1", data: { sendcloud_parcel_id: 12345 } },
    ]);

    const result = await fetchSendcloudLabel(container, PROVIDER_KEY, {
      fulfillmentId: "ful_1",
      paperSize: "a6",
      dpi: 300,
    });

    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.parcelId).toBe(12345);
      expect(result.contentType).toBe("application/pdf");
      expect(result.body.toString("utf8")).toBe("%PDF-1.4 single");
    }
    expect(nock.isDone()).toBe(true);
  });

  it("omits dpi from the query when unset", async () => {
    let capturedPath: string | undefined;
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get(/\/api\/v3\/parcels\/111\/documents\/label\?.*/)
      .reply(function () {
        capturedPath = this.req.path;
        return [200, Buffer.from("pdf"), { "content-type": "application/pdf" }];
      });

    const container = buildContainer([
      { id: "ful_1", data: { sendcloud_parcel_id: 111 } },
    ]);

    await fetchSendcloudLabel(container, PROVIDER_KEY, {
      fulfillmentId: "ful_1",
      paperSize: "a6",
    });

    expect(capturedPath).toBeDefined();
    expect(capturedPath).toContain("paper_size=a6");
    expect(capturedPath).not.toContain("dpi=");
  });

  it("returns 404 when the fulfillment id is unknown", async () => {
    const container = buildContainer([]);

    const result = await fetchSendcloudLabel(container, PROVIDER_KEY, {
      fulfillmentId: "ful_missing",
      paperSize: "a6",
    });

    expect(result.status).toBe(404);
    if (result.status === 404) {
      expect(result.body.message).toMatch(/ful_missing/);
    }
  });

  it("returns 400 when the fulfillment has no sendcloud_parcel_id", async () => {
    const container = buildContainer([{ id: "ful_1", data: {} }]);

    const result = await fetchSendcloudLabel(container, PROVIDER_KEY, {
      fulfillmentId: "ful_1",
      paperSize: "a6",
    });

    expect(result.status).toBe(400);
    if (result.status === 400) {
      expect(result.body.message).toMatch(/sendcloud_parcel_id/);
    }
  });

  it("returns 502 when the fulfillment provider is not registered", async () => {
    const container = {
      resolve: jest.fn(() => {
        throw new Error("not registered");
      }),
    } as unknown as Parameters<typeof fetchSendcloudLabel>[0];

    const result = await fetchSendcloudLabel(container, PROVIDER_KEY, {
      fulfillmentId: "ful_1",
      paperSize: "a6",
    });

    expect(result.status).toBe(502);
  });

  it("returns 502 when Query.graph throws", async () => {
    const scope: Record<string, unknown> = {
      [PROVIDER_KEY]: { client_: client },
      query: {
        graph: jest.fn(async () => {
          throw new Error("db timeout");
        }),
      },
    };
    const container = {
      resolve: jest.fn((key: string) => {
        if (!(key in scope)) throw new Error(`no registration for ${key}`);
        return scope[key];
      }),
    } as unknown as Parameters<typeof fetchSendcloudLabel>[0];

    const result = await fetchSendcloudLabel(container, PROVIDER_KEY, {
      fulfillmentId: "ful_1",
      paperSize: "a6",
    });

    expect(result.status).toBe(502);
    if (result.status === 502) {
      expect(result.body.message).toMatch(/db timeout/);
    }
  });

  it("wraps upstream 404 as 502 with the SendCloud message", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get(buildSingleLabelPath(12345))
      .query(true)
      .reply(404, {
        errors: [{ code: "not_found", detail: "Parcel not found" }],
      });

    const container = buildContainer([
      { id: "ful_1", data: { sendcloud_parcel_id: 12345 } },
    ]);

    const result = await fetchSendcloudLabel(container, PROVIDER_KEY, {
      fulfillmentId: "ful_1",
      paperSize: "a6",
    });

    expect(result.status).toBe(502);
    if (result.status === 502) {
      expect(result.body.message).toMatch(/Parcel not found/);
    }
  });
});
