import type { FalOperationContextSchema } from "../../../types/generation";
import type { ProviderId } from "../../../types/fal-catalog";
import type { z } from "zod";
import type { JsonSchema, SchemaComponents } from "../json-schema-validate";

/**
 * Guard plugins: semantic checks a JSON Schema cannot state (docs/fal-integration.md, "Request path").
 * Each plugin lives in its own file and is registered in all.ts. Guards run after strict schema validation,
 * by phase ("before", "main", "after"), then in registration order; they may throw FalOperationError,
 * push warnings, or normalise the input in place (the input is validated again afterwards).
 */
export type FalGuardInfo = {
  endpoint: string;
  provider?: ProviderId;
  /** Legacy routing family of a tracked snapshot; "catalog" for catalogue-only endpoints. */
  family?: string;
  variant?: string;
  /** Legacy operation of a tracked snapshot; the category for catalogue endpoints. */
  operation?: string;
  category?: string;
  /** The resolved root input schema and its components. */
  inputSchema: JsonSchema;
  components: SchemaComponents;
};
export type FalGuardContext = z.output<typeof FalOperationContextSchema> & { provider?: ProviderId };
export type FalGuard = {
  id: string;
  phase?: "before" | "main" | "after";
  match: (info: FalGuardInfo) => boolean;
  check: (input: Record<string, unknown>, ctx: FalGuardContext, warnings: string[], info: FalGuardInfo) => void;
};

const PHASES = { before: 0, main: 1, after: 2 } as const;
const registry: FalGuard[] = [];
export function registerFalGuard(guard: FalGuard): void {
  if (registry.some((item) => item.id === guard.id)) throw new Error(`Fal guard ${guard.id} is already registered.`);
  registry.push(guard);
}
/** Registered guards in application order. */
export function listFalGuards(): readonly FalGuard[] {
  return registry
    .map((guard, index) => ({ guard, index }))
    .sort((a, b) => PHASES[a.guard.phase ?? "main"] - PHASES[b.guard.phase ?? "main"] || a.index - b.index)
    .map(({ guard }) => guard);
}
/** Runs every matching guard; returns the IDs that ran. */
export function applyFalGuards(
  input: Record<string, unknown>,
  ctx: FalGuardContext,
  warnings: string[],
  info: FalGuardInfo,
): string[] {
  const ran: string[] = [];
  for (const guard of listFalGuards()) {
    if (!guard.match(info)) continue;
    guard.check(input, ctx, warnings, info);
    ran.push(guard.id);
  }
  return ran;
}
export function falGuardContext(context: FalGuardContext | undefined): FalGuardContext {
  return context ?? { media: {}, allowTranslatedSpeech: false };
}
export function arrayField(input: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(input[key]) ? (input[key] as unknown[]) : [];
}
