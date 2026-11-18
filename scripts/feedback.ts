/**
 * The user's feedback on what they watched, as a structured step input, on any route that has steps to reopen:
 * a bespoke film, the user's own recording (footage:next) and a campaign. Without --confirm it only previews where each
 * item goes and what reopens. With --confirm it writes pipeline/feedback/fb-NNN.json and reopens through the route's
 * own mechanism: a film step's open file (receipts), a footage step's open file (footage:next returns it until its
 * output moves), or a campaign variant's fix draft (campaign:next's review-repair). `pnpm next` goes on.
 * --step with --answer asks for changes at a film step in the user's words: one item bound to the step's artefact,
 * routed to its revise owner (src/lib/feedback/step.ts; RFC 0004 §8).
 * --frame with --answer pins the user's words to one frame of a film's render, optionally to an area of it (--region
 * x,y,w,h, normalised): one item with the frame, its time and the region, routed by aspect (a shot: build), so the
 * next build or fixer brief shows exactly where (src/lib/feedback/frame.ts; RFC 0004 §8).
 * --step with --clarify records the user's answer when the same objection came back to a step; on a recording,
 * --step with --unchanged-because settles the step's items as declined.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { requireUserWords } from "../src/lib/cli/user-words";
import { openExistingFilm, refusals } from "../src/lib/film/cli";
import { clarifyFeedback, planFeedback, writeFeedback } from "../src/lib/feedback/apply";
import { CampaignFeedbackRefusal, planCampaignFeedback, writeCampaignFeedback } from "../src/lib/feedback/campaign";
import {
  declineFootageFeedback,
  FOOTAGE_TARGETS,
  FootageFeedbackRefusal,
  planFootageFeedback,
  writeFootageFeedback,
} from "../src/lib/feedback/footage";
import { readFootageState } from "../src/lib/footage/next";
import { guardEvent } from "../src/lib/film/guard-cli";
import { ChainRefusal } from "../src/lib/film/state";
import { planStepFeedback } from "../src/lib/feedback/step";
import { parseRegion, planFrameFeedback } from "../src/lib/feedback/frame";
import { ASPECTS, type Aspect } from "../src/types/feedback";
import { detectRoute } from "../src/lib/pipeline/route";

const refused = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    if (
      error instanceof FootageFeedbackRefusal ||
      error instanceof CampaignFeedbackRefusal ||
      error instanceof ChainRefusal
    )
      throw new CliErrorObject({ code: "INVALID_INPUT", message: error.message });
    throw error;
  }
};

void runScript(async () => {
  const args = parseArgs([
    {
      name: "project",
      required: true,
      description: "Project ID: a bespoke film, a recording (or its recut) or a campaign",
    },
    {
      name: "file",
      description:
        "JSON: {verdict, watched?, items: [{quote, aspect, severity?, at?, shotId?, memberId?, materialId?}]}, quotes in the user's own words",
    },
    {
      name: "confirm",
      type: "boolean",
      description: "Write the feedback after the user said yes to the preview; without it nothing is written",
    },
    { name: "step", description: "With --clarify or --unchanged-because: the step the feedback is open on" },
    { name: "clarify", description: "With --step: the user's own words saying exactly what they want there" },
    {
      name: "answer",
      description:
        "A film, with --step: the user's own words asking for changes at that step (or one more critic round); routed to the step's revise owner",
    },
    {
      name: "aspect",
      choices: ASPECTS,
      description: "With --step --answer: what the words are about (default: the step's); with --frame, default shot",
    },
    {
      name: "expect",
      description:
        "With --step --answer: the hash of the step's artefacts the user saw; with --frame: the SHA-256 of the render they watched. Refused when it changed",
    },
    {
      name: "frame",
      type: "number",
      description: "A film, with --answer: the frame of the render the user points at (from 0)",
    },
    {
      name: "region",
      description: "With --frame: the area of the frame, x,y,w,h from 0 to 1 (top-left origin)",
    },
    {
      name: "watched",
      description: "With --frame: the render the user watched, relative to the checkout [default: out/<id>/film.mp4]",
    },
    {
      name: "fps",
      type: "number",
      description:
        "With --frame: the frame rate the frame number counts in [default: the render's (ffprobe), else the film plan's; refused when neither is known]",
    },
    {
      name: "unchanged-because",
      description: "A recording, with --step: why the step stays as it is; its open items become declined",
    },
  ] as const);
  validateProjectId(args.project!);
  const projectDir = path.resolve("public/projects", args.project!);
  if (!existsSync(projectDir))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `No project ${args.project}.` });
  const route = detectRoute(projectDir).route;
  if (route !== "film" && route !== "footage" && route !== "campaign")
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Feedback reopens the steps of a film, a recording or a campaign; ${args.project} is on the ${route ?? "unknown"} route. Re-render or edit it directly.`,
    });
  const rootDir = process.cwd();

  const confirmHint =
    "Show the user this preview in plain words. On their yes, run again with --confirm; nothing is written until then.";
  const previewOf = (plan: {
    record: {
      id: string;
      verdict: string;
      watched: unknown;
      items: {
        id: string;
        aspect: string;
        severity: string;
        routedTo: string;
        quote: string;
        memberId?: string;
        materialId?: string;
      }[];
    };
    reopens: { step: string; owner: string; because: string }[];
    ask: unknown[];
    warnings: string[];
  }) => ({
    feedbackId: plan.record.id,
    verdict: plan.record.verdict,
    watched: plan.record.watched,
    items: plan.record.items.map((item) => ({
      id: item.id,
      aspect: item.aspect,
      severity: item.severity,
      routedTo: item.routedTo,
      ...(item.memberId ? { memberId: item.memberId } : {}),
      ...(item.materialId ? { materialId: item.materialId } : {}),
      quote: item.quote,
    })),
    reopens: plan.reopens,
    owners: [...new Set(plan.reopens.map((reopen) => reopen.owner))],
    ...(plan.ask.length ? { ask: plan.ask } : {}),
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
  });

  if (args.frame !== undefined || args.region !== undefined || args.watched !== undefined || args.fps !== undefined) {
    if (args.frame === undefined || args.answer === undefined)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message:
          "--frame goes with --answer (the user's words about that frame); --region, --watched and --fps with --frame.",
      });
    if (args.step !== undefined || args.clarify !== undefined || args["unchanged-because"] !== undefined || args.file)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--frame is its own feedback: not with --step, --clarify, --unchanged-because or --file.",
      });
    if (route !== "film")
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--frame pins words to a film's render; on this route give the items with --file.",
      });
    const words = requireUserWords(args.answer, "--answer");
    if (!Number.isInteger(args.frame) || args.frame < 0)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--frame is a frame number from 0 (got ${args.frame}).`,
      });
    if (args.fps !== undefined && !(args.fps > 0 && args.fps <= 240))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `--fps ${args.fps} is not a frame rate.` });
    if (args.expect !== undefined && !/^[a-f0-9]{64}$/.test(args.expect))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--expect with --frame is the lowercase hex SHA-256 of the render the user watched.",
      });
    let region: ReturnType<typeof parseRegion> | undefined;
    try {
      region = args.region === undefined ? undefined : parseRegion(args.region);
    } catch (error) {
      throw new CliErrorObject({ code: "INVALID_INPUT", message: (error as Error).message });
    }
    const project = openExistingFilm(args.project!);
    const plan = refusals(() =>
      planFrameFeedback(project, {
        frame: args.frame!,
        words,
        ...(region ? { region } : {}),
        ...(args.watched ? { watched: args.watched } : {}),
        ...(args.expect ? { expect: args.expect } : {}),
        ...(args.fps !== undefined ? { fps: args.fps } : {}),
        ...(args.aspect ? { aspect: args.aspect as Aspect } : {}),
      }),
    );
    const item = plan.record.items[0]!;
    const preview = {
      projectId: project.id,
      route,
      frame: item.frame,
      ...(item.region ? { region: item.region } : {}),
      timing: plan.timing,
      ...previewOf(plan),
    };
    if (!args.confirm) return { metadata: { ...preview, confirmed: false, confirm: confirmHint } };
    const outputs = writeFeedback(project, plan);
    for (const open of plan.opens) guardEvent(project, "reentry", open.step, `feedback ${plan.record.id}`);
    return {
      outputs,
      metadata: {
        ...preview,
        confirmed: true,
        next: `pnpm next --project ${project.id}`,
        ...(plan.capture ? { capture: plan.capture } : {}),
      },
    };
  }
  if (
    args.clarify !== undefined ||
    args.step !== undefined ||
    args["unchanged-because"] !== undefined ||
    args.answer !== undefined
  ) {
    const modes = [args.clarify, args["unchanged-because"], args.answer].filter((value) => value !== undefined);
    if (!args.step || modes.length !== 1)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message:
          "--step goes with exactly one of --clarify (the user's words), --answer (the user's words asking for changes) or --unchanged-because.",
      });
    if (args.answer !== undefined) {
      if (route !== "film")
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "--step --answer asks for changes at a film step; on this route give the items with --file.",
        });
      const words = requireUserWords(args.answer, "--answer");
      const project = openExistingFilm(args.project!);
      const plan = refusals(() =>
        planStepFeedback(project, args.step!, words, {
          ...(args.aspect ? { aspect: args.aspect as Aspect } : {}),
          ...(args.expect ? { expect: args.expect } : {}),
        }),
      );
      const preview = { projectId: project.id, route, step: args.step, target: plan.target, ...previewOf(plan) };
      if (!args.confirm) return { metadata: { ...preview, confirmed: false, confirm: confirmHint } };
      const outputs = writeFeedback(project, plan);
      for (const open of plan.opens) guardEvent(project, "reentry", open.step, `feedback ${plan.record.id}`);
      return {
        outputs,
        metadata: {
          ...preview,
          confirmed: true,
          next: `pnpm next --project ${project.id}`,
          ...(plan.capture ? { capture: plan.capture } : {}),
        },
      };
    }
    if (route === "campaign")
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "A campaign's feedback is a review draft: campaign:next carries it; there is no step to clarify.",
      });
    if (args["unchanged-because"] !== undefined) {
      if (route !== "footage")
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "On a film, the step's owner declines with film:done --unchanged-because.",
        });
      if (!args["unchanged-because"].trim())
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "--unchanged-because needs the reason." });
      const state = readFootageState(args.project!, { rootDir, save: false });
      const settled = refused(() => declineFootageFeedback(state, args.step!, args["unchanged-because"]!.trim()));
      return {
        metadata: {
          projectId: state.projectId,
          step: args.step,
          settled,
          next: `pnpm footage:next --project ${state.projectId}`,
        },
      };
    }
    const quote = requireUserWords(args.clarify, "--clarify");
    if (route === "footage") {
      if (!(FOOTAGE_TARGETS as readonly string[]).includes(args.step))
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `--step is one of ${FOOTAGE_TARGETS.join(", ")} on a recording.`,
        });
      const state = readFootageState(args.project!, { rootDir, save: false });
      const source = path.join(rootDir, "public/projects", state.projectId);
      const file = refused(() =>
        clarifyFeedback({ projectDir: source, rootDir }, args.step!, quote, undefined, { spine: false }),
      );
      return {
        outputs: [file],
        metadata: {
          projectId: state.projectId,
          step: args.step,
          clarified: true,
          next: `pnpm next --project ${state.projectId}`,
        },
      };
    }
    const project = openExistingFilm(args.project!);
    const file = refusals(() => clarifyFeedback(project, args.step!, quote));
    return {
      outputs: [file],
      metadata: { projectId: project.id, step: args.step, clarified: true, next: `pnpm next --project ${project.id}` },
    };
  }
  if (!args.file)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--file names the JSON with the user's feedback items.",
    });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.resolve(args.file), "utf8"));
  } catch (error) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${args.file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  // The quotes are the user's words: a placeholder or an agent's narration is refused before any route reads them.
  const items = (raw as { items?: unknown } | null)?.items;
  if (Array.isArray(items))
    items.forEach((item, index) => {
      const quote = (item as { quote?: unknown } | null)?.quote;
      if (typeof quote === "string") requireUserWords(quote, `items.${index}.quote`);
    });
  if (route === "footage") {
    const state = readFootageState(args.project!, { rootDir, save: false });
    const plan = refused(() => planFootageFeedback(state, raw, args.project!));
    const preview = { projectId: state.projectId, route, ...previewOf(plan) };
    if (!args.confirm) return { metadata: { ...preview, confirmed: false, confirm: confirmHint } };
    const outputs = writeFootageFeedback(rootDir, plan);
    return {
      outputs,
      metadata: { ...preview, confirmed: true, next: `pnpm footage:next --project ${state.projectId}` },
    };
  }
  if (route === "campaign") {
    const plan = refused(() => planCampaignFeedback(rootDir, args.project!, raw));
    const preview = { projectId: args.project, route, ...previewOf(plan) };
    if (!args.confirm) return { metadata: { ...preview, confirmed: false, confirm: confirmHint } };
    const outputs = refused(() => writeCampaignFeedback(rootDir, args.project!, plan));
    return { outputs, metadata: { ...preview, confirmed: true, next: `pnpm campaign:next --project ${args.project}` } };
  }

  const project = openExistingFilm(args.project!);
  const plan = refusals(() => planFeedback(project, raw));
  const preview = { projectId: project.id, route, ...previewOf(plan) };
  if (!args.confirm) return { metadata: { ...preview, confirmed: false, confirm: confirmHint } };
  const outputs = writeFeedback(project, plan);
  for (const open of plan.opens) guardEvent(project, "reentry", open.step, `feedback ${plan.record.id}`);
  return {
    outputs,
    metadata: {
      ...preview,
      confirmed: true,
      next: `pnpm next --project ${project.id}`,
      ...(plan.capture ? { capture: plan.capture } : {}),
    },
  };
});
