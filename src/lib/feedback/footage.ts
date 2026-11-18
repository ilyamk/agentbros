/**
 * `pnpm feedback` on the user's own recording (footage:next). Each aspect goes to the footage step that owns it (a code
 * table): the cut to the recut plan, captions to the caption step, shorts to the shorts step, the crop to the reframe
 * step, sound to the timeline's audio levels. Footage has no receipts: state is derived from files, so an open item
 * keeps a baseline (the plan's edit hash, the recut's timeline revision, the shorts files) and footage:next returns the
 * step until that baseline moves, through the route's own commands: a new plan (new edit hash, so a new approval and a
 * new recut project), a timeline:edit (renders go stale by their receipts), a new candidates file and shorts request.
 * Records and open files live in the source project's pipeline/feedback/, like a film's.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  FeedbackInputSchema,
  FeedbackSchema,
  OpenFeedbackSchema,
  type Aspect,
  type Feedback,
  type OpenFeedback,
} from "../../types/feedback";
import type { FootageFormat } from "../../types/footage-goals";
import type { FootageNext, FootageState } from "../footage/next";
import {
  feedbackFile,
  nextFeedbackId,
  openFeedbackFile,
  readOpenFeedback,
  repeatedAspects,
  settleOpenFeedback,
  writeJson,
} from "./store";
import { userWordsProblem } from "../cli/user-words";

export class FootageFeedbackRefusal extends Error {}

export const FOOTAGE_TARGETS = ["recut-plan", "reframe", "captions", "mix", "shorts"] as const;
export type FootageTarget = (typeof FOOTAGE_TARGETS)[number];

/** The footage:next step each target answers as (src/lib/footage/next.ts STEP), and its title. */
export const FOOTAGE_TARGET_STEP: Record<FootageTarget, [string, string]> = {
  "recut-plan": ["3-recut-plan", "Recut plan"],
  captions: ["5-captions", "Caption style"],
  shorts: ["6-shorts", "Shorts"],
  reframe: ["8-reframe", "Reframe"],
  mix: ["8-mix", "Audio levels"],
};

const CUT = "recut-plan";
const NOT_THE_RECORDING =
  "the recording is the user's own: the footage route cuts, captions, crops and levels it, but does not change its idea, audience, claims or material. Ask what they want changed in the edit";

/** Aspect → footage target, or why the user is asked. */
export const FOOTAGE_ASPECT_ROUTES: Record<Aspect, { footage?: FootageTarget; askWhy?: string }> = {
  cuts: { footage: CUT },
  pacing: { footage: CUT },
  length: { footage: CUT },
  words: { footage: CUT },
  "hook-line": { footage: CUT },
  "opening-picture": { footage: CUT },
  "ending-cta": { footage: CUT },
  captions: { footage: "captions" },
  shorts: { footage: "shorts" },
  framing: { footage: "reframe" },
  music: { footage: "mix" },
  "sfx-mix": { footage: "mix" },
  voice: { footage: "mix" },
  shot: {
    askWhy: "a shot of a recording is either cut (cuts) or cropped (framing): ask the user which they mean",
  },
  look: { askWhy: "the footage route has no colour step: ask the user what should change in the picture" },
  concept: { askWhy: NOT_THE_RECORDING },
  audience: { askWhy: NOT_THE_RECORDING },
  claim: { askWhy: NOT_THE_RECORDING },
  material: { askWhy: NOT_THE_RECORDING },
  unclear: {
    askWhy: "the user's words do not say what should change: ask them which part of the edit they mean",
  },
};

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const shaOf = (rootDir: string, file: string | null | undefined) => {
  if (!file) return "";
  const full = path.resolve(rootDir, file);
  return existsSync(full) ? sha(full) : "";
};
const hashText = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const projectDirOf = (state: FootageState) => path.join(state.rootDir, "public/projects", state.projectId);

const ownFormat = (state: FootageState): FootageFormat => {
  const width = state.source?.width ?? null;
  const height = state.source?.height ?? null;
  return !width || !height || width > height ? "landscape" : width === height ? "square" : "vertical";
};

function wanted(state: FootageState): FootageFormat[] {
  const goals = state.goals;
  if (!goals) return [];
  const own = ownFormat(state);
  return [
    ...new Set(
      goals.formats ?? [own, ...(goals.goals.includes("vertical") && own !== "vertical" ? ["vertical" as const] : [])],
    ),
  ];
}

