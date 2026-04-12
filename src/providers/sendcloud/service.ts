import {
  AbstractFulfillmentProviderService,
  MedusaError,
} from "@medusajs/framework/utils";
import type {
  CreateShippingOptionDTO,
  FulfillmentOption,
  Logger,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types";

import { SendCloudClient } from "../../services/sendcloud-client";
import type { SendCloudPluginOptions } from "../../types/plugin-options";
import type {
  SendCloudShippingOption,
  SendCloudShippingOptionsFilter,
  SendCloudShippingOptionsResponse,
} from "../../types/sendcloud-api";

type InjectedDependencies = {
  logger: Logger;
};

const SHIPPING_OPTIONS_PATH = "/api/v3/shipping-options";

export class SendCloudFulfillmentProvider extends AbstractFulfillmentProviderService {
  static identifier = "sendcloud";

  protected readonly options_: SendCloudPluginOptions;
  protected readonly client_: SendCloudClient;

  constructor(
    { logger }: InjectedDependencies,
    options: SendCloudPluginOptions
  ) {
    super();

    if (!options?.publicKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "medusa-sendcloud: `publicKey` plugin option is required"
      );
    }
    if (!options?.privateKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "medusa-sendcloud: `privateKey` plugin option is required"
      );
    }

    this.options_ = options;
    this.client_ = new SendCloudClient({
      publicKey: options.publicKey,
      privateKey: options.privateKey,
      baseUrl: options.baseUrl,
      maxRetries: options.maxRetries,
      retryBaseDelayMs: options.retryBaseDelayMs,
      logger,
    });
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    const filter: SendCloudShippingOptionsFilter = {};
    const response =
      await this.client_.request<SendCloudShippingOptionsResponse>({
        method: "POST",
        path: SHIPPING_OPTIONS_PATH,
        body: filter,
      });

    const options = response.data ?? [];
    return options.map(toFulfillmentOption);
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    const code = readSendCloudCode(data);
    const filter: SendCloudShippingOptionsFilter = {
      shipping_option_code: code,
    };
    const response =
      await this.client_.request<SendCloudShippingOptionsResponse>({
        method: "POST",
        path: SHIPPING_OPTIONS_PATH,
        body: filter,
      });

    return (response.data ?? []).some((option) => option.code === code);
  }

  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return true;
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext
  ): Promise<Record<string, unknown>> {
    const code = readSendCloudCode(optionData);
    const requiresServicePoint =
      optionData.sendcloud_requires_service_point === true;

    if (!requiresServicePoint) return data;

    const servicePointId = data.service_point_id;
    if (!isValidServicePointId(servicePointId)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `medusa-sendcloud: shipping option ${code} requires a service point — pass data.service_point_id at checkout`
      );
    }

    return {
      ...data,
      sendcloud_service_point_id: String(servicePointId),
    };
  }
}

const readSendCloudCode = (data: Record<string, unknown>): string => {
  const code = data.sendcloud_code;
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-sendcloud: option data is missing sendcloud_code"
    );
  }
  return code;
};

const isValidServicePointId = (value: unknown): value is string | number => {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }
  return false;
};

const toFulfillmentOption = (
  option: SendCloudShippingOption
): FulfillmentOption => ({
  id: `sendcloud_${option.code}`,
  name: option.name,
  sendcloud_code: option.code,
  sendcloud_carrier_code: option.carrier.code,
  sendcloud_carrier_name: option.carrier.name,
  sendcloud_product_code: option.product.code,
  sendcloud_requires_service_point:
    option.requirements.is_service_point_required,
  sendcloud_functionalities: option.functionalities,
});

export default SendCloudFulfillmentProvider;
