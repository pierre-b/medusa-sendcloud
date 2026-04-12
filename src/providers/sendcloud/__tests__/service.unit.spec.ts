import nock from "nock";

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

  describe("next cycle", () => {
    it.todo("validateOption accepts a SendCloud code that exists (§3.2)");
  });
});