/** The footage target an aspect goes to for this recording's goals, or ask with the reason. */
export function routeFootageAspect(
  aspect: Aspect,
  state: FootageState,
): { step: FootageTarget } | { step: "ask"; why: string } {
  const route = FOOTAGE_ASPECT_ROUTES[aspect];
  if (!route.footage) return { step: "ask", why: route.askWhy! };
  const goals = state.goals?.goals ?? [];
  if (route.footage === "captions" && !goals.includes("captions"))
    return {
      step: "ask",
      why: "captions are not among the goals: ask whether to add them (footage:next --goal with captions)",
    };
  if (route.footage === "shorts" && !goals.includes("shorts"))
    return { step: "ask", why: "shorts are not among the goals: ask whether to add them (footage:next --goal)" };
  if (route.footage === "reframe" && !wanted(state).some((format) => format !== ownFormat(state)))
    return {
      step: "ask",
      why: "no format here is cropped from the recording: ask whether they want a vertical or square version (footage:next --formats)",
    };
  if (route.footage === "recut-plan" && !state.request)
    return { step: "ask", why: "this recording has no recut plan to change yet" };
  if (route.footage !== "recut-plan" && !state.recut)
    return { step: "ask", why: "no recut project exists yet: the change belongs to the plan first" };
  return { step: route.footage };
}

/** What the target's output is now: footage:next settles its open items once this moves. */
export function footageBaseline(state: FootageState, target: FootageTarget): { recutId: string | null; value: string } {
  const recut = state.recut;
  const recutId = recut?.projectId ?? null;
  const revision = `${recutId}@${recut?.revision ?? 0}`;
  switch (target) {
    case "recut-plan":
      return { recutId, value: `${state.request?.file ?? ""}#${state.request?.planHash ?? ""}` };
    case "captions": {
      const goals = state.goals;
      return {
        recutId,
        value: hashText([revision, goals?.captionStyle, goals?.placement, goals?.platform, state.request?.planHash]),
      };
    }
    case "shorts": {
      const series = state.series ? shaOf(state.rootDir, state.series.file) : "";
      return {
        recutId,
        value: series ? `series:${series}` : `candidates:${shaOf(state.rootDir, state.shorts?.candidates)}`,
      };
    }
    default:
      return { recutId, value: revision };
  }
}

// --- Planning and writing ---

export type FootageFeedbackPlan = {
  projectDir: string;
  record: Feedback;
  opens: OpenFeedback[];
  reopens: { step: string; owner: string; because: string }[];
  ask: { itemId: string; aspect: Aspect; quote: string; why: string }[];
  warnings: string[];
  /** Targets whose earlier open items were already answered (their output moved): settled before the new file. */
  settle: FootageTarget[];
};

/** The renders of the recut (or of the shorts episode asked about): what the user can have watched. */
function watchedCandidates(state: FootageState, requested: string): string[] {
  const ids = [
    ...(state.redirectedFrom && state.redirectedFrom.projectId === requested ? [requested] : []),
    ...(state.recut ? [state.recut.projectId] : []),
  ];
  const id = ids[0];
  if (!id) return [];
  const dir = path.join(state.rootDir, "out", id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".mp4") && existsSync(path.join(dir, `${name}.receipt.json`)))
    .sort()
    .map((name) => path.join("out", id, name));
}

