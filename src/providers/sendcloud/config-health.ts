import type { SendCloudPluginOptions } from "../../types/plugin-options";

export type ConfigWarning = {
  code: "missing_from_country" | "missing_webhook_secret";
  message: string;
};

const isTwoLetterIso = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z]{2}$/.test(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const getConfigWarnings = (
  options: SendCloudPluginOptions
): ConfigWarning[] => {
  const warnings: ConfigWarning[] = [];

  if (!isTwoLetterIso(options.defaultFromCountryCode)) {
    warnings.push({
      code: "missing_from_country",
      message:
        "International customs validation is disabled until `defaultFromCountryCode` is set to a 2-letter ISO code in medusa-config.ts.",
    });
  }

  if (!isNonEmptyString(options.webhookSecret)) {
    warnings.push({
      code: "missing_webhook_secret",
      message:
        "SendCloud webhooks will be rejected with 401 until `webhookSecret` is configured in medusa-config.ts.",
    });
  }

  return warnings;
};
