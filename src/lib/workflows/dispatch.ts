import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin, CliErrorObject } from "../cli";

export const WorkflowKindSchema = z.enum(["product-ad", "education", "recording-edit", "shorts-series"]);
export type WorkflowKind = z.infer<typeof WorkflowKindSchema>;
export interface WorkflowOptions {
  action: "plan" | "create";
  rootDir?: string;
  scopeRoot?: string;
}
export interface WorkflowResult {
  outputs: string[];
  metadata: Record<string, unknown>;
}

export const WORKFLOWS = [
  {
    id: "product-ad",
    description: "Supplied product demonstration, spoken beats, evidence and one CTA.",
    guide: "docs/workflows/product-ad.md",
  },
  {
    id: "education",
    description: "Source-backed lesson, worked example, timed captions and independent chapters.",
    guide: "docs/workflows/education.md",
  },
  {
    id: "recording-edit",
    description: "Reviewed recording selections retaining source speech, captions and protected context.",
    guide: "docs/workflows/recording-edit.md",
  },
  {
    id: "shorts-series",
    description: "Approved contextual selections materialized as independent reusable short projects.",
    guide: "docs/workflows/shorts-series.md",
  },
] as const;

/** Bound allocation before reading; JSON requests are data, never executable modules. */
export function readWorkflowRequest(file: string, scopeRoot?: string): unknown {
  const maximum = 8 * 1024 * 1024;
  if (scopeRoot) assertPathWithin(realpathSync(scopeRoot), realpathSync(file));
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Workflow request must be a regular JSON file from 1 byte to 8 MiB.",
      });
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Workflow request changed while reading");
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Error("Workflow request changed while reading");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Every route constructs local artifacts only. No provider/client is imported here. */
export async function runWorkflow(kind: WorkflowKind, raw: unknown, options: WorkflowOptions): Promise<WorkflowResult> {
  WorkflowKindSchema.parse(kind);
  if (!["plan", "create"].includes(options.action)) throw new Error("Unknown workflow action");
  const rootDir = realpathSync(options.rootDir ?? process.cwd());
  if (options.scopeRoot) assertPathWithin(realpathSync(options.scopeRoot), rootDir);
  const scoped = { ...options, rootDir };
  switch (kind) {
    case "product-ad":
      return (await import("./product-ad")).runProductAdWorkflow(raw, scoped);
    case "education":
      return (await import("./education")).runEducationWorkflow(raw, scoped);
    case "recording-edit":
      return (await import("./recording-edit")).runRecordingEditWorkflow(raw, scoped);
    case "shorts-series":
      return (await import("./shorts-series")).runShortsSeriesWorkflow(raw, scoped);
  }
}

export function workflowGuide(kind: WorkflowKind, rootDir = process.cwd()): string {
  return path.resolve(rootDir, WORKFLOWS.find((workflow) => workflow.id === kind)!.guide);
}