/** Validates and routes feedback on a recording's render; writes nothing. `requested` is the id the user named. */
export function planFootageFeedback(
  state: FootageState,
  raw: unknown,
  requested: string = state.projectId,
  at: string = new Date().toISOString(),
): FootageFeedbackPlan {
  if (raw && typeof raw === "object" && (raw as { source?: { kind?: unknown } }).source?.kind !== undefined)
    if ((raw as { source: { kind?: unknown } }).source.kind !== "user")
      throw new FootageFeedbackRefusal("Feedback is the user's own words: a proxy, critic or agent source is refused.");
  const parsed = FeedbackInputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FootageFeedbackRefusal(
      `The feedback file is not valid: ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}. Every item needs the user's words verbatim in "quote" and an "aspect".`,
    );
  }
  const input = parsed.data;
  for (const [index, item] of input.items.entries()) {
    const problem = userWordsProblem(item.quote);
    if (problem) throw new FootageFeedbackRefusal(`items.${index}.quote is not the user's words: ${problem}.`);
  }
  if (!state.goals)
    throw new FootageFeedbackRefusal(`${state.projectId} has no footage goals yet: nothing was edited.`);
  const candidates = watchedCandidates(state, requested);
  const watchedPath = input.watched?.path ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!watchedPath)
    throw new FootageFeedbackRefusal(
      candidates.length
        ? `Several renders exist (${candidates.join(", ")}): name the one the user watched in "watched": {"path": ...}.`
        : "No render of this recording exists: feedback is bound to the exact file the user watched.",
    );
  const watchedFile = path.resolve(state.rootDir, watchedPath);
  if (!existsSync(watchedFile) || !statSync(watchedFile).isFile())
    throw new FootageFeedbackRefusal(
      `${watchedPath} does not exist: feedback is bound to the exact file the user watched.`,
    );
  const watchedSha = sha(watchedFile);
  if (input.watched?.sha256 && input.watched.sha256 !== watchedSha)
    throw new FootageFeedbackRefusal(
      `${watchedPath} changed since the user watched it (sha256 ${input.watched.sha256.slice(0, 12)}…, now ${watchedSha.slice(0, 12)}…): show them the current render first.`,
    );

  const projectDir = projectDirOf(state);
  const ask: FootageFeedbackPlan["ask"] = [];
  const items = input.items.map((item, index) => {
    const id = `i${index + 1}`;
    const routed = routeFootageAspect(item.aspect, state);
    if (routed.step === "ask") ask.push({ itemId: id, aspect: item.aspect, quote: item.quote.trim(), why: routed.why });
    return {
      id,
      quote: item.quote.trim(),
      aspect: item.aspect,
      ...(item.at ? { at: item.at } : {}),
      ...(item.shotId ? { shotId: item.shotId } : {}),
      severity: item.severity,
      routedTo: routed.step,
      status: "open" as const,
    };
  });
  const record = FeedbackSchema.parse({
    schemaVersion: 1,
    id: nextFeedbackId(projectDir),
    route: "footage",
    watched: { path: path.relative(state.rootDir, watchedFile), sha256: watchedSha },
    source: { kind: "user", at },
    verdict: input.verdict,
    items,
  });
  const opens: OpenFeedback[] = [];
  const warnings: string[] = [];
  const settle: FootageTarget[] = [];
  if (record.verdict === "revise") {
    const targets = FOOTAGE_TARGETS.filter((target) => items.some((item) => item.routedTo === target));
    for (const target of targets) {
      const now = footageBaseline(state, target);
      let existing = readOpenFeedback(projectDir, target);
      // Earlier items on the same recut whose output already moved were answered: settle them, start from now.
      if (existing?.baseline && existing.baseline.recutId === now.recutId && existing.baseline.value !== now.value) {
        settle.push(target);
        existing = undefined;
      }
      opens.push(
        OpenFeedbackSchema.parse({
          schemaVersion: 1,
          step: target,
          items: [
            ...(existing?.items ?? []),
            ...items
              .filter((item) => item.routedTo === target)
              .map((item) => ({
                feedbackId: record.id,
                itemId: item.id,
                quote: item.quote,
                aspect: item.aspect,
                severity: item.severity,
                ...(item.at ? { at: item.at } : {}),
                ...(item.shotId ? { shotId: item.shotId } : {}),
                watched: record.watched.path,
              })),
          ],
          clarifications: existing?.clarifications ?? [],
          baseline: now,
        }),
      );
    }
    if (opens.some((open) => open.step === CUT))
      warnings.push(
        "The recut plan reopens: a new plan has a new edit hash, so the user approves it again and it becomes a new recut project; the current recut and its renders stay as they are.",
      );
  } else warnings.push("The verdict is accept: the items are recorded and nothing reopens.");
  const reopens = opens.map((open) => ({
    step: FOOTAGE_TARGET_STEP[open.step as FootageTarget][0],
    owner: "footage-editor",
    because: "the user's feedback",
  }));
  if (opens.some((open) => open.step !== "shorts") && state.recut)
    reopens.push({
      step: "9-render",
      owner: "footage-editor",
      because: "the timeline changes, so its renders go stale",
    });
  return { projectDir, record, opens, reopens, ask, warnings, settle };
}

