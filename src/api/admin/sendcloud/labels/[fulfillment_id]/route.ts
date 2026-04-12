import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { fetchSendcloudLabel } from "../../../../../providers/sendcloud/fulfillment-label";
import { parseLabelQuery } from "../../../../../providers/sendcloud/helpers";
import { buildProviderRegistrationKey } from "../../../../../providers/sendcloud/registration";
import SendCloudFulfillmentProvider from "../../../../../providers/sendcloud/service";

const PROVIDER_KEY = buildProviderRegistrationKey(
  SendCloudFulfillmentProvider.identifier
);

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const fulfillmentId = (req.params as { fulfillment_id?: string })
    .fulfillment_id;
  if (!fulfillmentId) {
    res
      .status(400)
      .json({ message: "medusa-sendcloud: fulfillment_id is required" });
    return;
  }

  const parsed = parseLabelQuery(
    req.query as Record<string, unknown> | undefined | null
  );
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.error });
    return;
  }

  const result = await fetchSendcloudLabel(req.scope, PROVIDER_KEY, {
    ...parsed.value,
    fulfillmentId,
  });
  if (result.status !== 200) {
    res.status(result.status).json(result.body);
    return;
  }

  const isoDate = new Date().toISOString().slice(0, 10);
  const filename = `sendcloud-label-${isoDate}-${result.parcelId}.pdf`;
  res
    .status(200)
    .set("content-type", result.contentType)
    .set("content-disposition", `attachment; filename="${filename}"`)
    .end(result.body);
};
