import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import {
  buildVariantsMap,
  extractVariantIds,
} from "../providers/sendcloud/helpers";
import { enrichSendcloudVariantsWorkflow } from "../workflows/enrich-sendcloud-variants";

type OrderSnapshot = {
  id: string;
  items?: Array<{ variant_id?: string | null }>;
};

type VariantSnapshot = {
  id: string;
  hs_code?: string | null;
  origin_country?: string | null;
  weight?: number | null;
};

export const resolveSendcloudVariants = async (
  container: MedusaContainer,
  orderId: string
): Promise<void> => {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: orders } = await query.graph({
    entity: "order",
    filters: { id: orderId },
    fields: ["id", "items.variant_id"],
  });
  const order = (orders as OrderSnapshot[])[0];
  if (!order) return;

  const variantIds = extractVariantIds(order.items);
  if (variantIds.length === 0) return;

  const { data: variants } = await query.graph({
    entity: "product_variant",
    filters: { id: variantIds },
    fields: ["id", "hs_code", "origin_country", "weight"],
  });

  const variantsMap = buildVariantsMap(variants as VariantSnapshot[]);
  if (Object.keys(variantsMap).length === 0) {
    logger.debug(
      `medusa-sendcloud: order.placed for ${orderId} resolved no customs-relevant variant fields; skipping metadata update`
    );
    return;
  }

  await enrichSendcloudVariantsWorkflow(container).run({
    input: { orderId, variants: variantsMap },
  });
};

export default async function handleOrderPlaced({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  await resolveSendcloudVariants(container, data.id);
}

export const config: SubscriberConfig = {
  event: "order.placed",
};
