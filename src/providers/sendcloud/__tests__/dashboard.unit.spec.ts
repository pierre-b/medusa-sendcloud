import nock from "nock";

import {
  DEFAULT_SENDCLOUD_BASE_URL,
  SendCloudClient,
} from "../../../services/sendcloud-client";
import { SHIPPING_OPTIONS_PATH, fetchDashboardSnapshot } from "../dashboard";
import { buildProviderRegistrationKey } from "../registration";

const PROVIDER_KEY = buildProviderRegistrationKey("sendcloud");

const sampleOption = {
  code: "postnl:standard",
  name: "PostNL Standard",
  carrier: { code: "postnl", name: "PostNL" },
  product: { code: "postnl:standard", name: "PostNL Standard" },
  functionalities: {},
  requirements: {
    fields: [],
    export_documents: false,
    is_service_point_required: false,
  },
  charging_type: "label_creation",
};

describe("fetchDashboardSnapshot", () => {
  const client = new SendCloudClient({
    publicKey: "pub",
    privateKey: "priv",
    retryBaseDelayMs: 0,
  });

  const buildContainer = () => {
    const scope: Record<string, unknown> = {
      [PROVIDER_KEY]: { client_: client },
    };
    return {
      resolve: jest.fn((key: string) => {
        if (!(key in scope)) throw new Error(`no registration for ${key}`);
        return scope[key];
      }),
    } as unknown as Parameters<typeof fetchDashboardSnapshot>[0];
  };

  it("returns connected + shipping_options on a 200 response", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .post(SHIPPING_OPTIONS_PATH, {})
      .reply(200, { data: [sampleOption], message: null });

    const result = await fetchDashboardSnapshot(buildContainer(), PROVIDER_KEY);

    expect(result).toEqual({
      connected: true,
      shipping_options: [sampleOption],
    });
  });

  it("flags credentials errors (401) as disconnected", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .post(SHIPPING_OPTIONS_PATH)
      .reply(401, {
        errors: [{ code: "authentication_failed", detail: "Bad credentials" }],
      });

    const result = await fetchDashboardSnapshot(buildContainer(), PROVIDER_KEY);

    expect(result.connected).toBe(false);
    expect(result.shipping_options).toEqual([]);
    expect(result.error).toMatch(/credentials/i);
  });

  it("surfaces other upstream failures as the generic error", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .post(SHIPPING_OPTIONS_PATH)
      .times(4)
      .reply(500);

    const result = await fetchDashboardSnapshot(buildContainer(), PROVIDER_KEY);

    expect(result.connected).toBe(false);
    expect(result.shipping_options).toEqual([]);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/SendCloud/);
  });

  it("returns not-registered state when the provider is missing", async () => {
    const container = {
      resolve: jest.fn(() => {
        throw new Error("not registered");
      }),
    } as unknown as Parameters<typeof fetchDashboardSnapshot>[0];

    const result = await fetchDashboardSnapshot(container, PROVIDER_KEY);

    expect(result.connected).toBe(false);
    expect(result.shipping_options).toEqual([]);
    expect(result.error).toMatch(/not registered/i);
  });
});
