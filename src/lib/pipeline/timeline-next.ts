/**
 * The timeline route's next step: a project.json (a recipe draft, a campaign child, a `project:new` project, an old
 * template-mode project whose pipeline-state.json is ignored) is rendered, checked and delivered as it stands: render → qa → delivery → done. Reads only;
 * every command it names already exists (`pnpm render`, `pnpm qa:editorial`, `pnpm delivery`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { readProjectPlaybook } from "../playbooks/project";
import type { CaptureMoment } from "./memory";
import {
  captureFields,
  memoryFields,
  timelineRead,
  withPlaybook,
  type CaptureFields,
  type MemoryFields,
  type PlaybookAnswer,
} from "./route";

export const TIMELINE_STEPS = {
  render: "Render",
  qa: "Editorial QA",
  delivery: "Delivery check",
  done: "Done",
} as const;
export type TimelineStep = keyof typeof TIMELINE_STEPS;

export type TimelineNext = {
  step: TimelineStep;
  title: string;
  action: "run" | "fix" | "ask" | "stop";
  why: string;
  commands: string[];
  optional?: string[];
  userDecides?: string[];
  read: string[];
  playbook?: PlaybookAnswer["playbook"];
  playbookHint?: string;
  state: {
    formats: string[];
    timeline: boolean;
    renders: Record<string, "fresh" | "stale" | "missing">;
    qa: string | null;
    delivery: string | null;
  };
} & MemoryFields &
  CaptureFields;

const FORMATS = new Set(["vertical", "square", "landscape"]);

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};
const mtime = (file: string): number => (existsSync(file) ? statSync(file).mtimeMs : 0);
const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A full render counts with its non-partial receipt; it is stale when project.json or the timeline journal changed after it. */
function renderState(
  projectDir: string,
  outDir: string,
  format: string,
): { state: "fresh" | "stale" | "missing"; receiptMtime: number } {
  const file = path.join(outDir, `${format}.mp4`);
  const receiptFile = `${file}.receipt.json`;
  const receipt = readJson(receiptFile) as
    { partial?: unknown; sources?: { path?: unknown; sha256?: unknown }[] } | undefined;
  if (!existsSync(file) || !receipt || receipt.partial) return { state: "missing", receiptMtime: 0 };
  const receiptMtime = mtime(receiptFile);
  for (const input of [
    path.join(projectDir, "project.json"),
    path.join(projectDir, "pipeline", "timeline-edit.json"),
  ]) {
    if (!existsSync(input)) continue;
    const suffix = path
      .relative(path.dirname(path.dirname(projectDir)), input)
      .split(path.sep)
      .join("/");
    const entry = (receipt.sources ?? []).find((source) =>
      String(source.path).split(path.sep).join("/").endsWith(suffix),
    );
    const fresh =
      entry && typeof entry.sha256 === "string" ? entry.sha256 === sha256File(input) : receiptMtime >= mtime(input);
    if (!fresh) return { state: "stale", receiptMtime };
  }
  return { state: "fresh", receiptMtime };
}

/** The newest delivery report (pipeline/delivery/reports), its state and mtime. */
function latestDeliveryReport(projectDir: string): { file: string; state: unknown; mtime: number } | undefined {
  const dir = path.join(projectDir, "pipeline", "delivery", "reports");
  if (!existsSync(dir)) return undefined;
  const newest = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, mtime: mtime(path.join(dir, name)) }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return undefined;
  return {
    file: path.join(dir, newest.name),
    state: readJson(path.join(dir, newest.name))?.["state"],
    mtime: newest.mtime,
  };
}

