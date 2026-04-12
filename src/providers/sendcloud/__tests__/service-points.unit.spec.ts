import nock from "nock";

import { SendCloudClient } from "../../../services/sendcloud-client";
import { parseServicePointsQuery } from "../helpers";
import {
  SERVICE_POINTS_BASE_URL,
  SERVICE_POINTS_PATH,
  buildProviderRegistrationKey,
  fetchSendcloudServicePoints,
} from "../service-points";

const PROVIDER_KEY = buildProviderRegistrationKey("sendcloud");

describe("parseServicePointsQuery", () => {
  it("rejects when country is missing", () => {
    const result = parseServicePointsQuery({ postal_code: "1000AA" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/country/i);
  });

  it("rejects when country is blank", () => {
    const result = parseServicePointsQuery({ country: "   " });
    expect(result.ok).toBe(false);
  });

  it("rejects when country is not two letters", () => {
    const result = parseServicePointsQuery({ country: "USA" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/2-letter/);
  });

  it("uppercases the country code", () => {
    const result = parseServicePointsQuery({ country: "nl" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.country).toBe("NL");
  });

  it("passes through allowed string fields and drops blanks", () => {
    const result = parseServicePointsQuery({
      country: "NL",
      postal_code: "1012AB",
      city: "Amsterdam",
      house_number: "",
      carrier: "postnl",
      latitude: "52.3",
      longitude: "4.9",
      unknown_field: "ignored",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        country: "NL",
        postal_code: "1012AB",
        city: "Amsterdam",
        carrier: "postnl",
        latitude: "52.3",
        longitude: "4.9",
      });
    }
  });

  it("parses radius as a positive integer and drops invalid values", () => {
    const good = parseServicePointsQuery({ country: "NL", radius: "2000.9" });
    expect(good.ok && good.value.radius).toBe(2000);

    const zero = parseServicePointsQuery({ country: "NL", radius: "0" });
    expect(zero.ok && zero.value.radius).toBeUndefined();

    const nan = parseServicePointsQuery({ country: "NL", radius: "abc" });
    expect(nan.ok && nan.value.radius).toBeUndefined();

    const missing = parseServicePointsQuery({ country: "NL", radius: "" });
    expect(missing.ok && missing.value.radius).toBeUndefined();
  });
});

describe("fetchSendcloudServicePoints", () => {
  const client = new SendCloudClient({
    publicKey: "pub",
    privateKey: "priv",
    retryBaseDelayMs: 0,
  });
  const EXPECTED_AUTH = `Basic ${Buffer.from("pub:priv", "utf8").toString("base64")}`;

  const buildContainer = () => {
    const scope: Record<string, unknown> = {
      [PROVIDER_KEY]: { client_: client },
    };
    return {
      resolve: jest.fn((key: string) => {
        if (!(key in scope)) throw new Error(`no registration for ${key}`);
        return scope[key];
      }),
    } as unknown as Parameters<typeof fetchSendcloudServicePoints>[0];
  };

  it("GETs servicepoints.sendcloud.sc with forwarded query params", async () => {
    const responsePoints = [
      {
        id: 12345,
        code: "NL-12345",
        name: "Kiosk Corner",
        street: "Stationsplein",
        house_number: "1",
        postal_code: "1012AB",
        city: "Amsterdam",
        latitude: "52.3",
        longitude: "4.9",
        carrier: "postnl",
        country: "NL",
      },
    ];
    nock(SERVICE_POINTS_BASE_URL)
      .get(SERVICE_POINTS_PATH)
      .query({
        country: "NL",
        postal_code: "1012AB",
        carrier: "postnl",
        radius: "2000",
      })
      .matchHeader("authorization", EXPECTED_AUTH)
      .reply(200, responsePoints);

    const result = await fetchSendcloudServicePoints(
      buildContainer(),
      PROVIDER_KEY,
      {
        country: "NL",
        postal_code: "1012AB",
        carrier: "postnl",
        radius: 2000,
      }
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ service_points: responsePoints });
    expect(nock.isDone()).toBe(true);
  });

  it("wraps upstream 401 as status 502 with message", async () => {
    nock(SERVICE_POINTS_BASE_URL)
      .get(SERVICE_POINTS_PATH)
      .query(true)
      .reply(401, {
        errors: [{ code: "authentication_failed", detail: "Bad credentials" }],
      });

    const result = await fetchSendcloudServicePoints(
      buildContainer(),
      PROVIDER_KEY,
      { country: "NL" }
    );

    expect(result.status).toBe(502);
    expect(result.body).toEqual({
      message: expect.stringMatching(/credentials/i),
    });
  });

  it("returns 502 when the fulfillment provider isn't registered", async () => {
    const container = {
      resolve: jest.fn(() => {
        throw new Error("not registered");
      }),
    } as unknown as Parameters<typeof fetchSendcloudServicePoints>[0];

    const result = await fetchSendcloudServicePoints(container, PROVIDER_KEY, {
      country: "NL",
    });

    expect(result.status).toBe(502);
    expect(result.body).toEqual({
      message: expect.stringMatching(/not registered/i),
    });
  });

  it("returns 502 on a generic network failure", async () => {
    nock(SERVICE_POINTS_BASE_URL)
      .get(SERVICE_POINTS_PATH)
      .query(true)
      .times(4)
      .replyWithError("ECONNRESET");

    const result = await fetchSendcloudServicePoints(
      buildContainer(),
      PROVIDER_KEY,
      { country: "NL" }
    );

    expect(result.status).toBe(502);
  });
});
