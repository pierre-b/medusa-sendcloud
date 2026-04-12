import Medusa from "@medusajs/js-sdk";

export const sdk = new Medusa({
  baseUrl: import.meta.env.VITE_MEDUSA_BACKEND_URL ?? "/",
  debug: false,
  auth: { type: "session" },
});
