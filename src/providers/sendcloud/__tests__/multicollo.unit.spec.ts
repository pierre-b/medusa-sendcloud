import nock from "nock";

import { MedusaError } from "@medusajs/framework/utils";

import {
  DEFAULT_SENDCLOUD_BASE_URL,
  SendCloudClient,
} from "../../../services/sendcloud-client";
import { parseParcelsHint } from "../helpers";
import {
  MULTICOLLO_SHIPPING_OPTIONS_PATH,
  assertCarrierSupportsMulticollo,
} from "../multicollo";

describe("parseParcelsHint", () => {
  it("returns null for undefined, null, non-array, or empty input", () => {
    expect(parseParcelsHint(undefined)).toBeNull();
    expect(parseParcelsHint(null)).toBeNull();
    expect(parseParcelsHint("not-an-array")).toBeNull();
    expect(parseParcelsHint({})).toBeNull();
    expect(parseParcelsHint([])).toBeNull();
  });

  it("returns a typed array for valid input", () => {
    const parsed = parseParcelsHint([
      { weight: 1500, length: 30, width: 20, height: 10 },
      { weight: 900, length: 20, width: 15, height: 8 },
    ]);
    expect(parsed).toEqual([
      { weight: 1500, length: 30, width: 20, height: 10 },
      { weight: 900, length: 20, width: 15, height: 8 },
    ]);
  });

  it("throws INVALID_DATA when more than 15 parcels are supplied", () => {
    const many = Array.from({ length: 16 }, () => ({
      weight: 100,
      length: 10,
      width: 10,
      height: 10,
    }));
    expect(() => parseParcelsHint(many)).toThrow(MedusaError);
    try {
      parseParcelsHint(many);
    } catch (error) {
      expect((error as MedusaError).type).toBe(MedusaError.Types.INVALID_DATA);
    }
  });

  it("throws INVALID_DATA for non-positive or non-numeric dimensions", () => {
    expect(() =>
      parseParcelsHint([{ weight: 0, length: 10, width: 10, height: 10 }])
    ).toThrow(/weight/);
    expect(() =>
      parseParcelsHint([{ weight: 100, length: -1, width: 10, height: 10 }])
    ).toThrow(/length/);
    expect(() =>
      parseParcelsHint([{ weight: 100, length: 10, width: "ten", height: 10 }])
    ).toThrow(/width/);
    expect(() =>
      parseParcelsHint([
        { weight: 100, length: 10, width: 10, height: undefined },
      ])
    ).toThrow(/height/);
  });
});

describe("assertCarrierSupportsMulticollo", () => {
  const client = new SendCloudClient({
    publicKey: "pub",
    privateKey: "priv",
    retryBaseDelayMs: 0,
  });

  it("resolves when the shipping-option code is in the multicollo-capable list", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .post(MULTICOLLO_SHIPPING_OPTIONS_PATH, {
        functionalities: { multicollo: true },
      })
      .reply(200, {
        data: [
          {
            code: "dhl:multicollo",
            name: "DHL Multicollo",
            carrier: { code: "dhl", name: "DHL" },
            functionalities: { multicollo: true },
            requirements: {
              fields: [],
              export_documents: false,
              is_service_point_required: false,
            },
            charging_type: "label_creation",
          },
        ],
      });

    await expect(
      assertCarrierSupportsMulticollo(client, "dhl:multicollo")
    ).resolves.toBeUndefined();
  });

  it("throws NOT_ALLOWED when the shipping-option code is absent", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .post(MULTICOLLO_SHIPPING_OPTIONS_PATH)
      .reply(200, {
        data: [
          {
            code: "dhl:multicollo",
            name: "DHL Multicollo",
            carrier: { code: "dhl", name: "DHL" },
            functionalities: { multicollo: true },
            requirements: {
              fields: [],
              export_documents: false,
              is_service_point_required: false,
            },
            charging_type: "label_creation",
          },
        ],
      });

    await expect(
      assertCarrierSupportsMulticollo(client, "postnl:standard")
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
    });
  });

  it("propagates upstream credential errors", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .post(MULTICOLLO_SHIPPING_OPTIONS_PATH)
      .reply(401, { errors: [{ code: "authentication_failed" }] });

    await expect(
      assertCarrierSupportsMulticollo(client, "whatever")
    ).rejects.toMatchObject({
      type: MedusaError.Types.UNAUTHORIZED,
    });
  });
});
