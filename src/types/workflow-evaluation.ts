import { z } from "zod";
import { BenchPathSchema } from "./bench";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const WorkflowBoundarySchema = z.enum([
  "instructions",
  "discovery",
  "routing",
  "prerequisites",
  "preparation",
  "execution",
  "validation",
  "handoff",
  "consumption",
  "environment",
  "harness",
  "quality",
  "observation",
]);
export const WorkflowPinSchema = z
  .object({ path: BenchPathSchema, sha256: hash, bytes: z.number().int().nonnegative() })
  .strict();
export const WorkflowScenarioSchema = z
  .object({
    version: z.union([z.literal(2), z.literal(3)]),
    id,
    task: z.string().min(1).max(12000),
    seed: z.number().int().nonnegative(),
    kind: z.enum(["recording", "voice", "discovery", "policy", "native", "delegation", "recovery", "product"]),
    platforms: z.array(z.enum(["darwin", "linux", "win32"])).min(1),
    material: z.array(WorkflowPinSchema.extend({ licence: z.string().min(1) }).strict()).max(32),
    commands: z.array(z.string().min(1).max(100)).min(1).max(100),
    outcomes: z
      .array(z.enum(["handoff", "draft-refused", "alternative", "user-action", "unsupported", "bounded-recovery"]))
      .min(1),
    requiresLeaf: z.boolean().default(false),
    oracle: id.optional(),
    modes: z
      .array(z.enum(["contract", "native", "agent"]))
      .min(1)
      .optional(),
    quality: WorkflowPinSchema.optional(),
    limits: z
      .object({
        wallTimeSec: z.number().int().min(1).max(1800),
        tokens: z.number().int().min(1).max(1000000),
        commands: z.number().int().min(1).max(200),
        leaves: z.number().int().min(0).max(2),
        transcriptBytes: z.number().int().min(1024).max(33554432),
        fileBytes: z.number().int().min(1024).max(67108864),
        mediaSpendUsd: z.literal(0),
        downloadBytes: z.literal(0),
      })
      .strict(),
  })
  .strict()
  .refine((v) => !v.requiresLeaf || v.limits.leaves > 0, "A leaf scenario needs an explicit leaf allowance")
  .refine((v) => v.version !== 3 || (!!v.oracle && !!v.modes), "Revision 3 requires an explicit oracle and modes");
export type WorkflowScenario = z.infer<typeof WorkflowScenarioSchema>;
export const WorkflowSuiteSchema = z
  .object({
    version: z.number().int().min(2),
    protocol: z.literal("agent-workflow"),
    noSpend: z.boolean().optional(),
    profile: z
      .object({
        harness: z.enum(["codex", "claude-code"]),
        model: z.string().min(1),
        harnessVersion: z.string().min(1),
      })
      .strict()
      .optional(),
    scenarios: z
      .array(z.object({ id, path: BenchPathSchema, sha256: hash }).strict())
      .min(1)
      .max(100),
  })
  .strict()
  .refine((v) => new Set(v.scenarios.map((s) => s.id)).size === v.scenarios.length, "Duplicate scenario");
export const WorkflowEventSchema = z
  .object({
    version: z.literal(2),
    runId: id,
    id,
    actor: id,
    parent: id.nullable(),
    kind: z.enum(["discovery", "preparation", "command", "validation", "consumption", "delegation", "blocker"]),
    authority: z.enum(["trusted-executor", "fixture", "installed-native"]),
    command: z.string().max(100),
    argv: z.array(z.string().max(12000)).max(100),
    startedAt: z.string().datetime(),
    elapsedMs: z.number().finite().nonnegative(),
    exitCode: z.number().int().nullable(),
    node: z.object({ version: z.string(), executable: z.string() }).strict(),
    inputs: z.array(WorkflowPinSchema).max(100),
    outputs: z.array(WorkflowPinSchema).max(100),
    passed: z.boolean(),
    detail: z.string().max(4000),
    stdout: z.string().max(262144).optional(),
    stderr: z.string().max(262144).optional(),
  })
  .strict();
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
export const WorkflowFindingSchema = z
  .object({
    boundary: WorkflowBoundarySchema,
    status: z.enum(["failed", "inconclusive", "skipped"]),
    message: z.string().min(1).max(4000),
    eventId: id.optional(),
  })
  .strict();
