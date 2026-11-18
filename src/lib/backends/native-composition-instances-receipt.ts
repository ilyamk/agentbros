import { fileURLToPath } from "node:url";
import path from "node:path";
import { digest } from "../jobs/model-artifacts";
import { snapshotInstanceFile } from "./native-composition-instances-files";
import { resolveInstanceProduct, INSTANCE_PRODUCT_DESCRIPTOR_SHA256 } from "./native-composition-instances-product";
import { INSTANCE_PARSER_PIN } from "./native-instance-script";
/** Fixed compiled package evidence, never a caller-asserted runtime/build receipt. */
export function validateInstancesReceipt(receipt: unknown, sha256: string) {
  const product = resolveInstanceProduct(),
    value = receipt as Record<string, unknown> | null;
  if (sha256 !== product.receipt.sha256) throw Error("Instance compiled build receipt differs");
  if (
    !value ||
    Array.isArray(value) ||
    value.engineSha256 !== product.runtimeSha256 ||
    value.engineBytes !== product.engineBytes ||
    value.sourceClosureSha256 !== product.sourceClosureSha256 ||
    value.profile !== product.profile ||
    value.status !== "source-build-only-not-product-enabled" ||
    value.patchToolSha256 !== product.recipe.sha256 ||
    value.sourceRootSelectionContract !== "private-owned-source-root-v1" ||
    value.sourceRootSelectionContractSha256 !== product.selectionContract.sha256 ||
    value.inertStyleContract !== "private-owned-inert-style-v1" ||
    value.inertStyleContractSha256 !== product.styleContract.sha256 ||
    value.c22ReceiptSha256 !== product.parentReceipt.sha256 ||
    value.c22RecipeSha256 !== product.parentRecipe.sha256 ||
    value.c22RuntimeSha256 !== product.parentRuntimeSha256
  )
    throw Error("Instance compiled build receipt authority differs");
  // The canonical observed encoding binds every closure/patch/metadata field, not just selected assertions.
  if (digest(Buffer.from(JSON.stringify(value, null, 2) + "\n")) !== product.receipt.sha256)
    throw Error("Instance compiled build receipt authority differs");
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
    throw Error("Instance compiled hook inventory differs");
}
export function verifyInstancesReceipt() {
  const product = resolveInstanceProduct(),
    directory = fileURLToPath(new URL("../../../tests/fixtures/hyperframes-engine/", import.meta.url));
  const inputs = [
    { ...product.receipt, maximum: 128 * 1024 },
    { ...product.recipe, maximum: 64 * 1024 },
    { ...product.selectionContract, maximum: 8192 },
    { ...product.styleContract, maximum: 8192 },
    { ...product.parentReceipt, maximum: 128 * 1024 },
    { ...product.parentRecipe, maximum: 64 * 1024 },
  ];
  const consumed = inputs.map((input) => {
    const pin = snapshotInstanceFile(path.join(directory, input.file), directory, input.maximum);
    if (pin.sha256 !== input.sha256 || ("bytes" in input && pin.bytes !== input.bytes))
      throw Error("Instance compiled package input differs: " + input.file);
    return { input, pin };
  });
  const receipt = JSON.parse(consumed[0].pin.data.toString("utf8"));
  validateInstancesReceipt(receipt, consumed[0].pin.sha256);
  for (const { input, pin } of consumed)
    if (snapshotInstanceFile(path.join(directory, input.file), directory, input.maximum).sha256 !== pin.sha256)
      throw Error("Instance compiled package changed before return");
  resolveInstanceProduct();
  return {
    buildReceiptSha256: product.receipt.sha256,
    productDescriptorSha256: INSTANCE_PRODUCT_DESCRIPTOR_SHA256,
    activation: product.activation,
    verificationScope: product.verificationScope,
    parser: INSTANCE_PARSER_PIN,
  };
}
