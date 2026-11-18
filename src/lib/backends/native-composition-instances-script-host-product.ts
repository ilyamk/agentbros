import { z } from "zod";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { digest } from "../jobs/model-artifacts";
import { snapshotInstanceFile } from "./native-composition-instances-files";
import { verifyInstancesReceipt } from "./native-composition-instances-receipt";
import { INSTANCE_PARSER_PIN } from "./native-instance-script";
/** Separate trusted C24 package authority. No caller paths, migration or runtime acceptance. */
export const SCRIPT_HOST_PRODUCT_DESCRIPTOR_SHA256 =
  "b70c2d93aee5ac24b290cf32449d8cfc42ca8e96cbeb37dcb9285ea3b68d2318" as const;
export const ScriptHostProductSchema = z
  .object({
    version: z.literal(1),
    activation: z.literal("instances-c24-v1"),
    executionProfile: z.literal("static-local-instances-v2"),
    sourceProfile: z.literal("static-local-instances-v1"),
    verificationScope: z.literal("compiled-source-reproduced"),
    genuineRuntimeAccepted: z.literal(false),
    runtimeSha256: z.literal("958738ab8cd396d067e5735dc241b23dda219e9a33c38f428027d9d4cc55baf3"),
    engineBytes: z.literal(518857),
    sourceClosureSha256: z.literal("3fec9b5beb967a48a2762d66a91daeff40a76b5715934054a648853b00c93408"),
    receipt: z
      .object({
        file: z.literal("instances-script-host-provenance.json"),
        sha256: z.literal("c7e38582522f7d1f5e14f4a4a4804fd8bf4aabed809bed7cafa97a4d284e7767"),
        bytes: z.literal(37912),
      })
      .strict(),
    recipe: z
      .object({
        file: z.literal("prepare-instances-script-host.cjs"),
        sha256: z.literal("fa67c15717e7a8df3f20649dad21d7c7b92f146660bf9b9d34a5ed4a86e9924d"),
      })
      .strict(),
    scriptHostContract: z
      .object({
        file: z.literal("instances-script-host-contract.json"),
        sha256: z.literal("c39c21fadae2f3a5c665212a3d75500f1790a5d2e86acff15c72b21f8866f7b2"),
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
        file: z.literal("instances-selection-provenance.json"),
        sha256: z.literal("a965b37cdc9c8adb7df96ea67656c9430ea0c3ae9558dc2d2e54d2a4f08304d2"),
        bytes: z.literal(36690),
      })
      .strict(),
    parentRecipe: z
      .object({
        file: z.literal("prepare-instances-selection.cjs"),
        sha256: z.literal("2b12cc798584052c52e6a2672f8bd2020a5ecf3e31276e85f75cc13cb8cb48c1"),
      })
      .strict(),
    parentRuntimeSha256: z.literal("5a33249f292aa6e9192d5f93a831e425fda423e08b4087d4cf72deae28043cd1"),
    styleReceipt: z
      .object({
        file: z.literal("instances-style-provenance.json"),
        sha256: z.literal("98f25707e7f5a5e7097e3bcf082d3a3c12c95aae059c63d139f11c2f02a9f584"),
      })
      .strict(),
    styleRecipe: z
      .object({
        file: z.literal("prepare-instances-style.cjs"),
        sha256: z.literal("9298850ccf7041d83cbf689b97bd9efceb5b4af37d62330a98eb3259b093562b"),
      })
      .strict(),
    hookCount: z.literal(23),
    bindingTransform: z
      .object({
        source: z.literal("packages/core/src/runtime/compositionLoader.ts"),
        predecessorSourceSha256: z.literal("92c6a14ff30e16dfdc1e2c571c8eda69e300197649c53dd006b6fad547321873"),
        outputSourceSha256: z.literal("eea3e6d0e54dba72418979bae9859e28df528816708989f542e3450f9b91cb31"),
        replacement: z
          .object({
            start: z.literal(26950),
            end: z.literal(27047),
            original: z.literal(
              "        if (__avcClock.instanceMode === true) __avcClock.instanceArmScript(host, injectedScript);",
            ),
            text: z.literal(
              "        if (__avcClock.instanceMode === true) __avcClock.instanceArmScript(params.host, injectedScript);",
            ),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export function validateScriptHostProduct(value: unknown, sha256: string) {
  if (sha256 !== SCRIPT_HOST_PRODUCT_DESCRIPTOR_SHA256) throw Error("C24 product descriptor checksum differs");
  return ScriptHostProductSchema.parse(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
const directory = fileURLToPath(new URL("../../../tests/fixtures/hyperframes-engine/", import.meta.url));
export function resolveScriptHostProduct() {
  const pin = snapshotInstanceFile(path.join(directory, "instances-script-host-product-v1.json"), directory, 8192);
  return freeze(validateScriptHostProduct(JSON.parse(pin.data.toString("utf8")), pin.sha256));
}
export function validateScriptHostReceipt(receipt: unknown, sha256: string) {
  const product = resolveScriptHostProduct(),
    value = receipt as Record<string, unknown> | null;
  if (sha256 !== product.receipt.sha256) throw Error("C24 compiled receipt checksum differs");
  if (
    !value ||
    Array.isArray(value) ||
    digest(Buffer.from(JSON.stringify(value, null, 2) + "\n")) !== product.receipt.sha256
  )
    throw Error("C24 compiled receipt authority differs");
  if (
    value.engineSha256 !== product.runtimeSha256 ||
    value.engineBytes !== product.engineBytes ||
    value.sourceClosureSha256 !== product.sourceClosureSha256 ||
    value.profile !== product.sourceProfile ||
    value.status !== "source-build-only-not-product-enabled" ||
    value.patchToolSha256 !== product.recipe.sha256 ||
    value.artifactVersion !== "c24-private-script-host-v1" ||
    value.scriptHostBindingContract !== "private-owned-script-host-v1" ||
    value.scriptHostBindingContractSha256 !== product.scriptHostContract.sha256 ||
    value.inheritedC23ReceiptSha256 !== product.parentReceipt.sha256 ||
    value.inheritedC23RecipeSha256 !== product.parentRecipe.sha256 ||
    value.inheritedC23RuntimeSha256 !== product.parentRuntimeSha256 ||
    value.finalPrivateHookCount !== 23
  )
    throw Error("C24 compiled receipt authority differs");
  const transforms = value.bindingTransforms as Record<string, unknown> | undefined;
  if (
    !transforms ||
    Object.keys(transforms).length !== 1 ||
    JSON.stringify(transforms[product.bindingTransform.source]) !== JSON.stringify(product.bindingTransform)
  )
    throw Error("C24 compiled source binding differs");
  const patches = value.patches as Record<string, { replacements: unknown[] }> | undefined;
  const expected = {
    "packages/core/src/runtime/compositionLoader.ts": 6,
    "packages/core/src/compiler/compositionScoping.ts": 5,
    "packages/core/src/runtime/clipTree.ts": 1,
    "packages/core/src/runtime/timeline.ts": 10,
    "packages/core/src/audioGroups.ts": 1,
  };
  if (
    !patches ||
    Object.keys(patches).length !== 5 ||
    Object.entries(expected).some(
      ([name, count]) => !Array.isArray(patches[name]?.replacements) || patches[name].replacements.length !== count,
    )
  )
    throw Error("C24 compiled hook inventory differs");
}
export function verifyScriptHostReceipt() {
  const product = resolveScriptHostProduct();
  const inputs = [
    { ...product.receipt, maximum: 128 * 1024 },
    { ...product.recipe, maximum: 64 * 1024 },
    { ...product.scriptHostContract, maximum: 8192 },
    { ...product.selectionContract, maximum: 8192 },
    { ...product.styleContract, maximum: 8192 },
    { ...product.parentReceipt, maximum: 128 * 1024 },
    { ...product.parentRecipe, maximum: 64 * 1024 },
    { ...product.styleReceipt, maximum: 128 * 1024 },
    { ...product.styleRecipe, maximum: 64 * 1024 },
  ];
  const consumed = inputs.map((input) => {
    const pin = snapshotInstanceFile(path.join(directory, input.file), directory, input.maximum);
    if (pin.sha256 !== input.sha256 || ("bytes" in input && pin.bytes !== input.bytes))
      throw Error("C24 compiled package input differs: " + input.file);
    return { input, pin };
  });
  validateScriptHostReceipt(JSON.parse(consumed[0].pin.data.toString("utf8")), consumed[0].pin.sha256);
  // Immutable parent remains independently authoritative rather than relabelled C24 evidence.
  verifyInstancesReceipt();
  for (const { input, pin } of consumed)
    if (snapshotInstanceFile(path.join(directory, input.file), directory, input.maximum).sha256 !== pin.sha256)
      throw Error("C24 compiled package changed before return");
  resolveScriptHostProduct();
  return {
    buildReceiptSha256: product.receipt.sha256,
    productDescriptorSha256: SCRIPT_HOST_PRODUCT_DESCRIPTOR_SHA256,
    activation: product.activation,
    executionProfile: product.executionProfile,
    sourceProfile: product.sourceProfile,
    verificationScope: product.verificationScope,
    genuineRuntimeAccepted: product.genuineRuntimeAccepted,
    parser: INSTANCE_PARSER_PIN,
  };
}
export function resolveScriptHostPin() {
  const product = resolveScriptHostProduct();
  return Object.freeze({
    profile: product.executionProfile,
    sourceProfile: product.sourceProfile,
    runtimeSha256: product.runtimeSha256,
    engineBytes: product.engineBytes,
    sourceClosureSha256: product.sourceClosureSha256,
    buildReceiptSha256: product.receipt.sha256,
    buildRecipeSha256: product.recipe.sha256,
    scriptHostContractSha256: product.scriptHostContract.sha256,
    selectionContractSha256: product.selectionContract.sha256,
    productVersion: product.version,
    activation: product.activation,
    productDescriptorSha256: SCRIPT_HOST_PRODUCT_DESCRIPTOR_SHA256,
    verificationScope: product.verificationScope,
    genuineRuntimeAccepted: product.genuineRuntimeAccepted,
  });
}
