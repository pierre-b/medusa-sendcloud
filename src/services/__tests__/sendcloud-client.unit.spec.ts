import {
  DEFAULT_SENDCLOUD_BASE_URL,
  SendCloudClient,
} from "../sendcloud-client";

describe("SendCloudClient", () => {
  describe("constructor", () => {
    it("throws when publicKey is missing", () => {
      expect(
        () =>
          new SendCloudClient({
            publicKey: "",
            privateKey: "priv",
          })
      ).toThrow(/publicKey/);
    });

    it("throws when privateKey is missing", () => {
      expect(
        () =>
          new SendCloudClient({
            publicKey: "pub",
            privateKey: "",
          })
      ).toThrow(/privateKey/);
    });
  });

  describe("getAuthHeader", () => {
    it("builds a Basic Auth header from publicKey:privateKey", () => {
      const client = new SendCloudClient({
        publicKey: "pub",
        privateKey: "priv",
      });
      const expected = `Basic ${Buffer.from("pub:priv", "utf8").toString("base64")}`;

      expect(client.getAuthHeader()).toBe(expected);
    });
  });

  describe("getBaseUrl", () => {
    it("defaults to https://panel.sendcloud.sc", () => {
      const client = new SendCloudClient({
        publicKey: "pub",
        privateKey: "priv",
      });

      expect(client.getBaseUrl()).toBe(DEFAULT_SENDCLOUD_BASE_URL);
      expect(client.getBaseUrl()).toBe("https://panel.sendcloud.sc");
    });

    it("honors an explicit baseUrl", () => {
      const client = new SendCloudClient({
        publicKey: "pub",
        privateKey: "priv",
        baseUrl: "https://panel.example.test",
      });

      expect(client.getBaseUrl()).toBe("https://panel.example.test");
    });
  });

  describe("request", () => {
    it("is not implemented yet", async () => {
      const client = new SendCloudClient({
        publicKey: "pub",
        privateKey: "priv",
      });

      await expect(
        client.request({ method: "GET", path: "/api/v3/shipping-options" })
      ).rejects.toThrow(/not implemented/);
    });
  });
});
