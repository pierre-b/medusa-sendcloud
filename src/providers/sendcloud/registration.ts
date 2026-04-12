// Medusa registers fulfillment module providers under a composed key of
// the form `fp_{identifier}_{id}`, where {id} is whatever the consumer set
// in medusa-config.ts and {identifier} is our static SendCloudFulfillmentProvider.identifier.
//
// The default setup uses `id: "sendcloud"` which matches our identifier, so
// the resolved key is `fp_sendcloud_sendcloud`. Consumers who register
// multiple SendCloud providers (e.g. per brand) would need to adjust — see
// NOTES.md for the parked multi-id container-key concern.
export const buildProviderRegistrationKey = (identifier: string): string =>
  `fp_${identifier}_${identifier}`;