/** The timeline route's next step for public/projects/<projectId> under rootDir. */
export function timelineNext(projectId: string, rootDir = process.cwd()): TimelineNext {
  const projectDir = path.join(rootDir, "public", "projects", projectId);
  const shown = (file: string) => path.relative(rootDir, file).split(path.sep).join("/");
  const outDir = path.join(rootDir, "out", projectId);
  const config = readJson(path.join(projectDir, "project.json"));
  const declared = Array.isArray(config?.["formats"])
    ? (config["formats"] as unknown[]).filter(
        (format): format is string => typeof format === "string" && FORMATS.has(format),
      )
    : [];
  const formats = declared.length ? [...new Set(declared)] : ["vertical"];
  // A video:workflow project or an edited timeline renders its journal (render-guard refuses plain scene rendering of a workflow).
  const timeline = ["timeline-edit.json", "workflow-render.json"].some((file) =>
    existsSync(path.join(projectDir, "pipeline", file)),
  );
  const renderArgs = (format: string) =>
    ["pnpm render --project", projectId, "--format", format, ...(timeline ? ["--timeline"] : [])].join(" ");
  const renders = Object.fromEntries(formats.map((format) => [format, renderState(projectDir, outDir, format)]));
  const qaFile = path.join(projectDir, "pipeline", "editorial-qa.json");
  const requestFile = `public/projects/${projectId}/pipeline/delivery/request.json`;
  const report = latestDeliveryReport(projectDir);
  const newestRender = Math.max(0, ...Object.values(renders).map((render) => render.receiptMtime));
  const state: TimelineNext["state"] = {
    formats,
    timeline,
    renders: Object.fromEntries(Object.entries(renders).map(([format, render]) => [format, render.state])),
    qa: existsSync(qaFile) ? shown(qaFile) : null,
    delivery: report ? shown(report.file) : null,
  };

  const answer = (
    step: TimelineStep,
    rest: Omit<TimelineNext, "step" | "title" | "read" | "state">,
    moment?: CaptureMoment,
  ): TimelineNext => {
    const playbook = readProjectPlaybook(projectDir)?.id;
    const bound = withPlaybook(projectDir, timelineRead(step), step);
    return {
      step,
      title: TIMELINE_STEPS[step],
      ...rest,
      ...bound,
      ...memoryFields(projectDir, step, playbook),
      ...captureFields(projectDir, moment, step, playbook ? { playbook } : {}),
      state,
    };
  };

  const pending = formats.find((format) => renders[format]!.state !== "fresh");
  if (pending) {
    const stale = renders[pending]!.state === "stale";
    return answer("render", {
      action: "run",
      why: stale
        ? `out/${projectId}/${pending}.mp4 is older than project.json or the timeline journal; rendering overwrites it (copy it first to keep it).`
        : `No full ${pending} render of ${projectId} yet. The render writes out/${projectId}/${pending}.mp4 and its receipt, which delivery checks.`,
      commands: [renderArgs(pending)],
      optional: [
        `Preview a stretch first: ${renderArgs(pending)} --frames 0-299 (an excerpt; delivery never accepts it).`,
      ],
    });
  }

  const primary = formats[0]!;
  const qa = readJson(qaFile) as { status?: unknown; findings?: { severity?: unknown }[] } | undefined;
  const qaCommand = [
    "pnpm qa:editorial --project",
    projectId,
    "--format",
    primary,
    "--render",
    `out/${projectId}/${primary}.mp4`,
    ...(timeline ? ["--timeline"] : []),
  ].join(" ");
  if (!qa || mtime(qaFile) < newestRender) {
    return answer("qa", {
      action: "run",
      why: qa
        ? `pipeline/editorial-qa.json predates the latest render; check the render again.`
        : "Every format is rendered; no editorial QA report yet.",
      commands: [qaCommand],
      optional: [
        `Frames to look at: pnpm qa:screenshots --project ${projectId} --format ${primary}`,
        `One contact sheet: pnpm review:sheet --project ${projectId} --output out/${projectId}/review-sheet.png`,
      ],
    });
  }
  if (qa.status === "failed") {
    const errors = (qa.findings ?? []).filter((finding) => finding.severity === "error").length;
    return answer("qa", {
      action: "fix",
      why: `Editorial QA failed with ${errors} blocking finding(s) in ${shown(qaFile)}. Fix project.json or the timeline (pnpm timeline:edit), render again, then rerun QA.`,
      commands: [qaCommand],
    });
  }

  if (!report || report.mtime < newestRender || report.state !== "production-ready") {
    const failed =
      report && report.mtime >= newestRender
        ? ` The latest check (${shown(report.file)}) is ${String(report.state)}: read its findings.`
        : "";
    return answer(
      "delivery",
      {
        action: "ask",
        why: `QA passed. A project.json delivers with approvalMode "manual": the user watches every render and supplies manualApproval and visualReview in ${requestFile} (docs/delivery.md).${failed}`,
        commands: [
          `pnpm delivery --action snapshot --request ${requestFile}`,
          `pnpm delivery --action check --request ${requestFile} --snapshot public/projects/${projectId}/pipeline/delivery/snapshots/<snapshot id>.json`,
        ],
        userDecides: [
          "manualApproval and visualReview (reviewer, time, evidence): the user's, never written by an agent",
        ],
        optional: [
          `Each variant in the request needs its own render: "captioned" is out/${projectId}/<format>.mp4 (rendered above); "clean" also needs ${renderArgs(primary)} --captions off. Request only "captioned" unless the user wants a clean copy.`,
          `"mode": "draft" in the request checks everything without a production-ready package.`,
        ],
      },
      "verdict",
    );
  }

  return answer(
    "done",
    {
      action: "stop",
      why: `Delivered: ${shown(report.file)} is production-ready and newer than every render. Quality is the user's judgement.`,
      commands: [],
    },
    "delivery",
  );
}
