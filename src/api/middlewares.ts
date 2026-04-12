import { defineMiddlewares } from "@medusajs/framework/http";

export default defineMiddlewares({
  routes: [
    {
      matcher: "/webhooks/*",
      bodyParser: { preserveRawBody: true },
      method: ["POST"],
    },
  ],
});
