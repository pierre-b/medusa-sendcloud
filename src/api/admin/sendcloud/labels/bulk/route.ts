import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { fetchSendcloudBulkLabels } from "../../../../../providers/sendcloud/bulk-labels";
import { parseBulkLabelRequest } from "../../../../../providers/sendcloud/helpers";
import SendCloudFulfillmentProvider from "../../../../../providers/sendcloud/service";
import { buildProviderRegistrationKey } from "../../../../../providers/sendcloud/service-points";

const PROVIDER_KEY = buildProviderRegistrationKey(
  SendCloudFulfillmentProvider.identifier
);

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = parseBulkLabelRequest(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.error });
    return;
  }

  const result = await fetchSendcloudBulkLabels(
    req.scope,
    PROVIDER_KEY,
    parsed.value
  );
  if (result.status !== 200) {
    res.status(result.status).json(result.body);
    return;
  }

  const filename = `sendcloud-labels-${Date.now()}.pdf`;
  res
    .status(200)
    .set("content-type", result.contentType)
    .set("content-disposition", `attachment; filename="${filename}"`)
    .end(result.body);
};
