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

  describe("createFulfillment", () => {
    const SHIPMENTS_PATH = "/api/v3/shipments/announce-with-shipping-rules";

    const fulfillmentData = {
      sendcloud_code: sampleOption.code,
    };

    const fulfillmentItems = [
      {
        id: "fitem_1",
        title: "Bar of Chocolate",
        quantity: 2,
        sku: "BAR-001",
        barcode: "1234567890",
        line_item_id: "li_1",
        inventory_item_id: null,
      },
    ] as unknown as Parameters<
      SendCloudFulfillmentProvider["createFulfillment"]
    >[1];

    const orderFixture = {
      id: "order_1",
      display_id: 42,
      currency_code: "EUR",
      total: 1850,
      shipping_address: {
        first_name: "Jane",
        last_name: "Doe",
        company: "Acme",
        address_1: "Stadhuisplein",
        address_2: "Apartment 17B",
        city: "Eindhoven",
        country_code: "NL",
        postal_code: "1013 AB",
        phone: "+31988172999",
      },
      items: [
        {
          id: "li_1",
          title: "Bar of Chocolate",
          unit_price: 925,
          quantity: 2,
          variant_sku: "BAR-001",
          product_title: "Dark chocolate bar",
        },
      ],
    } as unknown as Parameters<
      SendCloudFulfillmentProvider["createFulfillment"]
    >[2];

    const fulfillmentFixture = {
      id: "ful_1",
      delivery_address: orderFixture?.shipping_address,
    } as unknown as Parameters<
      SendCloudFulfillmentProvider["createFulfillment"]
    >[3];

    const shipmentResponse = {
      data: {
        id: "XXX-Shipment-id",
        parcels: [
          {
            id: 383707309,
            status: { code: "READY_TO_SEND", message: "Ready to send" },
            documents: [
              {
                type: "label",
                size: "a6",
                link: "https://panel.sendcloud.sc/api/v3/parcels/383707309/documents/label",
              },
            ],
            tracking_number: "3SYZXG8498635",
            tracking_url:
              "https://tracking.eu-central-1-0.sendcloud.sc/forward?carrier=postnl",
            announced_at: "2024-06-06T17:11:14.712398Z",
          },
        ],
        label_details: { mime_type: "application/pdf", dpi: 72 },
        applied_shipping_rules: [],
      },
    };

    const buildProvider = (
      extra: Partial<
        ConstructorParameters<typeof SendCloudFulfillmentProvider>[1]
      > = {}
    ) =>
      new SendCloudFulfillmentProvider(
        { logger: noopLogger },
        { ...validOptions, retryBaseDelayMs: 0, weightUnit: "g", ...extra }
      );

    it("POSTs /shipments/announce-with-shipping-rules and returns tracking + label", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(SHIPMENTS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, shipmentResponse);

      const result = await buildProvider().createFulfillment(
        fulfillmentData,
        fulfillmentItems,
        orderFixture,
        fulfillmentFixture
      );

      expect(capturedBody).toMatchObject({
        ship_with: {
          type: "shipping_option_code",
          properties: { shipping_option_code: sampleOption.code },
        },
        to_address: {
          name: "Jane Doe",
          company_name: "Acme",
          address_line_1: "Stadhuisplein",
          address_line_2: "Apartment 17B",
          city: "Eindhoven",
          postal_code: "1013 AB",
          country_code: "NL",
          phone_number: "+31988172999",
        },
        apply_shipping_rules: true,
        apply_shipping_defaults: true,
        order_number: "42",
        external_reference_id: "ful_1",
        customs_information: {
          invoice_number: "42",
          export_reason: "commercial_goods",
        },
      });

      expect(result.data).toMatchObject({
        sendcloud_shipment_id: "XXX-Shipment-id",
        sendcloud_parcel_id: 383707309,
        tracking_number: "3SYZXG8498635",
        status: { code: "READY_TO_SEND", message: "Ready to send" },
      });
      expect(result.labels).toEqual([
        {
          tracking_number: "3SYZXG8498635",
          tracking_url:
            "https://tracking.eu-central-1-0.sendcloud.sc/forward?carrier=postnl",
          label_url:
            "https://panel.sendcloud.sc/api/v3/parcels/383707309/documents/label",
        },
      ]);
    });

    it("forwards sendcloud_service_point_id as to_service_point.id", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(SHIPMENTS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, shipmentResponse);

      await buildProvider().createFulfillment(
        { ...fulfillmentData, sendcloud_service_point_id: "12345" },
        fulfillmentItems,
        orderFixture,
        fulfillmentFixture
      );

      expect(capturedBody).toMatchObject({
        to_service_point: { id: "12345" },
      });
    });

    it("attaches additional_insured_price when defaultInsuranceAmount is configured", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(SHIPMENTS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, shipmentResponse);

      await buildProvider({ defaultInsuranceAmount: 50 }).createFulfillment(
        fulfillmentData,
        fulfillmentItems,
        orderFixture,
        fulfillmentFixture
      );

      const parcel = (
        capturedBody as { parcels: Array<Record<string, unknown>> }
      ).parcels[0];
      expect(parcel.additional_insured_price).toEqual({
        value: "50",
        currency: "EUR",
      });
    });

    it("respects a custom defaultExportReason plugin option", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(SHIPMENTS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, shipmentResponse);

      await buildProvider({ defaultExportReason: "gift" }).createFulfillment(
        fulfillmentData,
        fulfillmentItems,
        orderFixture,
        fulfillmentFixture
      );

      expect(capturedBody).toMatchObject({
        customs_information: { export_reason: "gift" },
      });
    });

    it("throws INVALID_DATA when sendcloud_code is missing", async () => {
      await expect(
        buildProvider().createFulfillment(
          {},
          fulfillmentItems,
          orderFixture,
          fulfillmentFixture
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/sendcloud_code/),
      });
    });

    it("throws INVALID_DATA when shipping address is missing required fields", async () => {
      const brokenOrder = {
        ...orderFixture,
        shipping_address: { first_name: "Jane" },
      } as unknown as typeof orderFixture;

      await expect(
        buildProvider().createFulfillment(
          fulfillmentData,
          fulfillmentItems,
          brokenOrder,
          {
            ...fulfillmentFixture,
            delivery_address: { first_name: "Jane" },
          } as unknown as typeof fulfillmentFixture
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(
          /address_line_1|postal_code|city|country_code/
        ),
      });
    });

    it("merges variant customs fields from order.metadata.sendcloud_variants into parcel_items", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(SHIPMENTS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, shipmentResponse);

      const orderWithVariants = {
        ...orderFixture,
        items: [
          {
            id: "li_1",
            title: "Bar of Chocolate",
            unit_price: 925,
            quantity: 2,
            variant_id: "var_cocoa",
            variant_sku: "BAR-001",
            product_title: "Dark chocolate bar",
          },
        ],
        metadata: {
          sendcloud_variants: {
            var_cocoa: {
              hs_code: "180690",
              origin_country: "FR",
              weight: 90,
            },
          },
        },
      } as unknown as Parameters<
        SendCloudFulfillmentProvider["createFulfillment"]
      >[2];

      await buildProvider().createFulfillment(
        fulfillmentData,
        fulfillmentItems,
        orderWithVariants,
        fulfillmentFixture
      );

      const parcel = (
        capturedBody as { parcels: Array<Record<string, unknown>> }
      ).parcels[0];
      const parcelItems = parcel.parcel_items as Array<Record<string, unknown>>;
      expect(parcelItems).toHaveLength(1);
      expect(parcelItems[0]).toMatchObject({
        hs_code: "180690",
        origin_country: "FR",
        weight: { value: "0.090", unit: "kg" },
      });
    });

    it("ignores malformed sendcloud_variants (array instead of object)", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(SHIPMENTS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, shipmentResponse);

      const orderWithMalformedMetadata = {
        ...orderFixture,
        items: [
          {
            id: "li_1",
            title: "Bar of Chocolate",
            unit_price: 925,
            quantity: 2,
            variant_id: "var_cocoa",
          },
        ],
        metadata: {
          sendcloud_variants: [] as unknown as Record<string, unknown>,
        },
      } as unknown as Parameters<
        SendCloudFulfillmentProvider["createFulfillment"]
      >[2];

      await buildProvider().createFulfillment(
        fulfillmentData,
        fulfillmentItems,
        orderWithMalformedMetadata,
        fulfillmentFixture
      );

      const parcel = (
        capturedBody as { parcels: Array<Record<string, unknown>> }
      ).parcels[0];
      const parcelItems = parcel.parcel_items as Array<Record<string, unknown>>;
      expect(parcelItems[0]).not.toHaveProperty("hs_code");
      expect(parcelItems[0]).not.toHaveProperty("origin_country");
      expect(parcelItems[0]).not.toHaveProperty("weight");
    });

    it("falls back to basic parcel_items when order.metadata is absent", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(SHIPMENTS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, shipmentResponse);

      await buildProvider().createFulfillment(
        fulfillmentData,
        fulfillmentItems,
        orderFixture,
        fulfillmentFixture
      );

      const parcel = (
        capturedBody as { parcels: Array<Record<string, unknown>> }
      ).parcels[0];
      const parcelItems = parcel.parcel_items as Array<Record<string, unknown>>;
      expect(parcelItems[0]).not.toHaveProperty("hs_code");
      expect(parcelItems[0]).not.toHaveProperty("origin_country");
      expect(parcelItems[0]).not.toHaveProperty("weight");
    });

    it("returns labels: [] when the parcel has no label document yet", async () => {
      const noLabelResponse = {
        data: {
          ...shipmentResponse.data,
          parcels: [{ ...shipmentResponse.data.parcels[0], documents: [] }],
        },
      };
      nock(BASE).post(SHIPMENTS_PATH).reply(201, noLabelResponse);

      const result = await buildProvider().createFulfillment(
        fulfillmentData,
        fulfillmentItems,
        orderFixture,
        fulfillmentFixture
      );

      expect(result.labels).toEqual([]);
      expect(result.data).toMatchObject({
        sendcloud_shipment_id: "XXX-Shipment-id",
        label_url: null,
      });
    });

    it("throws UNEXPECTED_STATE when SendCloud response has no parcels", async () => {
      nock(BASE)
        .post(SHIPMENTS_PATH)
        .reply(201, { data: { id: "s_1", parcels: [] } });

      await expect(
        buildProvider().createFulfillment(
          fulfillmentData,
          fulfillmentItems,
          orderFixture,
          fulfillmentFixture
        )
      ).rejects.toMatchObject({
        type: MedusaError.Types.UNEXPECTED_STATE,
      });
    });

    describe("multi-collo (parcels hint on fulfillment.metadata)", () => {
      const MULTICOLLO_PATH = "/api/v3/shipping-options";
      const multicolloHint = [
        { weight: 1500, length: 30, width: 20, height: 10 },
        { weight: 900, length: 20, width: 15, height: 8 },
      ];

      const multicolloFulfillment = {
        ...fulfillmentFixture,
        metadata: { sendcloud_parcels: multicolloHint },
      } as unknown as Parameters<
        SendCloudFulfillmentProvider["createFulfillment"]
      >[3];

      const multicolloCapabilityResponse = {
        data: [
          {
            code: sampleOption.code,
            name: sampleOption.name,
            carrier: sampleOption.carrier,
            functionalities: { multicollo: true },
            requirements: {
              fields: [],
              export_documents: false,
              is_service_point_required: false,
            },
            charging_type: "label_creation",
          },
        ],
      };

      const buildMultiParcelResponse = (count: number) => ({
        data: {
          id: "XXX-Multi-Shipment-id",
          parcels: Array.from({ length: count }, (_, i) => ({
            id: 500000 + i,
            status: { code: "READY_TO_SEND", message: "Ready to send" },
            documents: [
              {
                type: "label",
                size: "a6",
                link: `https://panel.sendcloud.sc/api/v3/parcels/${500000 + i}/documents/label`,
              },
            ],
            tracking_number: `3SMULTI${i}`,
            tracking_url: `https://tracking.eu-central-1-0.sendcloud.sc/forward?carrier=postnl&p=${i}`,
            announced_at: "2024-06-06T17:11:14.712398Z",
          })),
          label_details: { mime_type: "application/pdf", dpi: 72 },
          applied_shipping_rules: [],
        },
      });

      it("announces N parcels with the exact hint dims when hint has >1 entries", async () => {
        nock(BASE)
          .post(
            MULTICOLLO_PATH,
            (body) =>
              (body as { functionalities?: { multicollo?: boolean } })
                .functionalities?.multicollo === true
          )
          .reply(200, multicolloCapabilityResponse);

        let capturedBody: Record<string, unknown> | undefined;
        nock(BASE)
          .post(SHIPMENTS_PATH, (body) => {
            capturedBody = body as Record<string, unknown>;
            return true;
          })
          .reply(201, buildMultiParcelResponse(2));

        await buildProvider().createFulfillment(
          fulfillmentData,
          fulfillmentItems,
          orderFixture,
          multicolloFulfillment
        );

        const parcels = (
          capturedBody as { parcels: Array<Record<string, unknown>> }
        ).parcels;
        expect(parcels).toHaveLength(2);
        expect(parcels[0]).toMatchObject({
          weight: { value: "1.500", unit: "kg" },
          dimensions: {
            length: "30",
            width: "20",
            height: "10",
            unit: "cm",
          },
        });
        expect(parcels[0].parcel_items).toBeDefined();
        expect(parcels[1]).toMatchObject({
          weight: { value: "0.900", unit: "kg" },
          dimensions: {
            length: "20",
            width: "15",
            height: "8",
            unit: "cm",
          },
        });
        expect(parcels[1].parcel_items).toBeUndefined();
      });

      it("single-entry hint takes the single-parcel path and overrides dims on parcels[0]", async () => {
        let capturedBody: Record<string, unknown> | undefined;
        nock(BASE)
          .post(SHIPMENTS_PATH, (body) => {
            capturedBody = body as Record<string, unknown>;
            return true;
          })
          .reply(201, shipmentResponse);

        const result = await buildProvider().createFulfillment(
          fulfillmentData,
          fulfillmentItems,
          orderFixture,
          {
            ...fulfillmentFixture,
            metadata: {
              sendcloud_parcels: [multicolloHint[0]],
            },
          } as unknown as Parameters<
            SendCloudFulfillmentProvider["createFulfillment"]
          >[3]
        );

        const parcels = (
          capturedBody as { parcels: Array<Record<string, unknown>> }
        ).parcels;
        expect(parcels).toHaveLength(1);
        expect(parcels[0]).toMatchObject({
          weight: { value: "1.500", unit: "kg" },
          dimensions: {
            length: "30",
            width: "20",
            height: "10",
            unit: "cm",
          },
        });
        expect(parcels[0].parcel_items).toBeDefined();
        expect(result.data).not.toHaveProperty("is_multicollo");
        expect(result.data).not.toHaveProperty("parcels");
      });

      it("applies additional_insured_price to every parcel when defaultInsuranceAmount is configured", async () => {
        nock(BASE)
          .post(MULTICOLLO_PATH)
          .reply(200, multicolloCapabilityResponse);

        let capturedBody: Record<string, unknown> | undefined;
        nock(BASE)
          .post(SHIPMENTS_PATH, (body) => {
            capturedBody = body as Record<string, unknown>;
            return true;
          })
          .reply(201, buildMultiParcelResponse(2));

        await buildProvider({ defaultInsuranceAmount: 50 }).createFulfillment(
          fulfillmentData,
          fulfillmentItems,
          orderFixture,
          multicolloFulfillment
        );

        const parcels = (
          capturedBody as { parcels: Array<Record<string, unknown>> }
        ).parcels;
        expect(parcels).toHaveLength(2);
        expect(parcels[0].additional_insured_price).toEqual({
          value: "50",
          currency: "EUR",
        });
        expect(parcels[1].additional_insured_price).toEqual({
          value: "50",
          currency: "EUR",
        });
      });

      it("rejects the hint when carrier does not support multi-collo", async () => {
        nock(BASE).post(MULTICOLLO_PATH).reply(200, { data: [] });

        await expect(
          buildProvider().createFulfillment(
            fulfillmentData,
            fulfillmentItems,
            orderFixture,
            multicolloFulfillment
          )
        ).rejects.toMatchObject({
          type: MedusaError.Types.NOT_ALLOWED,
        });
      });

      it("returns is_multicollo data with parcels[], aggregate_status 'pending', and N labels", async () => {
        nock(BASE)
          .post(MULTICOLLO_PATH)
          .reply(200, multicolloCapabilityResponse);
        nock(BASE).post(SHIPMENTS_PATH).reply(201, buildMultiParcelResponse(3));

        const hint3 = [
          ...multicolloHint,
          { weight: 400, length: 15, width: 10, height: 5 },
        ];

        const result = await buildProvider().createFulfillment(
          fulfillmentData,
          fulfillmentItems,
          orderFixture,
          {
            ...fulfillmentFixture,
            metadata: { sendcloud_parcels: hint3 },
          } as unknown as Parameters<
            SendCloudFulfillmentProvider["createFulfillment"]
          >[3]
        );

        expect(result.data).toMatchObject({
          sendcloud_shipment_id: "XXX-Multi-Shipment-id",
          sendcloud_parcel_id: 500000,
          is_multicollo: true,
          aggregate_status: "pending",
        });
        const parcels = (result.data as { parcels: unknown[] }).parcels;
        expect(parcels).toHaveLength(3);
        expect(result.labels).toHaveLength(3);
      });
    });
  });

  describe("cancelFulfillment", () => {
    const buildProvider = () =>
      new SendCloudFulfillmentProvider(
        { logger: noopLogger },
        { ...validOptions, retryBaseDelayMs: 0 }
      );

    it("returns sendcloud_cancellation when SendCloud responds 200", async () => {
      nock(BASE)
        .post("/api/v3/shipments/ship_1/cancel")
        .reply(200, {
          data: {
            status: "cancelled",
            message: "Shipment has been cancelled",
          },
        });

      const result = await buildProvider().cancelFulfillment({
        sendcloud_shipment_id: "ship_1",
      });

      expect(result).toEqual({
        sendcloud_cancellation: {
          status: "cancelled",
          message: "Shipment has been cancelled",
        },
      });
    });

    it("accepts 202 queued as a success", async () => {
      nock(BASE)
        .post("/api/v3/shipments/ship_1/cancel")
        .reply(202, {
          data: {
            status: "queued",
            message: "Shipment cancellation has been queued",
          },
        });

      const result = await buildProvider().cancelFulfillment({
        sendcloud_shipment_id: "ship_1",
      });

      expect(result).toEqual({
        sendcloud_cancellation: {
          status: "queued",
          message: "Shipment cancellation has been queued",
        },
      });
    });

    it("throws CONFLICT on 409 from SendCloud", async () => {
      nock(BASE)
        .post("/api/v3/shipments/ship_1/cancel")
        .reply(409, {
          errors: [
            {
              status: "409",
              code: "invalid",
              detail: "Shipment already cancelled",
            },
          ],
        });

      await expect(
        buildProvider().cancelFulfillment({ sendcloud_shipment_id: "ship_1" })
      ).rejects.toMatchObject({
        type: MedusaError.Types.CONFLICT,
      });
    });

    it("throws INVALID_DATA when sendcloud_shipment_id missing", async () => {
      await expect(buildProvider().cancelFulfillment({})).rejects.toMatchObject(
        {
          type: MedusaError.Types.INVALID_DATA,
          message: expect.stringMatching(/sendcloud_shipment_id/),
        }
      );
    });

    it("calls return-cancel and returns sendcloud_return_cancellation when data has only sendcloud_return_id", async () => {
      nock(BASE)
        .patch("/api/v3/returns/98765/cancel")
        .reply(202, { message: "Cancellation requested successfully" });

      nock(BASE)
        .get("/api/v3/returns/98765")
        .reply(200, {
          data: { id: 98765, parent_status: "cancelling-upstream" },
        });

      const result = await buildProvider().cancelFulfillment({
        sendcloud_return_id: 98765,
        sendcloud_parcel_id: 12345,
      });

      expect(result).toMatchObject({
        sendcloud_return_cancellation: {
          message: "Cancellation requested successfully",
          parent_status: "cancelling-upstream",
        },
      });
    });
  });

  describe("createReturnFulfillment", () => {
    const RETURNS_PATH = "/api/v3/returns/announce-synchronously";

    const warehouse = {
      first_name: "Warehouse",
      last_name: "Team",
      company: "Chocolaterie",
      address_1: "Rue du Cacao 10",
      city: "Paris",
      country_code: "FR",
      postal_code: "75001",
      phone: "+33100000001",
    };

    const customer = {
      first_name: "Jane",
      last_name: "Doe",
      address_1: "Stadhuisplein",
      address_2: "Apartment 17B",
      city: "Eindhoven",
      country_code: "NL",
      postal_code: "1013 AB",
      phone: "+31988172999",
    };

    const returnFulfillment = {
      data: { sendcloud_code: sampleOption.code },
      location: { address: warehouse },
      delivery_address: customer,
      items: [
        {
          id: "fitem_r1",
          title: "Bar of Chocolate",
          quantity: 1,
          sku: "BAR-001",
          barcode: "1234567890",
          line_item_id: "li_1",
          inventory_item_id: null,
        },
      ],
      order: {
        id: "order_1",
        display_id: 42,
        currency_code: "EUR",
        items: [
          {
            id: "li_1",
            title: "Bar of Chocolate",
            unit_price: 925,
            quantity: 2,
            variant_id: "var_cocoa",
            variant_sku: "BAR-001",
          },
        ],
      },
    } as unknown as Parameters<
      SendCloudFulfillmentProvider["createReturnFulfillment"]
    >[0];

    const returnResponse = {
      return_id: 98765,
      parcel_id: 12345,
      multi_collo_ids: [],
    };

    const buildProvider = (
      extra: Partial<
        ConstructorParameters<typeof SendCloudFulfillmentProvider>[1]
      > = {}
    ) =>
      new SendCloudFulfillmentProvider(
        { logger: noopLogger },
        { ...validOptions, retryBaseDelayMs: 0, weightUnit: "g", ...extra }
      );

    it("POSTs /returns/announce-synchronously with inverted addresses and returns label URL", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(RETURNS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, returnResponse);

      const result =
        await buildProvider().createReturnFulfillment(returnFulfillment);

      expect(capturedBody).toMatchObject({
        shipping_option: { code: sampleOption.code },
        from_address: {
          name: "Jane Doe",
          address_line_1: "Stadhuisplein",
          city: "Eindhoven",
          country_code: "NL",
          postal_code: "1013 AB",
        },
        to_address: {
          name: "Warehouse Team",
          company_name: "Chocolaterie",
          address_line_1: "Rue du Cacao 10",
          city: "Paris",
          country_code: "FR",
          postal_code: "75001",
        },
        order_number: "42",
        customs_invoice_nr: "42",
        send_tracking_emails: true,
      });

      expect(result.data).toMatchObject({
        sendcloud_return_id: 98765,
        sendcloud_parcel_id: 12345,
        sendcloud_multi_collo_ids: [],
        label_url:
          "https://panel.sendcloud.sc/api/v3/parcels/12345/documents/label",
        tracking_number: null,
        tracking_url: null,
      });
      expect(result.labels).toEqual([
        {
          tracking_number: "",
          tracking_url: "",
          label_url:
            "https://panel.sendcloud.sc/api/v3/parcels/12345/documents/label",
        },
      ]);
    });

    it("merges variant customs fields into return parcel_items", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(RETURNS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, returnResponse);

      const enriched = {
        ...returnFulfillment,
        order: {
          ...(returnFulfillment as { order: Record<string, unknown> }).order,
          metadata: {
            sendcloud_variants: {
              var_cocoa: {
                hs_code: "180690",
                origin_country: "FR",
                weight: 90,
              },
            },
          },
        },
      } as unknown as Parameters<
        SendCloudFulfillmentProvider["createReturnFulfillment"]
      >[0];

      await buildProvider().createReturnFulfillment(enriched);

      const parcelItems = (
        capturedBody as { parcel_items: Array<Record<string, unknown>> }
      ).parcel_items;
      expect(parcelItems[0]).toMatchObject({
        hs_code: "180690",
        origin_country: "FR",
        weight: { value: "0.090", unit: "kg" },
      });
    });

    it("forwards brandId plugin option as brand_id", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      nock(BASE)
        .post(RETURNS_PATH, (body) => {
          capturedBody = body as Record<string, unknown>;
          return true;
        })
        .reply(201, returnResponse);

      await buildProvider({ brandId: 7 }).createReturnFulfillment(
        returnFulfillment
      );

      expect(capturedBody).toMatchObject({ brand_id: 7 });
    });

    it("throws INVALID_DATA when sendcloud_code is missing", async () => {
      const without = {
        ...returnFulfillment,
        data: {},
      } as unknown as Parameters<
        SendCloudFulfillmentProvider["createReturnFulfillment"]
      >[0];

      await expect(
        buildProvider().createReturnFulfillment(without)
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringMatching(/sendcloud_code/),
      });
    });

    it("throws INVALID_DATA when delivery_address is missing", async () => {
      const without = {
        ...returnFulfillment,
        delivery_address: undefined,
      } as unknown as Parameters<
        SendCloudFulfillmentProvider["createReturnFulfillment"]
      >[0];

      await expect(
        buildProvider().createReturnFulfillment(without)
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
      });
    });

    it("throws INVALID_DATA when location.address is missing", async () => {
      const without = {
        ...returnFulfillment,
        location: {},
      } as unknown as Parameters<
        SendCloudFulfillmentProvider["createReturnFulfillment"]
      >[0];

      await expect(
        buildProvider().createReturnFulfillment(without)
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
      });
    });

    it("throws UNEXPECTED_STATE when SendCloud response lacks return_id", async () => {
      nock(BASE)
        .post(RETURNS_PATH)
        .reply(201, { parcel_id: 123, multi_collo_ids: [] });

      await expect(
        buildProvider().createReturnFulfillment(returnFulfillment)
      ).rejects.toMatchObject({
        type: MedusaError.Types.UNEXPECTED_STATE,
      });
    });
  });

  describe("next cycle", () => {
    it.todo("customs validation warnings — §9.4");
  });
});
