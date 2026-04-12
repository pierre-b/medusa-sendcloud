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
};
