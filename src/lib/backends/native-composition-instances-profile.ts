import { HYPERFRAMES_INSTANCES_PIN } from "./native-composition-instances-prelude";
import { verifyInstancesReceipt } from "./native-composition-instances-receipt";
import { resolveScriptHostPin, verifyScriptHostReceipt } from "./native-composition-instances-script-host-product";
export type InstanceExecutionProfile = "static-local-instances-v1" | "static-local-instances-v2";
export function isInstanceExecutionProfile(value: unknown): value is InstanceExecutionProfile {
  return value === "static-local-instances-v1" || value === "static-local-instances-v2";
}
export function assertCompositionProfile(value: unknown) {
  if (value === undefined || value === "static-local-tree-v1" || isInstanceExecutionProfile(value)) return value;
  throw Error("Unknown composition execution profile");
}
/** Explicit request routing only. Missing/unknown selectors never mean latest or fallback. */
export function resolveInstancesPin(profile: InstanceExecutionProfile) {
  if (profile === "static-local-instances-v1") return HYPERFRAMES_INSTANCES_PIN;
  if (profile === "static-local-instances-v2") return resolveScriptHostPin();
  throw Error("Unknown instance execution profile");
}
export function verifyInstanceExecutionProfile(profile: InstanceExecutionProfile) {
  if (profile === "static-local-instances-v1") return verifyInstancesReceipt();
  if (profile === "static-local-instances-v2") return verifyScriptHostReceipt();
  throw Error("Unknown instance execution profile");
}
export function assertInstanceRuntime(profile: InstanceExecutionProfile, sha256: string) {
  verifyInstanceExecutionProfile(profile);
  const pin = resolveInstancesPin(profile);
  if (sha256 !== pin.runtimeSha256) throw Error("Instance runtime differs from selected execution profile");
  return pin;
}