/** Writes the record and each target's open file. Returns repository-relative paths. */
export function writeFootageFeedback(rootDir: string, plan: FootageFeedbackPlan): string[] {
  for (const target of plan.settle) settleOpenFeedback(plan.projectDir, target);
  const written = [feedbackFile(plan.projectDir, plan.record.id)];
  writeJson(written[0]!, plan.record);
  for (const open of plan.opens) {
    const file = openFeedbackFile(plan.projectDir, open.step);
    writeJson(file, open);
    written.push(file);
  }
  return written.map((file) => path.relative(rootDir, file));
}

// --- footage:next ---

type Shown = Omit<FootageNext, "state" | "read" | "playbook" | "playbookHint">;

const quoteLines = (open: OpenFeedback) => [
  ...open.items.map(
    (item) =>
      `- ${item.feedbackId} ${item.itemId} (${item.aspect}, ${item.severity}${item.at ? `, ${item.at.fromSec}-${item.at.toSec}s` : ""}): "${item.quote}"`,
  ),
  ...open.clarifications.map((clarification) => `- clarified: "${clarification.quote}"`),
];

/**
 * The open footage feedback to answer first, as a footage:next answer; undefined when none is open. Items whose step
 * output moved since the feedback are settled; a newer recut re-anchors the other steps' baselines, as their change now
 * applies to it. This bookkeeping is written on every read, `pnpm next` included: otherwise a settled step would return.
 */
export function footageFeedbackNext(state: FootageState): Shown | undefined {
  if (!state.projectExists) return undefined;
  const projectDir = projectDirOf(state);
  for (const target of FOOTAGE_TARGETS) {
    const open = readOpenFeedback(projectDir, target);
    if (!open) continue;
    const now = footageBaseline(state, target);
    const base = open.baseline;
    if (target !== CUT && base && base.recutId !== now.recutId) {
      if (!state.recut) continue;
      writeJson(openFeedbackFile(projectDir, target), OpenFeedbackSchema.parse({ ...open, baseline: now }));
      return answerFor(state, target, open);
    }
    if (base && base.value !== now.value) {
      settleOpenFeedback(projectDir, target);
      continue;
    }
    if (target !== CUT && !state.recut) continue;
    if (target === CUT && !state.request) continue;
    const repeats = repeatedAspects(projectDir, target);
    if (repeats.length) {
      const [id, title] = FOOTAGE_TARGET_STEP[target];
      return {
        step: id,
        title,
        action: "ask",
        why: `The user raised ${repeats.map((repeat) => repeat.aspect).join(", ")} for ${title.toLowerCase()} before, and it was answered: another try would guess again.`,
        question: `This is the second time you raise this for ${title.toLowerCase()}. Say exactly what you want there: the cut, the caption, the crop.`,
        thenRun: [`pnpm feedback --project ${state.projectId} --step ${target} --clarify "<the user's words>"`],
        userDecides: ["What exactly should change"],
      };
    }
    return answerFor(state, target, open);
  }
  return undefined;
}

const line = (argv: string[]) => argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part}'`)).join(" ");

/** A command's argv, built as footage:next builds its own. */
const pnpm = (script: string, ...args: string[]): string[] => ["pnpm", script, ...args];

/** A `run` answer carries both forms, as footage:next's own: the shell line and the argv. */
const ran = (argv: string[]) => ({ commands: [line(argv)], argv: [argv] });

