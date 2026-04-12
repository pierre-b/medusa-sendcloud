import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import SendCloudFulfillmentProvider from "../../../providers/sendcloud/service";
import { processSendcloudWebhook } from "../../../providers/sendcloud/webhook-handler";
import type { SendCloudPluginOptions } from "../../../types/plugin-options";

const PROVIDER_REGISTRATION_KEY = `fp_${SendCloudFulfillmentProvider.identifier}_${SendCloudFulfillmentProvider.identifier}`;

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  let options: SendCloudPluginOptions;
  try {
    const provider = req.scope.resolve<SendCloudFulfillmentProvider>(
      PROVIDER_REGISTRATION_KEY
    );
    options = (
      provider as SendCloudFulfillmentProvider & {
        options_: SendCloudPluginOptions;
      }
    ).options_;
  } catch {
    res.status(500).json({
      message:
        "medusa-sendcloud: fulfillment provider not registered; webhook cannot resolve plugin options",
    });
    return;
  }

  const signatureHeader = req.headers["sendcloud-signature"];
  const signature = Array.isArray(signatureHeader)
    ? signatureHeader[0]
    : signatureHeader;

  const result = await processSendcloudWebhook(req.scope, options, {
    signature,
    rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
    payload: req.body,
  });

  res.status(result.status).json({ message: result.message });
};