export type WorkflowFinding = z.infer<typeof WorkflowFindingSchema>;
export const WorkflowLayerSchema = z
  .object({ status: z.enum(["passed", "failed", "skipped", "inconclusive"]), reason: z.string().min(1).max(2000) })
  .strict();
export const WorkflowReportSchema = z
  .object({
    version: z.union([z.literal(2), z.literal(3)]),
    protocol: z.literal("agent-workflow"),
    runId: id,
    scenario: id,
    scenarioSha256: hash,
    source: z.object({ sha256: hash, dirty: z.boolean() }).strict(),
    mode: z.enum(["contract", "native", "agent"]),
    status: z.enum(["passed", "failed", "skipped", "inconclusive"]),
    outcome: z.string().max(200).nullable(),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    seed: z.number().int(),
    runtime: z
      .object({
        version: z.string(),
        executable: z.string(),
        role: z.enum(["primary", "fallback", "compatible", "unsupported"]),
      })
      .strict(),
    harness: z
      .object({ name: z.enum(["codex", "claude-code"]), model: z.string(), version: z.string(), fixture: z.boolean() })
      .strict()
      .nullable(),
    findings: z.array(WorkflowFindingSchema).max(200),
    events: z.array(WorkflowEventSchema).max(1000),
    metrics: z
      .object({
        commands: z.number().int().nonnegative(),
        failedCommands: z.number().int().nonnegative(),
        repeatedCommands: z.number().int().nonnegative(),
        actors: z.number().int().nonnegative(),
        elapsedMs: z.number().nonnegative(),
        tokens: z
          .object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
          .strict()
          .nullable(),
        observedTokens: z
          .object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
          .strict()
          .nullable(),
        observedMediaSpendUsd: z.number().nonnegative(),
        pendingOwnedCommands: z.number().int().nonnegative(),
        orphanProcesses: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    layers: z
      .object({
        contract: WorkflowLayerSchema,
        native: WorkflowLayerSchema,
        agent: WorkflowLayerSchema,
        quality: WorkflowLayerSchema,
      })
      .strict()
      .optional(),
    noSpend: z.boolean().optional(),
    limitations: z.array(z.string().max(2000)).max(30),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.version === 3 && (!report.layers || report.noSpend === undefined))
      context.addIssue({ code: "custom", message: "Revision 3 requires explicit layer coverage and spending policy" });
    if (report.layers && report.layers[report.mode].status !== report.status)
      context.addIssue({ code: "custom", message: "Executed layer status differs from the report" });
    if (report.noSpend && report.mode === "agent")
      context.addIssue({ code: "custom", message: "No-spend reports cannot claim agent execution" });
    const ids = new Set<string>();
    for (const event of report.events) {
      if (
        event.runId !== report.runId ||
        ids.has(event.id) ||
        (event.actor === "root" ? event.parent !== null : event.parent !== "root")
      )
        context.addIssue({ code: "custom", message: "Event run, identity or parent ownership is inconsistent" });
      ids.add(event.id);
    }
    const commands = report.events.filter((e) => e.kind === "command" || e.kind === "discovery");
    if (
      commands.length !== report.metrics.commands ||
      commands.filter((e) => !e.passed).length !== report.metrics.failedCommands
    )
      context.addIssue({ code: "custom", message: "Command metrics differ from the recorded events" });
    if (
      report.status === "passed" &&
      (!report.outcome || report.findings.length || report.metrics.pendingOwnedCommands)
    )
      context.addIssue({
        code: "custom",
        message: "Passed reports require a validated terminal outcome and no unresolved findings or owned commands",
      });
  });
export type WorkflowReport = z.infer<typeof WorkflowReportSchema>;
