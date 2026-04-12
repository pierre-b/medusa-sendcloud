import type { Logger } from "@medusajs/framework/types";

import SendCloudFulfillmentProvider from "../service";

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

  describe("abstract methods", () => {
    it("inherits base-class error for unimplemented getFulfillmentOptions", async () => {
      const provider = new SendCloudFulfillmentProvider(
        { logger: noopLogger },
        validOptions
      );

      await expect(provider.getFulfillmentOptions()).rejects.toThrow(
        /must be overridden/
      );
    });

    it.todo("returns SendCloud shipping methods from getFulfillmentOptions");
  });
});
