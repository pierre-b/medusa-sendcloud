import {
  AbstractFulfillmentProviderService,
  MedusaError,
} from "@medusajs/framework/utils";
import type { FulfillmentOption, Logger } from "@medusajs/framework/types";

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

  protected readonly logger_: Logger;
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

    this.logger_ = logger;
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
}

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
