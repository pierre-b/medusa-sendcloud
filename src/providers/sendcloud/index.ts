import { ModuleProvider, Modules } from "@medusajs/framework/utils";

import SendCloudFulfillmentProvider from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [SendCloudFulfillmentProvider],
});
