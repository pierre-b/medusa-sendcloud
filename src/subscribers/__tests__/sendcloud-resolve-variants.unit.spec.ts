import { resolveSendcloudVariants } from "../sendcloud-resolve-variants";

type Scope = Record<string, unknown>;

const CANONICAL_QUERY_KEY = "query";
const CANONICAL_LOGGER_KEY = "logger";

const buildContainer = (scope: Scope = {}) =>
  ({
    resolve: jest.fn((key: string) => scope[key]),
  }) as unknown as Parameters<typeof resolveSendcloudVariants>[0];

const workflowRun = jest.fn(async (_args: unknown) => ({}));

jest.mock("../../workflows/enrich-sendcloud-variants", () => ({
  enrichSendcloudVariantsWorkflow: jest.fn(() => ({
    run: (args: unknown) => workflowRun(args),
  })),
}));

const loggerStub = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

describe("resolveSendcloudVariants subscriber", () => {
  beforeEach(() => {
    workflowRun.mockClear();
    loggerStub.debug.mockClear();
  });

  it("resolves variants via Query and invokes the enrich workflow", async () => {
    const graph = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: "order_1",
            items: [
              { variant_id: "var_a" },
              { variant_id: "var_b" },
              { variant_id: "var_a" }, // duplicate, should de-dupe
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "var_a",
            hs_code: "180690",
            origin_country: "FR",
            weight: 90,
          },
          {
            id: "var_b",
            hs_code: "180631",
            origin_country: "BE",
            weight: null,
          },
        ],
      });

    const container = buildContainer({
      [CANONICAL_QUERY_KEY]: { graph },
      [CANONICAL_LOGGER_KEY]: loggerStub,
    });

    await resolveSendcloudVariants(container, "order_1");

    expect(graph).toHaveBeenNthCalledWith(1, {
      entity: "order",
      filters: { id: "order_1" },
      fields: ["id", "items.variant_id"],
    });
    expect(graph).toHaveBeenNthCalledWith(2, {
      entity: "product_variant",
      filters: { id: ["var_a", "var_b"] },
      fields: ["id", "hs_code", "origin_country", "weight"],
    });
    expect(workflowRun).toHaveBeenCalledWith({
      input: {
        orderId: "order_1",
        variants: {
          var_a: { hs_code: "180690", origin_country: "FR", weight: 90 },
          var_b: { hs_code: "180631", origin_country: "BE" },
        },
      },
    });
  });

  it("short-circuits when the order has no variant_ids", async () => {
    const graph = jest.fn().mockResolvedValueOnce({
      data: [{ id: "order_2", items: [] }],
    });
    const container = buildContainer({
      [CANONICAL_QUERY_KEY]: { graph },
      [CANONICAL_LOGGER_KEY]: loggerStub,
    });

    await resolveSendcloudVariants(container, "order_2");

    expect(graph).toHaveBeenCalledTimes(1);
    expect(workflowRun).not.toHaveBeenCalled();
  });

  it("skips the workflow when variants resolve no customs data", async () => {
    const graph = jest
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "order_3", items: [{ variant_id: "var_c" }] }],
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "var_c",
            hs_code: null,
            origin_country: null,
            weight: null,
          },
        ],
      });

    const container = buildContainer({
      [CANONICAL_QUERY_KEY]: { graph },
      [CANONICAL_LOGGER_KEY]: loggerStub,
    });

    await resolveSendcloudVariants(container, "order_3");

    expect(workflowRun).not.toHaveBeenCalled();
    expect(loggerStub.debug).toHaveBeenCalledWith(
      expect.stringContaining("order_3")
    );
  });

  it("returns without side effects when the order is missing", async () => {
    const graph = jest.fn().mockResolvedValueOnce({ data: [] });
    const container = buildContainer({
      [CANONICAL_QUERY_KEY]: { graph },
      [CANONICAL_LOGGER_KEY]: loggerStub,
    });

    await resolveSendcloudVariants(container, "order_missing");

    expect(graph).toHaveBeenCalledTimes(1);
    expect(workflowRun).not.toHaveBeenCalled();
  });
});
