import { MedusaError } from "@medusajs/framework/utils";

import type { SendCloudClient } from "../../services/sendcloud-client";
import type {
  SendCloudReturnCancelResponse,
  SendCloudReturnDetailsResponse,
} from "../../types/sendcloud-api";

export type ReturnCancellationResult = {
  sendcloud_return_cancellation: {
    message: string;
    parent_status: string | null;
    requested_at: string;
  };
};

const isMedusaError = (error: unknown): error is MedusaError =>
  error instanceof MedusaError;

const extractUpstreamMessage = (error: MedusaError): string | null => {
  // Client error messages embed JSON-stringified upstream payload after the
  // status prefix; we surface the raw text rather than re-parsing here.
  const match = error.message.match(/Return is not cancellable\.?/i);
  return match?.[0] ?? null;
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
      message: cancelResponse.message,
      parent_status: parentStatus,
      requested_at: new Date().toISOString(),
    },
  };
};
