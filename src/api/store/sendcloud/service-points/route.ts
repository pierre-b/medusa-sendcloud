import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import SendCloudFulfillmentProvider from "../../../../providers/sendcloud/service";
import { parseServicePointsQuery } from "../../../../providers/sendcloud/helpers";
import {
  buildProviderRegistrationKey,
  fetchSendcloudServicePoints,
} from "../../../../providers/sendcloud/service-points";

const PROVIDER_KEY = buildProviderRegistrationKey(
  SendCloudFulfillmentProvider.identifier
);

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = parseServicePointsQuery(
    req.query as Record<string, unknown> | undefined | null
  );
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.error });
    return;
  }

  const result = await fetchSendcloudServicePoints(
    req.scope,
    PROVIDER_KEY,
    parsed.value
  );
  res.status(result.status).json(result.body);
};
