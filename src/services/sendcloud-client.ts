import { MedusaError } from "@medusajs/framework/utils";
import type { Logger } from "@medusajs/framework/types";

export const DEFAULT_SENDCLOUD_BASE_URL = "https://panel.sendcloud.sc";

export type SendCloudClientOptions = {
  publicKey: string;
  privateKey: string;
  baseUrl?: string;
  logger?: Logger;
};

export type SendCloudRequestInit = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

export class SendCloudClient {
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private readonly logger?: Logger;

  constructor(options: SendCloudClientOptions) {
    if (!options.publicKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SendCloudClient requires a non-empty publicKey"
      );
    }
    if (!options.privateKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SendCloudClient requires a non-empty privateKey"
      );
    }

    this.publicKey = options.publicKey;
    this.privateKey = options.privateKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_SENDCLOUD_BASE_URL;
    this.logger = options.logger;
  }

  getAuthHeader(): string {
    const credentials = `${this.publicKey}:${this.privateKey}`;
    const encoded = Buffer.from(credentials, "utf8").toString("base64");
    return `Basic ${encoded}`;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async request<T = unknown>(_init: SendCloudRequestInit): Promise<T> {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "SendCloudClient.request is not implemented yet"
    );
  }
}

export default SendCloudClient;
