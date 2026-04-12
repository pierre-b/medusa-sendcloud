import nock from "nock";

import { MedusaError } from "@medusajs/framework/utils";

import {
  DEFAULT_SENDCLOUD_BASE_URL,
  SendCloudClient,
} from "../../../services/sendcloud-client";
import { parseBulkLabelRequest } from "../helpers";
import { BULK_LABELS_PATH, fetchSendcloudBulkLabels } from "../bulk-labels";
import { buildProviderRegistrationKey } from "../service-points";

const PROVIDER_KEY = buildProviderRegistrationKey("sendcloud");

describe("parseBulkLabelRequest", () => {
  it("rejects non-object body", () => {
    expect(parseBulkLabelRequest(null)).toEqual({
      ok: false,
      error: expect.stringMatching(/JSON object/),
    });
    expect(parseBulkLabelRequest("nope")).toMatchObject({ ok: false });
    expect(parseBulkLabelRequest([])).toMatchObject({ ok: false });
  });

  it("rejects missing fulfillment_ids", () => {
    const result = parseBulkLabelRequest({});
    expect(result.ok).toBe(false);
  });

  it("rejects empty fulfillment_ids array", () => {
    const result = parseBulkLabelRequest({ fulfillment_ids: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least one/);
  });

  it("rejects more than 20 fulfillment_ids", () => {
    const result = parseBulkLabelRequest({
      fulfillment_ids: Array.from({ length: 21 }, (_, i) => `ful_${i}`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/maximum of 20/);
  });

  it("rejects non-string or empty ids inside the array", () => {
    expect(
      parseBulkLabelRequest({ fulfillment_ids: ["ful_1", ""] })
    ).toMatchObject({ ok: false });
    expect(
      parseBulkLabelRequest({ fulfillment_ids: ["ful_1", 42] })
    ).toMatchObject({ ok: false });
  });

  it("accepts valid input and defaults paper_size to a6", () => {
    const result = parseBulkLabelRequest({
      fulfillment_ids: ["ful_1", "ful_2"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        fulfillmentIds: ["ful_1", "ful_2"],
        paperSize: "a6",
      });
    }
  });

  it("honours a valid paper_size", () => {
    const result = parseBulkLabelRequest({
      fulfillment_ids: ["ful_1"],
      paper_size: "a4",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.paperSize).toBe("a4");
  });

  it("rejects invalid paper_size", () => {
    const result = parseBulkLabelRequest({
      fulfillment_ids: ["ful_1"],
      paper_size: "letter",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/paper_size/);
  });
});

describe("fetchSendcloudBulkLabels", () => {
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
      __graph: graph,
    } as unknown as Parameters<typeof fetchSendcloudBulkLabels>[0] & {
      __graph: jest.Mock;
    };
  };

  it("streams the PDF and asserts repeated parcels query params", async () => {
    const pdfBody = Buffer.from("%PDF-1.4 fake-pdf");
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get(BULK_LABELS_PATH)
      .query({ parcels: ["111", "222"], paper_size: "a6" })
      .reply(200, pdfBody, { "content-type": "application/pdf" });

    const container = buildContainer([
      { id: "ful_1", data: { sendcloud_parcel_id: 111 } },
      { id: "ful_2", data: { sendcloud_parcel_id: 222 } },
    ]);

    const result = await fetchSendcloudBulkLabels(container, PROVIDER_KEY, {
      fulfillmentIds: ["ful_1", "ful_2"],
      paperSize: "a6",
    });

    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.contentType).toBe("application/pdf");
      expect(result.body.toString("utf8")).toBe("%PDF-1.4 fake-pdf");
    }
    expect(nock.isDone()).toBe(true);
  });

  it("returns 400 when some fulfillment ids aren't found", async () => {
    const container = buildContainer([
      { id: "ful_1", data: { sendcloud_parcel_id: 111 } },
    ]);

    const result = await fetchSendcloudBulkLabels(container, PROVIDER_KEY, {
      fulfillmentIds: ["ful_1", "ful_missing"],
      paperSize: "a6",
    });

    expect(result.status).toBe(400);
    if (result.status === 400) {
      expect(result.body.message).toMatch(/ful_missing/);
    }
  });

  it("returns 400 when any fulfillment is missing sendcloud_parcel_id", async () => {
    const container = buildContainer([
      { id: "ful_1", data: { sendcloud_parcel_id: 111 } },
      { id: "ful_2", data: {} },
    ]);

    const result = await fetchSendcloudBulkLabels(container, PROVIDER_KEY, {
      fulfillmentIds: ["ful_1", "ful_2"],
      paperSize: "a6",
    });

    expect(result.status).toBe(400);
    if (result.status === 400) {
      expect(result.body.message).toMatch(/ful_2/);
      expect(result.body.message).toMatch(/sendcloud_parcel_id/);
    }
  });

  it("returns 502 when the fulfillment provider is not registered", async () => {
    const container = {
      resolve: jest.fn(() => {
        throw new Error("not registered");
      }),
    } as unknown as Parameters<typeof fetchSendcloudBulkLabels>[0];

    const result = await fetchSendcloudBulkLabels(container, PROVIDER_KEY, {
      fulfillmentIds: ["ful_1"],
      paperSize: "a6",
    });

    expect(result.status).toBe(502);
  });

  it("returns 502 when Query.graph throws", async () => {
    const scope: Record<string, unknown> = {
      [PROVIDER_KEY]: { client_: client },
      query: {
        graph: jest.fn(async () => {
          throw new Error("db connection lost");
        }),
      },
    };
    const container = {
      resolve: jest.fn((key: string) => {
        if (!(key in scope)) throw new Error(`no registration for ${key}`);
        return scope[key];
      }),
    } as unknown as Parameters<typeof fetchSendcloudBulkLabels>[0];

    const result = await fetchSendcloudBulkLabels(container, PROVIDER_KEY, {
      fulfillmentIds: ["ful_1"],
      paperSize: "a6",
    });

    expect(result.status).toBe(502);
    if (result.status === 502) {
      expect(result.body.message).toMatch(/db connection lost/);
    }
  });

  it("wraps upstream 404 as a 502 with the SendCloud message", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get(BULK_LABELS_PATH)
      .query(true)
      .reply(404, {
        errors: [
          {
            code: "not_found",
            detail: "No Parcel matches the given query.",
          },
        ],
      });

    const container = buildContainer([
      { id: "ful_1", data: { sendcloud_parcel_id: 111 } },
    ]);

    const result = await fetchSendcloudBulkLabels(container, PROVIDER_KEY, {
      fulfillmentIds: ["ful_1"],
      paperSize: "a6",
    });

    expect(result.status).toBe(502);
    if (result.status === 502) {
      expect(result.body.message).toMatch(/No Parcel matches/);
    }
  });
});

describe("SendCloudClient.requestBinary + array query", () => {
  const client = new SendCloudClient({
    publicKey: "pub",
    privateKey: "priv",
    retryBaseDelayMs: 0,
  });

  it("appends each array value as a repeated query param", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get("/api/v3/parcel-documents/label")
      .query({ parcels: ["1", "2", "3"] })
      .reply(200, Buffer.from("pdf"), { "content-type": "application/pdf" });

    const result = await client.requestBinary({
      method: "GET",
      path: "/api/v3/parcel-documents/label",
      query: { parcels: [1, 2, 3] },
    });

    expect(result.body.toString("utf8")).toBe("pdf");
  });

  it("maps upstream 404 to NOT_FOUND", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get("/api/v3/parcel-documents/label")
      .query(true)
      .reply(404, {
        errors: [{ code: "not_found", detail: "No Parcel matches" }],
      });

    await expect(
      client.requestBinary({
        method: "GET",
        path: "/api/v3/parcel-documents/label",
        query: { parcels: [999] },
      })
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
  });
});
