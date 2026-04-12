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
});
