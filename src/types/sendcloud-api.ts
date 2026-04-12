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
  currency: SendCloudCurrency;
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
