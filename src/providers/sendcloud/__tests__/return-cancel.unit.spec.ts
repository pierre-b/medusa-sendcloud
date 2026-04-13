import nock from "nock";

import { MedusaError } from "@medusajs/framework/utils";
import type { Logger } from "@medusajs/framework/types";

import {
  DEFAULT_SENDCLOUD_BASE_URL,
  SendCloudClient,
} from "../../../services/sendcloud-client";
import { cancelReturn } from "../return-cancel";

const noopLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const buildClient = () =>
  new SendCloudClient({
    publicKey: "pub",
    privateKey: "priv",
    retryBaseDelayMs: 0,
    logger: noopLogger,
  });

describe("cancelReturn", () => {
  it("PATCHes /returns/:id/cancel and returns message + parent_status", async () => {
    let capturedMethod: string | undefined;
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .patch("/api/v3/returns/98765/cancel", (body) => {
        capturedMethod = "PATCH";
        return body === undefined || Object.keys(body ?? {}).length === 0;
      })
      .reply(202, { message: "Cancellation requested successfully" });

    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get("/api/v3/returns/98765")
      .reply(200, {
        data: { id: 98765, parent_status: "cancelling-upstream" },
      });

    const result = await cancelReturn(buildClient(), 98765);

    expect(capturedMethod).toBe("PATCH");
    expect(result).toEqual({
      sendcloud_return_cancellation: {
        return_id: 98765,
        message: "Cancellation requested successfully",
        parent_status: "cancelling-upstream",
        requested_at: expect.any(String),
      },
    });
  });

  it("throws NOT_FOUND when SendCloud returns 404", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .patch("/api/v3/returns/12345/cancel")
      .reply(404, { errors: [{ message: "Return not found" }] });

    await expect(cancelReturn(buildClient(), 12345)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
      message: expect.stringMatching(/return 12345/i),
    });
  });

  it("throws NOT_ALLOWED on 409 carrying SendCloud's reason", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .patch("/api/v3/returns/55555/cancel")
      .reply(409, {
        errors: [
          {
            field: "returns",
            code: 409,
            message: "Return is not cancellable.",
          },
        ],
      });

    await expect(cancelReturn(buildClient(), 55555)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/Return is not cancellable\./),
    });
  });

  it("surfaces non-default 409 reasons verbatim (carrier-specific rejection)", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .patch("/api/v3/returns/66666/cancel")
      .reply(409, {
        errors: [
          {
            field: "returns",
            code: 409,
            message: "Return already shipped to customer",
          },
        ],
      });

    await expect(cancelReturn(buildClient(), 66666)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/Return already shipped to customer/),
    });
  });

  it("returns parent_status: null when the follow-up GET fails", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .patch("/api/v3/returns/77777/cancel")
      .reply(202, { message: "Cancellation requested successfully" });

    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get("/api/v3/returns/77777")
      .times(4)
      .reply(500);

    const result = await cancelReturn(buildClient(), 77777);

    expect(result).toMatchObject({
      sendcloud_return_cancellation: {
        message: "Cancellation requested successfully",
        parent_status: null,
      },
    });
  });

  it("throws INVALID_DATA without any HTTP call when returnId is invalid", async () => {
    await expect(
      cancelReturn(buildClient(), "not-a-number" as unknown as number)
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
    });

    await expect(cancelReturn(buildClient(), 0)).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
    });

    await expect(cancelReturn(buildClient(), -5)).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
    });
    // No nock interceptor was registered, and setup-nock.ts calls
    // disableNetConnect() — any rogue HTTP call would have thrown a
    // NetConnectNotAllowedError before the INVALID_DATA assertion fires.
  });

  it("PATCH targets the exact path with empty body", async () => {
    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .patch("/api/v3/returns/42/cancel")
      .reply(202, { message: "ok" });

    nock(DEFAULT_SENDCLOUD_BASE_URL)
      .get("/api/v3/returns/42")
      .reply(200, { data: { id: 42, parent_status: "cancelling" } });

    await cancelReturn(buildClient(), 42);

    expect(nock.isDone()).toBe(true);
  });
});
