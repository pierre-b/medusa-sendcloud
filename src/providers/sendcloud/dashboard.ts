import { MedusaError } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";

import type { SendCloudClient } from "../../services/sendcloud-client";
import type {
  SendCloudShippingOption,
  SendCloudShippingOptionsFilter,
  SendCloudShippingOptionsResponse,
} from "../../types/sendcloud-api";

export const SHIPPING_OPTIONS_PATH = "/api/v3/shipping-options";

export type DashboardSnapshot = {
  connected: boolean;
  error?: string;
  shipping_options: SendCloudShippingOption[];
};

type DashboardProvider = {
  client_: SendCloudClient;
};

const isCredentialsError = (error: MedusaError): boolean =>
  error.type === MedusaError.Types.UNAUTHORIZED ||
  error.type === MedusaError.Types.FORBIDDEN;

export const fetchDashboardSnapshot = async (
  container: MedusaContainer,
  providerRegistrationKey: string
): Promise<DashboardSnapshot> => {
  let provider: DashboardProvider;
  try {
    provider = container.resolve<DashboardProvider>(providerRegistrationKey);
  } catch {
    return {
      connected: false,
      error:
        "medusa-sendcloud: fulfillment provider not registered in the Medusa container",
      shipping_options: [],
    };
  }

  try {
    const filter: SendCloudShippingOptionsFilter = {};
    const response =
      await provider.client_.request<SendCloudShippingOptionsResponse>({
        method: "POST",
        path: SHIPPING_OPTIONS_PATH,
        body: filter,
      });
    return {
      connected: true,
      shipping_options: response.data ?? [],
    };
  } catch (error) {
    if (error instanceof MedusaError && isCredentialsError(error)) {
      return {
        connected: false,
        error: `medusa-sendcloud: SendCloud rejected the API credentials (${error.message})`,
        shipping_options: [],
      };
    }
    const message =
      error instanceof Error
        ? error.message
        : "medusa-sendcloud: dashboard upstream failed";
    return {
      connected: false,
      error: message,
      shipping_options: [],
    };
  }
};
