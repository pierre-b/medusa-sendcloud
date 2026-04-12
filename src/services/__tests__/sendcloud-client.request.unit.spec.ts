import nock from "nock";

import { MedusaError } from "@medusajs/framework/utils";

import { SendCloudClient } from "../sendcloud-client";

const BASE = "https://panel.sendcloud.sc";
const PATH = "/api/v3/shipping-options";
const EXPECTED_AUTH = `Basic ${Buffer.from("pub:priv", "utf8").toString("base64")}`;

const buildClient = () =>
  new SendCloudClient({
    publicKey: "pub",
    privateKey: "priv",
    retryBaseDelayMs: 0,
  });

describe("SendCloudClient.request", () => {
  describe("happy path", () => {
    it("returns parsed JSON on 200", async () => {
      nock(BASE)
        .post(PATH, {})
        .matchHeader("authorization", EXPECTED_AUTH)
        .matchHeader("content-type", "application/json")
        .reply(200, { data: [], message: null });

      const client = buildClient();
      const result = await client.request<{
        data: unknown[];
        message: string | null;
      }>({
        method: "POST",
        path: PATH,
        body: {},
      });

      expect(result).toEqual({ data: [], message: null });
      expect(nock.isDone()).toBe(true);
    });

    it("sends the request body as JSON", async () => {
      let capturedBody: unknown;
      nock(BASE)
        .post(PATH, (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, { data: [], message: null });

      const client = buildClient();
      await client.request({
        method: "POST",
        path: PATH,
        body: { from_country_code: "NL", to_country_code: "NL" },
      });

      expect(capturedBody).toEqual({
        from_country_code: "NL",
        to_country_code: "NL",
      });
    });
  });

  describe("retries", () => {
    it("retries once on 429 with Retry-After then succeeds", async () => {
      nock(BASE).post(PATH).reply(429, "", { "Retry-After": "0" });
      nock(BASE).post(PATH).reply(200, { data: [], message: null });

      const client = buildClient();
      const result = await client.request({ method: "POST", path: PATH });

      expect(result).toEqual({ data: [], message: null });
      expect(nock.isDone()).toBe(true);
    });

    it("retries 5xx with exponential backoff up to 3 times, then succeeds", async () => {
      nock(BASE).post(PATH).reply(500, "");
      nock(BASE).post(PATH).reply(502, "");
      nock(BASE).post(PATH).reply(200, { data: [], message: null });

      const client = buildClient();
      const result = await client.request({ method: "POST", path: PATH });

      expect(result).toEqual({ data: [], message: null });
      expect(nock.isDone()).toBe(true);
    });

    it("throws UNEXPECTED_STATE after 3 consecutive 5xx responses", async () => {
      nock(BASE)
        .post(PATH)
        .times(4)
        .reply(503, {
          errors: [{ code: "invalid", detail: "upstream down" }],
        });

      const client = buildClient();
      await expect(
        client.request({ method: "POST", path: PATH })
      ).rejects.toThrow(/SendCloud/);
      expect(nock.isDone()).toBe(true);
    });
  });

  describe("non-retryable errors", () => {
    it("throws INVALID_DATA on 400 without retry", async () => {
      nock(BASE)
        .post(PATH)
        .reply(400, {
          errors: [
            { status: "400", code: "invalid", detail: "Invalid contract." },
          ],
        });

      const client = buildClient();
      await expect(
        client.request({ method: "POST", path: PATH })
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/Invalid contract/),
      });
    });

    it("throws UNAUTHORIZED on 401", async () => {
      nock(BASE)
        .post(PATH)
        .reply(401, {
          errors: [
            { code: "authentication_failed", detail: "Bad credentials" },
          ],
        });

      const client = buildClient();
      await expect(
        client.request({ method: "POST", path: PATH })
      ).rejects.toMatchObject({
        type: MedusaError.Types.UNAUTHORIZED,
      });
    });

    it("throws FORBIDDEN on 403", async () => {
      nock(BASE)
        .post(PATH)
        .reply(403, { errors: [{ code: "forbidden", detail: "No access" }] });

      const client = buildClient();
      await expect(
        client.request({ method: "POST", path: PATH })
      ).rejects.toMatchObject({
        type: MedusaError.Types.FORBIDDEN,
      });
    });

    it("throws NOT_FOUND on 404", async () => {
      nock(BASE)
        .post(PATH)
        .reply(404, {
          errors: [{ code: "not_found", detail: "Resource missing" }],
        });

      const client = buildClient();
      await expect(
        client.request({ method: "POST", path: PATH })
      ).rejects.toMatchObject({
        type: MedusaError.Types.NOT_FOUND,
      });
    });
  });

  describe("network errors", () => {
    it("retries network errors up to maxRetries then throws UNEXPECTED_STATE", async () => {
      nock(BASE).post(PATH).times(4).replyWithError("ECONNRESET");

      const client = buildClient();
      await expect(
        client.request({ method: "POST", path: PATH })
      ).rejects.toMatchObject({
        type: MedusaError.Types.UNEXPECTED_STATE,
      });
      expect(nock.isDone()).toBe(true);
    });
  });
});
