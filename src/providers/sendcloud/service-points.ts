import { MedusaError } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";

import type { SendCloudClient } from "../../services/sendcloud-client";
import type {
  SendCloudServicePoint,
  SendCloudServicePointsQuery,
} from "../../types/sendcloud-api";

export const SERVICE_POINTS_BASE_URL = "https://servicepoints.sendcloud.sc";
export const SERVICE_POINTS_PATH = "/api/v2/service-points";

export type ServicePointsResult = {
  status: 200 | 502;
  body: { service_points: SendCloudServicePoint[] } | { message: string };
};

export type ServicePointsClientProvider = {
  client_: SendCloudClient;
};

export const fetchSendcloudServicePoints = async (
  container: MedusaContainer,
  providerRegistrationKey: string,
  query: SendCloudServicePointsQuery
): Promise<ServicePointsResult> => {
  let provider: ServicePointsClientProvider;
  try {
    provider = container.resolve<ServicePointsClientProvider>(
      providerRegistrationKey
    );
  } catch {
    return {
      status: 502,
      body: {
        message:
          "medusa-sendcloud: fulfillment provider not registered; cannot fetch service points",
      },
    };
  }

  try {
    const points = await provider.client_.request<SendCloudServicePoint[]>({
      method: "GET",
      path: SERVICE_POINTS_PATH,
      baseUrl: SERVICE_POINTS_BASE_URL,
      query: {
        country: query.country,
        postal_code: query.postal_code,
        city: query.city,
        house_number: query.house_number,
        radius: query.radius,
        carrier: query.carrier,
        latitude: query.latitude,
        longitude: query.longitude,
      },
    });
    return { status: 200, body: { service_points: points ?? [] } };
  } catch (error) {
    const message =
      error instanceof MedusaError
        ? error.message
        : error instanceof Error
          ? error.message
          : "medusa-sendcloud: service-points upstream failed";
    return { status: 502, body: { message } };
  }
};

// Exported for the route file and tests — matches the key published by
// the module provider registration (see cycle 07 webhook route for the
// same pattern).
export const buildProviderRegistrationKey = (identifier: string): string =>
  `fp_${identifier}_${identifier}`;
