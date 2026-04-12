export type SendCloudLabelFormat = "pdf" | "zpl";
export type SendCloudLabelSize = "a4" | "a6";
export type SendCloudEnvironment = "live" | "test";

export type SendCloudPluginOptions = {
  publicKey: string;
  privateKey: string;
  defaultSenderAddressId?: number;
  webhookSecret?: string;
  labelFormat?: SendCloudLabelFormat;
  labelSize?: SendCloudLabelSize;
  defaultInsuranceAmount?: number;
  enableReturns?: boolean;
  enableServicePoints?: boolean;
  syncTrackingToOrder?: boolean;
  brandId?: number;
  environment?: SendCloudEnvironment;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  defaultFromCountryCode?: string;
  weightUnit?: SendCloudWeightUnitOption;
  defaultExportReason?: SendCloudExportReasonOption;
  webhookLookbackDays?: number;
};

export type SendCloudWeightUnitOption = "g" | "kg" | "lbs" | "oz";

export type SendCloudExportReasonOption =
  | "gift"
  | "documents"
  | "commercial_goods"
  | "commercial_sample";