function answerFor(state: FootageState, target: FootageTarget, open: OpenFeedback): Shown {
  const [step, title] = FOOTAGE_TARGET_STEP[target];
  const quotes = quoteLines(open);
  const head = `The user's feedback reopens ${title.toLowerCase()}. Their words, verbatim; every change answers them:\n${quotes.join("\n")}`;
  const decline = `If nothing should change, say why to the user and record it: pnpm feedback --project ${state.projectId} --step ${target} --unchanged-because "<why>".`;
  const recut = state.recut;
  const next = line(pnpm("footage:next", "--project", state.projectId));
  if (target === CUT) {
    const request = state.request!;
    const dir = path.dirname(request.file);
    const transcript =
      state.transcripts.find((item) => item.valid && path.dirname(item.file) === dir) ??
      state.transcripts.find((item) => item.valid);
    const mask = state.speechMasks.find((item) => path.dirname(item) === dir) ?? state.speechMasks[0];
    const goals = state.goals!;
    let fresh = `${recut?.projectId ?? request.projectId}`.replace(/-v\d+$/, "");
    for (let n = 2; state.takenProjectIds.includes(fresh) || fresh === request.projectId; n++)
      fresh = `${(recut?.projectId ?? request.projectId).replace(/-v\d+$/, "")}-v${n}`;
    const argv = pnpm(
      "recut:plan",
      "--transcript",
      transcript?.file ?? "<transcript.json>",
      "--project-id",
      fresh,
      ...(mask ? ["--speech-mask", mask] : []),
      "--formats",
      wanted(state).join(","),
      ...(goals.goals.includes("recut") ? [] : ["--no-fillers", "--no-retakes", "--long-pause-ms", "60000"]),
      ...(goals.midPauseMs !== undefined ? ["--mid-pause-ms", String(goals.midPauseMs)] : []),
      ...(goals.sentencePauseMs !== undefined ? ["--sentence-pause-ms", String(goals.sentencePauseMs)] : []),
      ...(goals.punchIn !== undefined ? ["--punch-in", String(goals.punchIn)] : []),
      "--reject",
      "<cut ids to leave out, with earlier rejections>",
      "--force",
    );
    return {
      step,
      title,
      action: "agent-task",
      why: `${head}\nThe cut lives in the plan, so the plan is made again under a new project id (${fresh}); the user approves its new edit hash and it becomes a new recut. The current recut stays.`,
      task: [
        `Read ${request.planFile ?? request.file} against the quotes. Leave out (--reject) the cuts the user wants kept in the edit, keeping earlier rejections; for pace, record the goal first (footage:next --mid-pause-ms / --sentence-pause-ms) and drop --reject if nothing is rejected.`,
        `Then run: ${line(argv)}`,
        `Then ${next}: it asks the user to approve the new plan.`,
        decline,
      ].join("\n"),
      show: [request.planFile ?? request.file],
    };
  }
  const edit = (command: string, ...flags: string[]) =>
    line(
      pnpm(
        "timeline:edit",
        "--project",
        recut!.projectId,
        "--revision",
        String(recut!.revision),
        command.startsWith("{") ? "--command" : "--command-file",
        command,
        ...flags,
      ),
    );
  if (target === "captions")
    return {
      step,
      title,
      action: "agent-task",
      why: head,
      task: [
        "Decide from the quotes which part of the captions they mean, and change only that:",
        `- the style: ${line(pnpm("footage:next", "--project", state.projectId, "--caption-style", "<style>"))} (footage:next then applies it)`,
        `- the placement: ${line(pnpm("footage:next", "--project", state.projectId, "--placement", "<organic|ad>"))}, or an explicit position in the caption style options with ${edit('{"type":"caption-style","style":{...}}', "--dry-run")} then without --dry-run`,
        "- a word written wrong: fix that word's text in the transcript (keep its times); the transcript is part of the edit hash, so the plan is made again and approved again",
        decline,
      ].join("\n"),
    };
  if (target === "mix")
    return {
      step,
      title,
      action: "agent-task",
      why: head,
      task: [
        `Set the level of the clips the quotes name in public/projects/${recut!.projectId}/pipeline/timeline-edit.json: ${edit('{"type":"audio-gain","trackId":"<track>","clipId":"<clip>","gain":<0..1>}', "--dry-run")}, then the same without --dry-run. The renders go stale and footage:next renders again.`,
        "You cannot hear the result: the user judges it.",
        decline,
      ].join("\n"),
    };
  if (target === "reframe") {
    const src = state.source!.file;
    const work = state.workDir;
    const formats = wanted(state).filter((format) => format !== ownFormat(state));
    const editFile = `public/projects/${recut!.projectId}/pipeline/recording-edit.json`;
    const timelineFile = `public/projects/${recut!.projectId}/pipeline/timeline-edit.json`;
    const transcript = state.transcripts.find((item) => item.valid);
    const multi = Boolean(state.speakerMap && transcript?.diarized && transcript.speakers.length >= 2);
    const run = formats.map((format) =>
      line(
        pnpm(
          "reframe:track",
          "--input",
          src,
          "--format",
          format,
          "--output",
          `${work}/crop-path-${format}.json`,
          ...(state.shots ? ["--shots", state.shots] : []),
          ...(multi ? ["--transcript", transcript!.file, "--map", state.speakerMap!] : []),
          "--recording-edit",
          editFile,
          "--timeline",
          timelineFile,
          "--track-id",
          recut!.pictureTrackId,
          "--clip-id",
          "all",
          "--command-output",
          `${work}/reframe-${format}-edit.json`,
        ),
      ),
    );
    return {
      step,
      title,
      action: "agent-task",
      why: head,
      task: [
        `Track the crop again for ${formats.join(", ")} with settings that answer the quotes (--deadzone, --smoothing, --min-move, or a corrected speaker map), look at stills of the result, then apply each command file:`,
        ...run,
        ...formats.map(
          (format) =>
            `${edit(`${work}/reframe-${format}-edit.json`, "--dry-run")} then the same without --dry-run (the revision moves after each apply)`,
        ),
        decline,
      ].join("\n"),
    };
  }
  // shorts
  const shortsDir = state.shorts?.dir ?? `${state.workDir}/shorts`;
  const seriesBound = Boolean(open.baseline?.value.startsWith("series:"));
  const proposals = state.shorts?.proposals;
  const revised = seriesBound && candidatesRevised(state, open);
  if (revised && proposals?.fresh && proposals.projectId === recut?.projectId)
    return {
      step,
      title,
      action: "ask",
      why: `${head}\nThe candidates are revised and ranked; the shorts wait for the user's own approval again.`,
      show: [proposals.file.replace(/\.json$/, ".md")],
      question: `Watch each proposed range (${proposals.proposed.join(", ") || "none above the threshold"}). Which clips (at least two) do you approve now?`,
      thenRun: [
        line(
          pnpm(
            "shorts:request",
            "--project",
            recut!.projectId,
            "--selections",
            proposals.file,
            "--ids",
            "<ids the user approved>",
            "--approved-by",
            "<the user's own words>",
            "--series-id",
            `${recut!.projectId}-shorts-${open.items[0]!.feedbackId}`,
          ),
        ),
        next,
      ],
      userDecides: ["Which shorts to approve (in the user's own words)"],
    };
  if (revised && state.shorts?.candidates)
    return {
      step,
      title,
      action: "run",
      why: `${head}\ncandidates.json is revised: rank it against the recut again.`,
      ...ran(
        pnpm(
          "shorts:rank",
          "--prepared",
          shortsDir,
          "--candidates",
          state.shorts.candidates,
          "--project",
          recut!.projectId,
          ...(state.speechMasks[0] ? ["--speech-mask", state.speechMasks[0]] : []),
        ),
      ),
    };
  return {
    step,
    title,
    action: "agent-task",
    why: head,
    task: [
      `Revise ${shortsDir}/candidates.json so the clips answer the quotes (whole sentences, the six axes with verbatim evidence, as ${shortsDir}/brief.md says). Then ${next}: it ranks them again${seriesBound ? " and asks the user to approve the clips again" : ""}.`,
      decline,
    ].join("\n"),
    show: [`${shortsDir}/brief.md`],
  };
}

/** With a series already made: whether candidates.json was revised after the feedback was written. */
function candidatesRevised(state: FootageState, open: OpenFeedback): boolean {
  const candidates = state.shorts?.candidates;
  if (!candidates) return false;
  const openFile = openFeedbackFile(projectDirOf(state), open.step);
  const file = path.resolve(state.rootDir, candidates);
  return existsSync(openFile) && existsSync(file) && statSync(file).mtimeMs > statSync(openFile).mtimeMs;
}

/** The owner leaves the step as it is, with the reason: its items become declined. */
export function declineFootageFeedback(state: FootageState, target: string, because: string) {
  if (!(FOOTAGE_TARGETS as readonly string[]).includes(target))
    throw new FootageFeedbackRefusal(`--step is one of ${FOOTAGE_TARGETS.join(", ")} on a recording.`);
  const projectDir = projectDirOf(state);
  if (!readOpenFeedback(projectDir, target)) throw new FootageFeedbackRefusal(`Step ${target} has no open feedback.`);
  return settleOpenFeedback(projectDir, target, { declinedBecause: because });
}
