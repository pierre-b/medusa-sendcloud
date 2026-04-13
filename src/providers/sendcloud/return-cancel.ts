import { MedusaError } from "@medusajs/framework/utils";

import type { SendCloudClient } from "../../services/sendcloud-client";
import type {
  SendCloudReturnCancelResponse,
  SendCloudReturnDetailsResponse,
} from "../../types/sendcloud-api";

export type ReturnCancellationResult = {
  sendcloud_return_cancellation: {
    return_id: number;
    message: string;
    parent_status: string | null;
    requested_at: string;
  };
};

const isMedusaError = (error: unknown): error is MedusaError =>
  error instanceof MedusaError;

const extractUpstreamMessage = (error: MedusaError): string | null => {
  // The client embeds the raw upstream body after a "SendCloud (status): "
  // prefix. Parse the JSON suffix and read errors[0].message so we surface
  // SendCloud's verbatim 409 reason (carrier-specific rejections vary).
  const jsonStart = error.message.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(error.message.slice(jsonStart)) as {
      errors?: Array<{ message?: unknown; detail?: unknown; title?: unknown }>;
    };
    const first = parsed.errors?.[0];
    const candidate = first?.message ?? first?.detail ?? first?.title;
    return typeof candidate === "string" ? candidate : null;
  } catch {
    return null;
  }
};

export const cancelReturn = async (
  client: SendCloudClient,
  returnId: number
): Promise<ReturnCancellationResult> => {
  if (
    typeof returnId !== "number" ||
    !Number.isInteger(returnId) ||
    returnId <= 0
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-sendcloud: return id must be a positive integer (received ${String(returnId)})`
    );
  }

  let cancelResponse: SendCloudReturnCancelResponse;
  try {
    cancelResponse = await client.request<SendCloudReturnCancelResponse>({
      method: "PATCH",
      path: `/api/v3/returns/${returnId}/cancel`,
    });
  } catch (error) {
    if (isMedusaError(error) && error.type === MedusaError.Types.NOT_FOUND) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `medusa-sendcloud: return ${returnId} was not found`
      );
    }
    if (isMedusaError(error) && error.type === MedusaError.Types.CONFLICT) {
      const upstream =
        extractUpstreamMessage(error) ?? "Return is not cancellable";
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `medusa-sendcloud: SendCloud rejected return cancellation: ${upstream}`
      );
    }
    throw error;
  }

  let parentStatus: string | null;
  try {
    const details = await client.request<SendCloudReturnDetailsResponse>({
      method: "GET",
      path: `/api/v3/returns/${returnId}`,
    });
    parentStatus = details.data?.parent_status ?? null;
  } catch {
    // Best-effort follow-up: if the GET fails (5xx after retries, transient
    // network error), the PATCH 202 still stands. Admin can re-fetch the
    // fulfillment after the next webhook to see the updated parent_status.
    parentStatus = null;
  }

  return {
    sendcloud_return_cancellation: {
      return_id: returnId,
      message: cancelResponse.message,
      parent_status: parentStatus,
      requested_at: new Date().toISOString(),
    },
  };
};
