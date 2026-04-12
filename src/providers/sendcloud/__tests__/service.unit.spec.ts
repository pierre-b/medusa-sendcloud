import nock from "nock";

import { MedusaError } from "@medusajs/framework/utils";
import type { Logger } from "@medusajs/framework/types";

import SendCloudFulfillmentProvider from "../service";
import type { SendCloudShippingOption } from "../../../types/sendcloud-api";

const BASE = "https://panel.sendcloud.sc";
const PATH = "/api/v3/shipping-options";
const EXPECTED_AUTH = `Basic ${Buffer.from("pub:priv", "utf8").toString("base64")}`;

const sampleOption: SendCloudShippingOption = {
  code: "postnl:standard/signature",
  name: "PostNL Standard + Handtekening",
  carrier: { code: "postnl", name: "PostNL" },
  product: { code: "postnl:standard", name: "PostNL Standard" },
  functionalities: { b2c: true, tracked: true, signature: true },
  requirements: {
    fields: [],
    export_documents: false,
    is_service_point_required: false,
  },
  charging_type: "label_creation",
};

const sampleServicePointOption: SendCloudShippingOption = {
  code: "postnl:servicepoint",
  name: "PostNL Service Point",
  carrier: { code: "postnl", name: "PostNL" },
  product: { code: "postnl:servicepoint", name: "PostNL Service Point" },
  functionalities: { b2c: true, last_mile: "service_point" },
  requirements: {
    fields: [],
    export_documents: false,
    is_service_point_required: true,
  },
  charging_type: "label_creation",
};

const noopLogger = {
  panic: jest.fn(),
  shouldLog: jest.fn(),
  setLogLevel: jest.fn(),
  unsetLogLevel: jest.fn(),
  activity: jest.fn(),
  progress: jest.fn(),
  error: jest.fn(),
  failure: jest.fn(),
  success: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  log: jest.fn(),
} as unknown as Logger;

const validOptions = { publicKey: "pub", privateKey: "priv" };

