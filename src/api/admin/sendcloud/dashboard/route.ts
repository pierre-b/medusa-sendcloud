import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { fetchDashboardSnapshot } from "../../../../providers/sendcloud/dashboard";
import { buildProviderRegistrationKey } from "../../../../providers/sendcloud/registration";
import SendCloudFulfillmentProvider from "../../../../providers/sendcloud/service";

const PROVIDER_KEY = buildProviderRegistrationKey(
  SendCloudFulfillmentProvider.identifier
);

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const snapshot = await fetchDashboardSnapshot(req.scope, PROVIDER_KEY);
  res.status(200).json(snapshot);
};
