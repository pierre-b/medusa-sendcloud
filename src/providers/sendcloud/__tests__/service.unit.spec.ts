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

    it("accepts alphanumeric carrier service-point ids verbatim", async () => {
      const result = await buildProvider().validateFulfillmentData(
        optionWithServicePoint,
        { service_point_id: "NL-123456" },
        emptyContext
      );

      expect(result).toEqual({
        service_point_id: "NL-123456",
        sendcloud_service_point_id: "NL-123456",
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

  describe("calculatePrice", () => {
    type CalculatePriceContext = Parameters<
      SendCloudFulfillmentProvider["calculatePrice"]
    >[2];

    const optionData = {
      sendcloud_code: sampleOption.code,
    };

    const methodData = {} as Parameters<
      SendCloudFulfillmentProvider["calculatePrice"]
    >[1];

    const buildItem = (
      overrides: {
        weight?: number;
        length?: number;
        width?: number;
        height?: number;
        quantity?: number;
      } = {}
    ) =>
      ({
        quantity: overrides.quantity ?? 1,
        variant: {
          id: "var_1",
          weight: overrides.weight ?? 500,
          length: overrides.length ?? 10,
          width: overrides.width ?? 10,
          height: overrides.height ?? 10,
          material: "",
          product: { id: "prod_1" },
        },
        product: {
          id: "prod_1",
          collection_id: "",
          categories: [],
          tags: [],
        },
      }) as unknown as CalculatePriceContext["items"][number];

    const buildContext = (
      overrides: Partial<{
        fromCountry?: string;
        toCountry?: string;
        toPostal?: string;
        items: CalculatePriceContext["items"];
      }> = {}
    ): CalculatePriceContext =>
      ({
        id: "cart_1",
        shipping_address: {
          country_code: overrides.toCountry ?? "NL",
          postal_code: overrides.toPostal ?? "1012AB",
        } as unknown as CalculatePriceContext["shipping_address"],
        items: overrides.items ?? [buildItem()],
        ...(overrides.fromCountry !== undefined
          ? {
              from_location: {
                address: { country_code: overrides.fromCountry },
              },
            }
          : {}),
      }) as unknown as CalculatePriceContext;

    const quoteResponse = {
      data: [
        {
          ...sampleOption,
          quotes: [
            {
              weight: {
                min: { value: "0.001", unit: "kg" },
                max: { value: "23.000", unit: "kg" },
              },
              price: {
                breakdown: [
                  {
                    type: "price_without_insurance",
                    label: "Label",
                    price: { value: "15.50", currency: "EUR" },
                  },
                ],
                total: { value: "17.50", currency: "EUR" },
              },
              lead_time: 24,
            },
          ],
        },
      ],
      message: null,
    };

    const buildProvider = (
      extra: Partial<
        ConstructorParameters<typeof SendCloudFulfillmentProvider>[1]
      > = {}
    ) =>
      new SendCloudFulfillmentProvider(
        { logger: noopLogger },
        { ...validOptions, retryBaseDelayMs: 0, ...extra }
      );

    it("returns SendCloud's quote total and marks it tax-exclusive", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(200, quoteResponse);

      const result = await buildProvider().calculatePrice(
        optionData,
        methodData,
        buildContext({ fromCountry: "FR" })
      );

      expect(result).toEqual({
        calculated_amount: 17.5,
        is_calculated_price_tax_inclusive: false,
      });
      expect(capturedBody).toMatchObject({
        shipping_option_code: sampleOption.code,
        from_country_code: "FR",
        to_country_code: "NL",
        to_postal_code: "1012AB",
        calculate_quotes: true,
      });
      const parcels = (capturedBody as { parcels: unknown[] }).parcels;
      expect(parcels).toHaveLength(1);
    });

    it("falls back to defaultFromCountryCode when from_location is absent", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(200, quoteResponse);

      const provider = buildProvider({ defaultFromCountryCode: "BE" });

      await provider.calculatePrice(optionData, methodData, buildContext({}));

      expect(capturedBody).toMatchObject({ from_country_code: "BE" });
    });

    it("throws INVALID_DATA when shipping_address.country_code is missing", async () => {
      await expect(
        buildProvider().calculatePrice(
          optionData,
          methodData,
          buildContext({ toCountry: "" })
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/country_code/),
      });
    });

    it("throws INVALID_DATA when neither from_location nor defaultFromCountryCode is set", async () => {
      await expect(
        buildProvider().calculatePrice(optionData, methodData, buildContext({}))
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/defaultFromCountryCode|from_location/),
      });
    });

    it("throws INVALID_DATA when defaultFromCountryCode is whitespace-only", async () => {
      await expect(
        buildProvider({ defaultFromCountryCode: "   " }).calculatePrice(
          optionData,
          methodData,
          buildContext({})
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
      });
    });

    it("throws INVALID_DATA when cart has no weight and no volume", async () => {
      const emptyItem = buildItem({
        weight: 0,
        length: 0,
        width: 0,
        height: 0,
      });

      await expect(
        buildProvider().calculatePrice(
          optionData,
          methodData,
          buildContext({ fromCountry: "FR", items: [emptyItem] })
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/weight|dimensions/i),
      });
    });

    it("throws UNEXPECTED_STATE when SendCloud returns an empty data array", async () => {
      nock(BASE).post(PATH).reply(200, { data: [], message: "no match" });

      await expect(
        buildProvider().calculatePrice(
          optionData,
          methodData,
          buildContext({ fromCountry: "FR" })
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.UNEXPECTED_STATE,
      });
    });

    it("throws UNEXPECTED_STATE when the first option has no quotes", async () => {
      nock(BASE)
        .post(PATH)
        .reply(200, {
          data: [{ ...sampleOption, quotes: [] }],
          message: null,
        });

      await expect(
        buildProvider().calculatePrice(
          optionData,
          methodData,
          buildContext({ fromCountry: "FR" })
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.UNEXPECTED_STATE,
      });
    });

    it("converts variant.weight to kg according to weightUnit", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(200, quoteResponse);

      const provider = buildProvider({ weightUnit: "kg" });
      const item = buildItem({
        weight: 2,
        quantity: 3,
        length: 10,
        width: 10,
        height: 10,
      });

      await provider.calculatePrice(
        optionData,
        methodData,
        buildContext({ fromCountry: "FR", items: [item] })
      );

      const parcel = (
        capturedBody as { parcels: Array<Record<string, unknown>> }
      ).parcels[0];
      expect(parcel.weight).toEqual({ value: "6.000", unit: "kg" });
    });

    it("derives a cubic bounding box from summed item volumes", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(200, quoteResponse);

      const item = buildItem({
        length: 10,
        width: 10,
        height: 10,
        quantity: 9,
      });

      await buildProvider().calculatePrice(
        optionData,
        methodData,
        buildContext({ fromCountry: "FR", items: [item] })
      );

      const parcel = (
        capturedBody as { parcels: Array<Record<string, unknown>> }
      ).parcels[0];
      const dimensions = parcel.dimensions as Record<string, string>;
      const expectedSide = Math.cbrt(9000).toFixed(2);
      expect(dimensions).toEqual({
        length: expectedSide,
        width: expectedSide,
        height: expectedSide,
        unit: "cm",
      });
    });
  });

  describe("next cycle", () => {
    it.todo("createFulfillment — §3.6");
  });
});