describe("SendCloudFulfillmentProvider", () => {
  describe("identifier", () => {
    it("is the static string 'sendcloud'", () => {
      expect(SendCloudFulfillmentProvider.identifier).toBe("sendcloud");
    });
  });

  describe("constructor", () => {
    it("throws when publicKey is missing", () => {
      expect(
        () =>
          new SendCloudFulfillmentProvider(
            { logger: noopLogger },
            { publicKey: "", privateKey: "priv" }
          )
      ).toThrow(/publicKey/);
    });

    it("throws when privateKey is missing", () => {
      expect(
        () =>
          new SendCloudFulfillmentProvider(
            { logger: noopLogger },
            { publicKey: "pub", privateKey: "" }
          )
      ).toThrow(/privateKey/);
    });

    it("constructs with valid options", () => {
      expect(
        () =>
          new SendCloudFulfillmentProvider({ logger: noopLogger }, validOptions)
      ).not.toThrow();
    });
  });

  describe("getFulfillmentOptions", () => {
    const buildProvider = () =>
      new SendCloudFulfillmentProvider(
        { logger: noopLogger },
        { ...validOptions, retryBaseDelayMs: 0 }
      );

    it("POSTs an empty body to /api/v3/shipping-options with Basic Auth", async () => {
      let capturedBody: unknown;
      nock(BASE)
        .post(PATH, (body) => {
          capturedBody = body;
          return true;
        })
        .matchHeader("authorization", EXPECTED_AUTH)
        .matchHeader("content-type", "application/json")
        .reply(200, { data: [sampleOption], message: null });

      await buildProvider().getFulfillmentOptions();

      expect(capturedBody).toEqual({});
      expect(nock.isDone()).toBe(true);
    });

    it("maps the v3 response to FulfillmentOption[] keyed by sendcloud_{code}", async () => {
      nock(BASE)
        .post(PATH)
        .reply(200, {
          data: [sampleOption, sampleServicePointOption],
          message: null,
        });

      const options = await buildProvider().getFulfillmentOptions();

      expect(options).toEqual([
        {
          id: "sendcloud_postnl:standard/signature",
          name: "PostNL Standard + Handtekening",
          sendcloud_code: "postnl:standard/signature",
          sendcloud_carrier_code: "postnl",
          sendcloud_carrier_name: "PostNL",
          sendcloud_product_code: "postnl:standard",
          sendcloud_requires_service_point: false,
          sendcloud_functionalities: sampleOption.functionalities,
        },
        {
          id: "sendcloud_postnl:servicepoint",
          name: "PostNL Service Point",
          sendcloud_code: "postnl:servicepoint",
          sendcloud_carrier_code: "postnl",
          sendcloud_carrier_name: "PostNL",
          sendcloud_product_code: "postnl:servicepoint",
          sendcloud_requires_service_point: true,
          sendcloud_functionalities: sampleServicePointOption.functionalities,
        },
      ]);
    });

    it("returns [] when SendCloud returns data: null (no active options)", async () => {
      nock(BASE).post(PATH).reply(200, {
        data: null,
        message: "No active shipping options",
      });

      expect(await buildProvider().getFulfillmentOptions()).toEqual([]);
    });
  });

  describe("validateOption", () => {
    const buildProvider = () =>
      new SendCloudFulfillmentProvider(
        { logger: noopLogger },
        { ...validOptions, retryBaseDelayMs: 0 }
      );

    it("returns true when SendCloud response contains a matching code", async () => {
      nock(BASE)
        .post(PATH, { shipping_option_code: sampleOption.code })
        .reply(200, { data: [sampleOption], message: null });

      const result = await buildProvider().validateOption({
        sendcloud_code: sampleOption.code,
      });

      expect(result).toBe(true);
      expect(nock.isDone()).toBe(true);
    });

    it("returns false when SendCloud returns empty data", async () => {
      nock(BASE)
        .post(PATH, { shipping_option_code: "postnl:unknown" })
        .reply(200, { data: [], message: "no match" });

      const result = await buildProvider().validateOption({
        sendcloud_code: "postnl:unknown",
      });

      expect(result).toBe(false);
    });

    it("returns false when response has options but none match the requested code", async () => {
      nock(BASE)
        .post(PATH, { shipping_option_code: "postnl:wanted" })
        .reply(200, { data: [sampleOption], message: null });

      const result = await buildProvider().validateOption({
        sendcloud_code: "postnl:wanted",
      });

      expect(result).toBe(false);
    });

    it("throws INVALID_DATA when sendcloud_code is missing", async () => {
      await expect(buildProvider().validateOption({})).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/sendcloud_code/),
      });
    });

    it("throws INVALID_DATA when sendcloud_code is an empty string", async () => {
      await expect(
        buildProvider().validateOption({ sendcloud_code: "" })
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
      });
    });

    it("throws INVALID_DATA when sendcloud_code is whitespace-only", async () => {
      await expect(
        buildProvider().validateOption({ sendcloud_code: "   " })
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
      });
    });

    it("propagates UNAUTHORIZED from the client without catching", async () => {
      nock(BASE)
        .post(PATH, { shipping_option_code: sampleOption.code })
        .reply(401, {
          errors: [
            { code: "authentication_failed", detail: "Bad credentials" },
          ],
        });

      await expect(
        buildProvider().validateOption({ sendcloud_code: sampleOption.code })
      ).rejects.toMatchObject({
        type: MedusaError.Types.UNAUTHORIZED,
      });
    });
  });

  describe("canCalculate", () => {
    it("always returns true", async () => {
      const provider = new SendCloudFulfillmentProvider(
        { logger: noopLogger },
        validOptions
      );

      await expect(
        provider.canCalculate({ id: "so_test" } as unknown as Parameters<
          typeof provider.canCalculate
        >[0])
      ).resolves.toBe(true);
    });
  });

  describe("validateFulfillmentData", () => {
    const buildProvider = () =>
      new SendCloudFulfillmentProvider(
        { logger: noopLogger },
        { ...validOptions, retryBaseDelayMs: 0 }
      );
    const emptyContext = {} as unknown as Parameters<
      SendCloudFulfillmentProvider["validateFulfillmentData"]
    >[2];

    const optionWithoutServicePoint = {
      sendcloud_code: sampleOption.code,
      sendcloud_requires_service_point: false,
    };
    const optionWithServicePoint = {
      sendcloud_code: sampleServicePointOption.code,
      sendcloud_requires_service_point: true,
    };

    it("returns the data unchanged when service point is not required", async () => {
      const data = { custom_field: "preserved" };

      const result = await buildProvider().validateFulfillmentData(
        optionWithoutServicePoint,
        data,
        emptyContext
      );

      expect(result).toEqual(data);
    });

    it("returns data enriched with sendcloud_service_point_id when required and present", async () => {
      const data = { service_point_id: 12345, custom_field: "preserved" };

      const result = await buildProvider().validateFulfillmentData(
        optionWithServicePoint,
        data,
        emptyContext
      );

      expect(result).toEqual({
        service_point_id: 12345,
        custom_field: "preserved",
        sendcloud_service_point_id: "12345",
      });
    });

    it("throws INVALID_DATA when service point is required but service_point_id is missing", async () => {
      await expect(
        buildProvider().validateFulfillmentData(
          optionWithServicePoint,
          {},
          emptyContext
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/service point/i),
      });
    });

    it.each([
      { case: "zero", id: 0 },
      { case: "negative", id: -1 },
      { case: "NaN", id: Number.NaN },
      { case: "Infinity", id: Number.POSITIVE_INFINITY },
      { case: "whitespace-only string", id: "   " },
      { case: "boolean", id: true },
      { case: "array", id: [12345] },
    ])("throws INVALID_DATA when service_point_id is $case", async ({ id }) => {
      await expect(
        buildProvider().validateFulfillmentData(
          optionWithServicePoint,
          { service_point_id: id },
          emptyContext
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/service point/i),
      });
    });

    it("throws INVALID_DATA when optionData is missing sendcloud_code", async () => {
      await expect(
        buildProvider().validateFulfillmentData(
          {},
          { service_point_id: "x" },
          emptyContext
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/sendcloud_code/),
      });
    });
  });

  describe("next cycle", () => {
    it.todo("returns quote price for calculatePrice — §3.4");
  });
});
