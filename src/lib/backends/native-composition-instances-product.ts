import { z } from "zod";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { snapshotInstanceFile } from "./native-composition-instances-files";
/** Fixed package authority; no request paths/options or runtime acceptance assertion. */
export const INSTANCE_PRODUCT_DESCRIPTOR_SHA256 =
  "65a4dbc576a3844a387045cc5e4f97e0b025ee7563aae76ca583a3693b850f0d" as const;
export const InstanceProductSchema = z
  .object({
    version: z.literal(1),
    activation: z.literal("instances-c23-v1"),
    profile: z.literal("static-local-instances-v1"),
    verificationScope: z.literal("compiled-source-reproduced"),
    genuineRuntimeAccepted: z.literal(false),
    runtimeSha256: z.literal("5a33249f292aa6e9192d5f93a831e425fda423e08b4087d4cf72deae28043cd1"),
    engineBytes: z.literal(518855),
    sourceClosureSha256: z.literal("3fec9b5beb967a48a2762d66a91daeff40a76b5715934054a648853b00c93408"),
    receipt: z
      .object({
        file: z.literal("instances-selection-provenance.json"),
        sha256: z.literal("a965b37cdc9c8adb7df96ea67656c9430ea0c3ae9558dc2d2e54d2a4f08304d2"),
        bytes: z.literal(36690),
      })
      .strict(),
    recipe: z
      .object({
        file: z.literal("prepare-instances-selection.cjs"),
        sha256: z.literal("2b12cc798584052c52e6a2672f8bd2020a5ecf3e31276e85f75cc13cb8cb48c1"),
      })
      .strict(),
    selectionContract: z
      .object({
        file: z.literal("instances-selection-contract.json"),
        sha256: z.literal("5c3882a193714b74af5e0c6d95b6c47fad909aa06fe4a69b8e6d60ab7602c535"),
      })
      .strict(),
    styleContract: z
      .object({
        file: z.literal("instances-style-contract.json"),
        sha256: z.literal("b90aaa716f4c30ed217fe009b46ce3f7750b842e531196d12f40bd1097067f6a"),
      })
      .strict(),
    parentReceipt: z
      .object({
        file: z.literal("instances-style-provenance.json"),
        sha256: z.literal("98f25707e7f5a5e7097e3bcf082d3a3c12c95aae059c63d139f11c2f02a9f584"),
      })
      .strict(),
    parentRecipe: z
      .object({
        file: z.literal("prepare-instances-style.cjs"),
        sha256: z.literal("9298850ccf7041d83cbf689b97bd9efceb5b4af37d62330a98eb3259b093562b"),
      })
      .strict(),
    parentRuntimeSha256: z.literal("b856e7ed182437e84d9870aaac9599f73ea841f4040ca0c6e107adb7aaafbcc8"),
    hookCount: z.literal(23),
  })
  .strict();
export function validateInstanceProduct(value: unknown, sha256: string) {
  if (sha256 !== INSTANCE_PRODUCT_DESCRIPTOR_SHA256) throw Error("Instance product descriptor checksum differs");
  return InstanceProductSchema.parse(value);
}
export function resolveInstanceProduct() {
  const file = fileURLToPath(
    new URL("../../../tests/fixtures/hyperframes-engine/instances-selection-product-v1.json", import.meta.url),
  );
  const pin = snapshotInstanceFile(file, path.dirname(file), 4096);
  const value = validateInstanceProduct(JSON.parse(pin.data.toString("utf8")), pin.sha256);
  return Object.freeze({
    ...value,
    receipt: Object.freeze(value.receipt),
    recipe: Object.freeze(value.recipe),
    selectionContract: Object.freeze(value.selectionContract),
    styleContract: Object.freeze(value.styleContract),
    parentReceipt: Object.freeze(value.parentReceipt),
    parentRecipe: Object.freeze(value.parentRecipe),
  });
}
