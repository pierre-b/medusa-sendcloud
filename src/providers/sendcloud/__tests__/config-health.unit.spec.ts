import { getConfigWarnings } from "../config-health";

describe("getConfigWarnings", () => {
  it("returns an empty array when defaultFromCountryCode and webhookSecret are configured", () => {
    expect(
      getConfigWarnings({
        publicKey: "pub",
        privateKey: "priv",
        defaultFromCountryCode: "FR",
        webhookSecret: "shh",
      })
    ).toEqual([]);
  });

  it("emits missing_from_country when defaultFromCountryCode is missing or invalid", () => {
    const codesFor = (opts: Parameters<typeof getConfigWarnings>[0]) =>
      getConfigWarnings(opts).map((w) => w.code);

    expect(
      codesFor({ publicKey: "pub", privateKey: "priv", webhookSecret: "shh" })
    ).toContain("missing_from_country");
    expect(
      codesFor({
        publicKey: "pub",
        privateKey: "priv",
        webhookSecret: "shh",
        defaultFromCountryCode: "",
      })
    ).toContain("missing_from_country");
    expect(
      codesFor({
        publicKey: "pub",
        privateKey: "priv",
        webhookSecret: "shh",
        defaultFromCountryCode: "FRA", // not 2-letter
      })
    ).toContain("missing_from_country");
  });

  it("emits missing_webhook_secret when webhookSecret is missing or empty", () => {
    const codesFor = (opts: Parameters<typeof getConfigWarnings>[0]) =>
      getConfigWarnings(opts).map((w) => w.code);

    expect(
      codesFor({
        publicKey: "pub",
        privateKey: "priv",
        defaultFromCountryCode: "FR",
      })
    ).toContain("missing_webhook_secret");
    expect(
      codesFor({
        publicKey: "pub",
        privateKey: "priv",
        defaultFromCountryCode: "FR",
        webhookSecret: "   ",
      })
    ).toContain("missing_webhook_secret");
  });
});
