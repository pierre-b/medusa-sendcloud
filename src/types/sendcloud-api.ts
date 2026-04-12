export type SendCloudDimensionUnit = "cm" | "mm" | "m" | "yd" | "ft" | "in";
export type SendCloudWeightUnit = "kg" | "g" | "lbs" | "oz";
export type SendCloudCurrency = "EUR" | "GBP" | "USD";

export type SendCloudDimension = {
  length: string;
  width: string;
  height: string;
  unit: SendCloudDimensionUnit;
};

export type SendCloudWeight = {
  value: string;
  unit: SendCloudWeightUnit;
};

export type SendCloudPrice = {
  value: string;
  /**
   * ISO 4217 currency code. The OpenAPI snapshot enumerates EUR/GBP/USD
   * as examples, but SendCloud accepts any standard ISO code for
   * `parcel_items[].price` and quote values. Kept as `string` so
   * Medusa stores with other currencies can pass their code through
   * without casts.
   */
  currency: string;
};

export type SendCloudCarrier = {
  code: string;
  name: string;
};

export type SendCloudShippingProduct = {
  code: string;
  name: string;
};

export type SendCloudContract = {
  id: number;
  client_id: string;
  carrier_code: string;
  name: string;
};

export type SendCloudRequirementField =
  | "to_email"
  | "to_telephone"
  | "length"
  | "width"
  | "height";

export type SendCloudRequirements = {
  fields: SendCloudRequirementField[];
  export_documents: boolean;
  is_service_point_required: boolean;
};

export type SendCloudChargingType = "first_scan" | "label_creation";

export type SendCloudShippingQuotePriceBreakdownEntry = {
  type: string;
  label: string;
  price: SendCloudPrice;
};

export type SendCloudShippingQuote = {
  weight?: {
    min?: SendCloudWeight;
    max?: SendCloudWeight;
  };
  price: {
    breakdown: SendCloudShippingQuotePriceBreakdownEntry[];
    total: SendCloudPrice;
  };
  lead_time?: number | null;
};

export type SendCloudShippingOption = {
  code: string;
  name: string;
  carrier: SendCloudCarrier;
  product: SendCloudShippingProduct;
  functionalities: Record<string, unknown>;
  max_dimensions?: SendCloudDimension;
  weight?: {
    min?: SendCloudWeight;
    max?: SendCloudWeight;
  };
  parcel_billed_weights?: unknown[];
  contract?: SendCloudContract;
  requirements: SendCloudRequirements;
  charging_type: SendCloudChargingType;
  quotes?: SendCloudShippingQuote[] | null;
};

export type SendCloudShippingOptionsFilter = {
  from_country_code?: string | null;
  to_country_code?: string | null;
  from_postal_code?: string | null;
  to_postal_code?: string | null;
  parcels?: Array<{
    dimensions?: SendCloudDimension;
    weight?: SendCloudWeight;
    additional_insured_price?: number | null;
    total_insured_price?: number | null;
  }> | null;
  functionalities?: Record<string, unknown> | null;
  carrier_code?: string | null;
  contract_id?: number | null;
  shipping_product_code?: string | null;
  shipping_option_code?: string | null;
  calculate_quotes?: boolean | null;
};

export type SendCloudShippingOptionsResponse = {
  data: SendCloudShippingOption[] | null;
  message: string | null;
};

export type SendCloudErrorCode =
  | "unknown_field"
  | "invalid"
  | "forbidden"
  | "invalid_choice"
  | "min_value"
  | "null"
  | "not_found"
  | "required"
  | "not_a_list"
  | "non_field_errors"
  | "authentication_failed"
  | "validation_error"
  | "parcel_announcement_error";

export type SendCloudErrorObject = {
  id?: string;
  status?: string;
  code?: SendCloudErrorCode;
  title?: string;
  detail?: string;
  source?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type SendCloudErrorResponse = {
  errors: SendCloudErrorObject[];
};

export type SendCloudAddress = {
  name: string;
  company_name?: string;
  address_line_1: string;
  house_number?: string;
  address_line_2?: string;
  postal_code: string;
  city: string;
  po_box?: string | null;
  state_province_code?: string;
  country_code: string;
  email?: string;
  phone_number?: string;
};

export type SendCloudShipWith = {
  type: "shipping_option_code" | "shipping_product_code";
  properties: {
    shipping_option_code?: string;
    shipping_product_code?: string;
    contract_id?: number | null;
  };
};

export type SendCloudExportReason =
  | "gift"
  | "documents"
  | "commercial_goods"
  | "commercial_sample"
  | "returned_goods";

export type SendCloudCustomsInformation = {
  invoice_number?: string;
  export_reason?: SendCloudExportReason;
};

export type SendCloudParcelItemRequest = {
  description: string;
  quantity: number;
  weight?: SendCloudWeight;
  price?: SendCloudPrice;
  hs_code?: string;
  origin_country?: string;
  sku?: string;
  item_id?: string;
  product_id?: string;
};

export type SendCloudParcelRequest = {
  weight?: SendCloudWeight;
  dimensions?: SendCloudDimension;
  parcel_items?: SendCloudParcelItemRequest[];
  additional_insured_price?: SendCloudPrice | null;
};

export type SendCloudServicePointRef = {
  id?: string;
  carrier_service_point_id?: string;
};

export type SendCloudShipmentRequest = {
  label_details?: { mime_type?: string; dpi?: number };
  to_address: SendCloudAddress;
  from_address?: SendCloudAddress;
  ship_with?: SendCloudShipWith;
  apply_shipping_defaults?: boolean;
  apply_shipping_rules?: boolean;
  order_number?: string;
  external_reference_id?: string;
  total_order_price?: SendCloudPrice;
  parcels?: SendCloudParcelRequest[];
  to_service_point?: SendCloudServicePointRef;
  customs_information?: SendCloudCustomsInformation;
  brand_id?: number;
};

export type SendCloudParcelDocument = {
  type: string;
  size?: string;
  link: string;
};

export type SendCloudParcelStatus = {
  code: string;
  message: string;
};

export type SendCloudParcelResponse = {
  id: number;
  status: SendCloudParcelStatus;
  documents: SendCloudParcelDocument[];
  tracking_number: string;
  tracking_url: string;
  announced_at?: string;
  weight?: SendCloudWeight;
  dimensions?: SendCloudDimension;
};

export type SendCloudShipmentResponse = {
  data: {
    id: string;
    parcels: SendCloudParcelResponse[];
    label_details?: { mime_type?: string; dpi?: number };
    applied_shipping_rules?: unknown[];
  };
};

export type SendCloudShipmentCancelResponse = {
  data: {
    status: "cancelled" | "queued";
    message: string;
  };
};
