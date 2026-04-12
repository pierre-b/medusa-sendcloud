import { MedusaError } from "@medusajs/framework/utils";
import type { Logger } from "@medusajs/framework/types";

import type {
  SendCloudErrorObject,
  SendCloudErrorResponse,
} from "../types/sendcloud-api";

export const DEFAULT_SENDCLOUD_BASE_URL = "https://panel.sendcloud.sc";
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 200;

export type SendCloudClientOptions = {
  publicKey: string;
  privateKey: string;
  baseUrl?: string;
  logger?: Logger;
  maxRetries?: number;
  retryBaseDelayMs?: number;
};

export type SendCloudRequestInit = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

const RETRYABLE_STATUS = new Set<number>([429]);

const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUS.has(status) || status >= 500;

const STATUS_TO_ERROR_TYPE: Record<number, string> = {
  400: MedusaError.Types.INVALID_DATA,
  401: MedusaError.Types.UNAUTHORIZED,
  403: MedusaError.Types.FORBIDDEN,
  404: MedusaError.Types.NOT_FOUND,
  409: MedusaError.Types.CONFLICT,
  422: MedusaError.Types.INVALID_DATA,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const computeBackoffMs = (
  retryAfterHeader: string | null,
  attempt: number,
  baseDelayMs: number
): number => {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  const exponential = baseDelayMs * Math.pow(3, attempt);
  const jitter = exponential * (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.round(exponential + jitter));
};

const extractFirstError = (body: unknown): SendCloudErrorObject | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const maybe = body as Partial<SendCloudErrorResponse>;
  if (Array.isArray(maybe.errors) && maybe.errors.length > 0) {
    return maybe.errors[0];
  }
  return undefined;
};

const buildErrorMessage = (
  status: number,
  body: unknown,
  rawText: string
): string => {
  const first = extractFirstError(body);
  const detail = first?.detail ?? first?.title;
  if (detail) return `SendCloud (${status}): ${detail}`;
  if (rawText) return `SendCloud (${status}): ${rawText.slice(0, 200)}`;
  return `SendCloud request failed with status ${status}`;
};

export class SendCloudClient {
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private readonly logger?: Logger;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

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
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private buildAuthHeader(): string {
    const encoded = Buffer.from(
      `${this.publicKey}:${this.privateKey}`,
      "utf8"
    ).toString("base64");
    return `Basic ${encoded}`;
  }

  private buildUrl(
    path: string,
    query?: SendCloudRequestInit["query"]
  ): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  async request<T = unknown>(init: SendCloudRequestInit): Promise<T> {
    const url = this.buildUrl(init.path, init.query);
    const headers: Record<string, string> = {
      authorization: this.buildAuthHeader(),
      accept: "application/json",
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      let rawText: string;
      try {
        response = await fetch(url, { method: init.method, headers, body });
        if (response.ok) {
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }
        rawText = await response.text();
      } catch (networkError) {
        lastError = networkError;
        this.logger?.debug(
          `SendCloud network error on attempt ${attempt + 1}/${
            this.maxRetries + 1
          }: ${(networkError as Error).message}`
        );
        if (attempt < this.maxRetries) {
          await sleep(computeBackoffMs(null, attempt, this.retryBaseDelayMs));
          continue;
        }
        break;
      }

      let parsedBody: unknown;
      try {
        parsedBody = rawText ? JSON.parse(rawText) : undefined;
      } catch {
        parsedBody = undefined;
      }

      if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
        const retryAfter = response.headers.get("retry-after");
        const delay = computeBackoffMs(
          retryAfter,
          attempt,
          this.retryBaseDelayMs
        );
        this.logger?.debug(
          `SendCloud ${response.status} on attempt ${attempt + 1}/${
            this.maxRetries + 1
          }; retrying after ${delay}ms`
        );
        await sleep(delay);
        continue;
      }

      const type =
        STATUS_TO_ERROR_TYPE[response.status] ??
        MedusaError.Types.UNEXPECTED_STATE;
      throw new MedusaError(
        type,
        buildErrorMessage(response.status, parsedBody, rawText)
      );
    }

    const message =
      lastError instanceof Error
        ? `SendCloud request failed after ${this.maxRetries + 1} attempts: ${lastError.message}`
        : `SendCloud request failed after ${this.maxRetries + 1} attempts`;
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, message);
  }
}

export default SendCloudClient;
