import { MedusaError } from "@medusajs/framework/utils";

import type { SendCloudClient } from "../../services/sendcloud-client";
import type {
  SendCloudShippingOptionsFilter,
  SendCloudShippingOptionsResponse,
} from "../../types/sendcloud-api";

export const MULTICOLLO_SHIPPING_OPTIONS_PATH = "/api/v3/shipping-options";

export const assertCarrierSupportsMulticollo = async (
  client: SendCloudClient,
  shippingOptionCode: string
): Promise<void> => {
  const filter: SendCloudShippingOptionsFilter = {
    functionalities: { multicollo: true },
  };
  const response = await client.request<SendCloudShippingOptionsResponse>({
    method: "POST",
    path: MULTICOLLO_SHIPPING_OPTIONS_PATH,
    body: filter,
  });

  const supported = (response.data ?? []).some(
    (option) => option.code === shippingOptionCode
  );
  if (!supported) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `medusa-sendcloud: carrier shipping option "${shippingOptionCode}" does not support multi-collo shipments`
    );
  }
};
