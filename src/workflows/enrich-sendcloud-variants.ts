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
