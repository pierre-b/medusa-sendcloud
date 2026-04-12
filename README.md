# medusa-sendcloud

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

Medusa v2 plugin that provides a [SendCloud](https://www.sendcloud.com/) fulfillment module provider: shipping rates, label generation, tracking, returns, multi-collo, service points, and admin UI.

> **Status:** foundation / scaffolding. No SendCloud API calls implemented yet. See `docs/` for the per-feature rollout.

## Installation

```bash
# In your Medusa application
npm install medusa-sendcloud
```

Then register the plugin and its provider in `medusa-config.ts`:

```ts
import { defineConfig } from "@medusajs/framework/utils";

module.exports = defineConfig({
  plugins: [{ resolve: "medusa-sendcloud", options: {} }],
  modules: [
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          { resolve: "@medusajs/medusa/fulfillment-manual", id: "manual" },
          {
            resolve: "medusa-sendcloud/providers/sendcloud",
            id: "sendcloud",
            options: {
              publicKey: process.env.SENDCLOUD_PUBLIC_KEY,
              privateKey: process.env.SENDCLOUD_PRIVATE_KEY,
            },
          },
        ],
      },
    },
  ],
});
```

Both entries are required: `plugins:` loads API routes, subscribers, workflows, and admin extensions; `modules:` attaches the provider to the Fulfillment Module.

## Configuration

See [`src/types/plugin-options.ts`](./src/types/plugin-options.ts) for the full options type. Required: `publicKey`, `privateKey`.

## Development

```bash
npm install
make dev          # watch + republish to local yalc
make check        # lint + format + typecheck
make test-unit    # unit tests
```

This repo follows Red-Green-Refactor TDD. See `CLAUDE.md` for the full methodology.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
