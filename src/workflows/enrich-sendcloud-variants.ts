import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/framework/utils";

import type { SendCloudVariantsMap } from "../types/sendcloud-api";

export type EnrichSendcloudVariantsInput = {
  orderId: string;
  variants: SendCloudVariantsMap;
};

const updateOrderMetadataStep = createStep(
  "sendcloud-update-order-metadata",
  async (input: EnrichSendcloudVariantsInput, { container }) => {
    const orderService = container.resolve(Modules.ORDER);
    const [existing] = await orderService.listOrders({ id: [input.orderId] });
    const currentMetadata = (existing?.metadata ?? {}) as Record<
      string,
      unknown
    >;

    // Wholesale overwrite of `sendcloud_variants` is intentional: the
    // upstream subscriber always rebuilds the full variant set from
    // order.items, so merging per-key would only risk leaking stale
    // entries when variants are removed or customs-cleared. Other
    // metadata keys are preserved via the spread above.
    await orderService.updateOrders([
      {
        id: input.orderId,
        metadata: {
          ...currentMetadata,
          sendcloud_variants: input.variants,
        },
      },
    ]);

    return new StepResponse(undefined);
  }
);

export const enrichSendcloudVariantsWorkflow = createWorkflow(
  "sendcloud-enrich-variants",
  function (input: EnrichSendcloudVariantsInput) {
    updateOrderMetadataStep(input);
    return new WorkflowResponse(undefined);
  }
);
