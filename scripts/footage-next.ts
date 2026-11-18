import { localSuggestions } from "../src/lib/local-capabilities/suggestions";
/** What to do next when editing a user's own recording: one action with ready commands. Reads only, except that goal flags are saved to pipeline/footage-goals.json and --playbook to pipeline/playbook.json (neither with --no-save), and the step lease to pipeline/session/lease.json (docs/step-lease.md). */
import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { footageNext, GOALS_FILE, resolveSourceProject, type GoalOverrides } from "../src/lib/footage/next";
import { playbookRouteOf } from "../src/lib/pipeline/route";
import { loadPlaybook } from "../src/lib/playbooks/project";
import { issueFootageLease } from "../src/lib/step-lease/issue";
import { consoleNextFields } from "../src/lib/console/next-block";
import { FootageGoalsObjectSchema } from "../src/types/footage-goals";

const list = (value: string | undefined) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Source project (a recut or a shorts episode resolves to it)" },
    { name: "goal", description: "Comma list: recut, captions, vertical, shorts, multicam" },
    {
      name: "formats",
      description:
        "Comma list of landscape, vertical, square (default: the source's aspect, plus vertical with the vertical goal)",
    },
    {
      name: "caption-style",
      description:
        "Caption profile: outline-pop, italic-shadow, keyword-colour, word-box, line-box, chunky-stack, editorial-mix, clean-sentence, single-punch, typewriter or karaoke (the older word-highlight, bold-upper, boxed-word and keyword-emphasis still work)",
    },
    { name: "language", description: "Spoken language code, e.g. en, ru" },
    { name: "source", description: "The recording to edit (repository-relative or absolute)" },
    { name: "cameras", description: "Comma list of other cameras of the same event (multicam)" },
    {
      name: "transcriber",
      choices: ["scribe", "local"] as const,
      description: "scribe (paid, verbatim fillers) or local (free); the paid step is still asked",
    },
    { name: "speakers", type: "number", description: "Number of speakers, for diarisation" },
    { name: "recut-id", description: "Project id for the recut (default <project>-recut, or the next free one)" },
    { name: "shorts-brief", description: "Who the shorts are for" },
    {
      name: "mid-pause-ms",
      type: "number",
      description: "Shortened pause inside a sentence (250–400), passed to every recut:plan it prints",
    },
    {
      name: "sentence-pause-ms",
      type: "number",
      description:
        "Shortened pause between sentences (250–400, not below --mid-pause-ms), passed to every recut:plan it prints",
    },
    {
      name: "punch-in",
      type: "number",
      description: "Scale alternate spans (1.0–1.2) to soften jump cuts, passed to every recut:plan it prints",
    },
    {
      name: "placement",
      choices: ["organic", "ad"] as const,
      description:
        "Paid ad or organic post: ad keeps captions clear of the ad interface (captions:place --placement ad)",
    },
    {
      name: "platform",
      choices: ["tiktok", "reels", "shorts"] as const,
      description: "With --placement ad: the one platform the ad runs on (default: all three)",
    },
    {
      name: "playbook",
      description:
        "Bind the source project to a footage playbook (pipeline/playbook.json); its goals are the default when --goal is absent and none are saved",
    },
    {
      name: "save",
      type: "boolean",
      default: true,
      description: "Save goal flags to pipeline/footage-goals.json (default); --no-save applies them to this call only",
    },
  ] as const);
  const overrides: GoalOverrides = {
    goals: list(args.goal) as GoalOverrides["goals"],
    formats: list(args.formats) as GoalOverrides["formats"],
    captionStyle: args["caption-style"] as GoalOverrides["captionStyle"],
    language: args.language,
    source: args.source,
    cameras: list(args.cameras),
    transcriber: args.transcriber as GoalOverrides["transcriber"],
    speakers: args.speakers,
    recutId: args["recut-id"],
    shortsBrief: args["shorts-brief"],
    midPauseMs: args["mid-pause-ms"],
    sentencePauseMs: args["sentence-pause-ms"],
    punchIn: args["punch-in"],
    placement: args.placement as GoalOverrides["placement"],
    platform: args.platform as GoalOverrides["platform"],
  };
  let playbookGoals: string[] | undefined;
  if (args.playbook !== undefined) {
    let playbook;
    try {
      playbook = loadPlaybook(args.playbook);
    } catch (error) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--playbook: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const footageRoute = playbookRouteOf(playbook, "footage");
    if (!footageRoute)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Playbook ${playbook.id} is a ${playbook.route.kind} route with no footage alternative. Start it with: ${playbook.route.start}`,
      });
    const source = resolveSourceProject(args.project!, process.cwd()).projectId;
    if (overrides.goals === undefined && !existsSync(path.join("public/projects", source, GOALS_FILE))) {
      overrides.goals = footageRoute.footageGoals;
      playbookGoals = footageRoute.footageGoals;
    }
  }
  const partial = FootageGoalsObjectSchema.partial().safeParse({
    version: 1,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  });
  if (!partial.success)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: partial.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    });
  let result;
  try {
    result = footageNext(args.project!, {
      overrides,
      save: args.save,
      ...(args.playbook ? { playbook: args.playbook } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError")
      throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    throw error;
  }
  const lease = issueFootageLease(process.cwd(), result, "footage:next");
  return {
    metadata: {
      projectId: result.state.project,
      ...result,
      ...lease,
      ...(await localSuggestions(args.project!, result)),
      ...(playbookGoals ? { goalsFrom: `playbook ${args.playbook}: ${playbookGoals.join(",")}` } : {}),
      ...(await consoleNextFields({
        rootDir: process.cwd(),
        project: typeof result.state.project === "string" ? result.state.project : args.project!,
      })),
    },
  };
});
