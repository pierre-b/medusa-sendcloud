import {
  AbstractFulfillmentProviderService,
  MedusaError,
} from "@medusajs/framework/utils";
import type {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateFulfillmentResult,
  CreateShippingOptionDTO,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  Logger,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types";

import { SendCloudClient } from "../../services/sendcloud-client";
import type { SendCloudPluginOptions } from "../../types/plugin-options";
import type {
  SendCloudShipmentCancelResponse,
  SendCloudShipmentRequest,
  SendCloudShipmentResponse,
  SendCloudShippingOption,
  SendCloudShippingOptionsFilter,
  SendCloudShippingOptionsResponse,
} from "../../types/sendcloud-api";
import {
  aggregateParcel,
  buildShipmentParcel,
  buildToAddress,
  isValidServicePointId,
  readSendCloudCode,
  requireString,
} from "./helpers";

type InjectedDependencies = {
  logger: Logger;
};

const SHIPPING_OPTIONS_PATH = "/api/v3/shipping-options";
const SHIPMENTS_WITH_RULES_PATH =
  "/api/v3/shipments/announce-with-shipping-rules";
const DEFAULT_EXPORT_REASON = "commercial_goods" as const;

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

  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    const code = readSendCloudCode(optionData);
    const toCountry = requireString(
      context.shipping_address?.country_code,
      "context.shipping_address.country_code"
    );
    const toPostal = context.shipping_address?.postal_code ?? null;

    const fromCandidate =
      context.from_location?.address?.country_code ??
      this.options_.defaultFromCountryCode;
    if (
      typeof fromCandidate !== "string" ||
      fromCandidate.trim().length === 0
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "medusa-sendcloud: cannot derive from_country_code — pass context.from_location or configure plugin option `defaultFromCountryCode`"
      );
    }

    const parcel = aggregateParcel(
      context.items,
      this.options_.weightUnit ?? "g"
    );

    const filter: SendCloudShippingOptionsFilter = {
      shipping_option_code: code,
      from_country_code: fromCandidate,
      to_country_code: toCountry,
      to_postal_code: toPostal,
      parcels: [parcel],
      calculate_quotes: true,
    };

    const response =
      await this.client_.request<SendCloudShippingOptionsResponse>({
        method: "POST",
        path: SHIPPING_OPTIONS_PATH,
        body: filter,
      });

    const firstQuote = response.data?.[0]?.quotes?.[0];
    if (!firstQuote) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `medusa-sendcloud: SendCloud returned no quote for shipping option ${code}`
      );
    }

    const totalValue = Number(firstQuote.price.total.value);
    if (!Number.isFinite(totalValue)) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `medusa-sendcloud: SendCloud returned a malformed quote value for ${code}: ${firstQuote.price.total.value}`
      );
    }

    return {
      calculated_amount: totalValue,
      is_calculated_price_tax_inclusive: false,
    };
  }

  async createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
  ): Promise<CreateFulfillmentResult> {
    const code = readSendCloudCode(data);
    const rawAddress = fulfillment?.delivery_address ?? order?.shipping_address;
    const toAddress = buildToAddress(rawAddress);

    const parcel = buildShipmentParcel(
      items as FulfillmentItemDTO[] | undefined,
      order,
      { insuranceAmount: this.options_.defaultInsuranceAmount }
    );

    const orderReference =
      order?.display_id !== undefined && order?.display_id !== null
        ? String(order.display_id)
        : (order?.id ?? undefined);
    const exportReason =
      this.options_.defaultExportReason ?? DEFAULT_EXPORT_REASON;

    const payload: SendCloudShipmentRequest = {
      to_address: toAddress,
      ship_with: {
        type: "shipping_option_code",
        properties: { shipping_option_code: code },
      },
      apply_shipping_defaults: true,
      apply_shipping_rules: true,
      parcels: [parcel],
      customs_information: {
        export_reason: exportReason,
        ...(orderReference ? { invoice_number: orderReference } : {}),
      },
    };

    if (orderReference) payload.order_number = orderReference;
    if (fulfillment?.id) payload.external_reference_id = fulfillment.id;

    const servicePointId = data.sendcloud_service_point_id;
    if (isValidServicePointId(servicePointId)) {
      payload.to_service_point = { id: String(servicePointId) };
    }

    const response = await this.client_.request<SendCloudShipmentResponse>({
      method: "POST",
      path: SHIPMENTS_WITH_RULES_PATH,
      body: payload,
    });

    const shipment = response.data;
    const firstParcel = shipment?.parcels?.[0];
    if (!shipment?.id || !firstParcel) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "medusa-sendcloud: SendCloud returned no parcel for the shipment"
      );
    }

    const labelLink =
      firstParcel.documents?.find((doc) => doc.type === "label")?.link ?? null;

    return {
      data: {
        sendcloud_shipment_id: shipment.id,
        sendcloud_parcel_id: firstParcel.id,
        tracking_number: firstParcel.tracking_number,
        tracking_url: firstParcel.tracking_url,
        status: firstParcel.status,
        label_url: labelLink,
        announced_at: firstParcel.announced_at ?? null,
        applied_shipping_rules: shipment.applied_shipping_rules ?? [],
      },
      labels: [
        {
          tracking_number: firstParcel.tracking_number,
          tracking_url: firstParcel.tracking_url,
          label_url: labelLink ?? "",
        },
      ],
    };
  }

  async cancelFulfillment(data: Record<string, unknown>): Promise<any> {
    const shipmentId = requireString(
      data.sendcloud_shipment_id,
      "data.sendcloud_shipment_id"
    );

    const response =
      await this.client_.request<SendCloudShipmentCancelResponse>({
        method: "POST",
        path: `/api/v3/shipments/${encodeURIComponent(shipmentId)}/cancel`,
      });

    return {
      sendcloud_cancellation: {
        status: response.data.status,
        message: response.data.message,
      },
    };
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
