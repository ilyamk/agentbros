import { readFileSync } from "node:fs";
import path from "node:path";

export const RUNTIME_ROOT = path.resolve(import.meta.dirname, "../..");
export function runtimePolicy(root = RUNTIME_ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    config?: { nodePrimary?: string; nodeFallback?: string };
    engines?: { node?: string };
    packageManager?: string;
  };
  const primary = manifest.config?.nodePrimary,
    fallback = manifest.config?.nodeFallback;
  if (
    !primary ||
    !fallback ||
    !/^\d+\.\d+\.\d+$/u.test(primary) ||
    !/^\d+\.\d+\.\d+$/u.test(fallback) ||
    primary === fallback
  )
    throw new Error("Exact primary and fallback Node versions are required in package.json");
  if (
    manifest.engines?.node !== enginesRange(primary, fallback) ||
    readFileSync(path.join(root, ".nvmrc"), "utf8").trim() !== primary ||
    readFileSync(path.join(root, ".nvmrc.fallback"), "utf8").trim() !== fallback
  )
    throw new Error("Node policy, engines and nvm version files disagree");
  if (!/^pnpm@\d+\.\d+\.\d+$/u.test(manifest.packageManager ?? ""))
    throw new Error("An exact pnpm packageManager is required");
  return { primary, fallback, packageManager: manifest.packageManager! };
}
export function runtimeStatus(actual = process.versions.node, root = RUNTIME_ROOT) {
  const policy = runtimePolicy(root);
  const role =
    actual === policy.primary
      ? ("primary" as const)
      : actual === policy.fallback
        ? ("fallback" as const)
        : withinLine(actual, policy.primary) || withinLine(actual, policy.fallback)
          ? ("compatible" as const)
          : ("unsupported" as const);
  return { ...policy, actual, executable: process.execPath, role };
}
/** Same major as a pin: pin 26.13.1 accepts any 26.x.y release. CI tests only the exact pins, so a compatible runtime warns. */
export function withinLine(actual: string, pin: string): boolean {
  const a = /^(\d+)\.(\d+)\.(\d+)$/u.exec(actual),
    p = /^(\d+)\.(\d+)\.(\d+)$/u.exec(pin);
  return Boolean(a && p && Number(a[1]) === Number(p[1]));
}
/** package.json engines: any release of the primary or fallback major. */
export function enginesRange(primary: string, fallback: string): string {
  return `^${primary.split(".")[0]}.0.0 || ^${fallback.split(".")[0]}.0.0`;
}
/** One stderr line for a compatible but unpinned runtime; empty otherwise. */
export function runtimeWarning(runtime: ReturnType<typeof runtimeStatus>): string {
  return runtime.role === "compatible"
    ? `[runtime] Node ${runtime.actual} is accepted but untested; the pinned versions are ${runtime.primary} (primary) and ${runtime.fallback} (reserve). See docs/node-runtime.md.\n`
    : "";
}
