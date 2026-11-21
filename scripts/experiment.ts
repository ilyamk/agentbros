import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadCampaign } from "../src/lib/campaigns/production/store";
import { atomicJson, projectDirectory, scopedFile } from "../src/lib/campaigns/production/files";
import { parseArgs, runScript } from "../src/lib/cli";
import { readProjectPlaybook } from "../src/lib/playbooks/project";
import { CameraRequestSchema, proposeTutorialCamera } from "../src/lib/experiments/camera";
import { compareProjects, freezeComparison, recordComparisonOutcome } from "../src/lib/experiments/compare";
import { DEFAULT_TUTORIAL_KIT, TutorialKitSchema } from "../src/lib/experiments/kit-schema";
import {
  experimentError,
  experimentFile,
  readExperiments,
  selectExperiment,
  startExperiment,
} from "../src/lib/experiments/project";
import { EXPERIMENTS, THREE_SHOT_EXPERIMENT } from "../src/lib/experiments/registry";

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      description: "List or select experiments, propose a camera or compare projects",
      default: "list",
      choices: ["list", "enable", "disable", "camera", "freeze", "outcome", "compare"],
    },
    { name: "project", description: "Bound project ID" },
    { name: "id", description: "Exact experiment ID including its @version" },
    { name: "input", description: "Local JSON input for a kit, camera, comparison inputs or outcome" },
    { name: "baseline", description: "Ordinary comparison project" },
    { name: "candidate", description: "Experimental comparison project" },
  ] as const);
  const root = process.cwd();
  if (args.action === "compare") {
    if (!args.baseline || !args.candidate) experimentError("Compare requires --baseline and --candidate");
    const result = compareProjects(root, args.baseline, args.candidate);
    return { outputs: [result.review, result.privateKey], metadata: result };
  }
  const directory = args.project ? projectDirectory(root, args.project) : undefined;
  if (directory && !existsSync(directory)) experimentError("Create the project before selecting an experiment");
  if (args.action === "list") {
    const playbook = directory ? readProjectPlaybook(directory)?.id : undefined;
    return {
      metadata: {
        experiments: EXPERIMENTS.filter(({ playbooks }) => !playbook || playbooks.some((id) => id === playbook)),
        active: directory ? readExperiments(directory) : [],
      },
    };
  }
  if (!directory || !args.project) experimentError("This action requires --project");
  const input = args.input ? readJson(scopedFile(root, args.input)) : undefined;
  const id = args.id;
  if (args.action === "enable" || args.action === "disable") {
    if (!id) experimentError("Select an exact experiment --id");
    const enabling = args.action === "enable";
    if (input && (!enabling || id !== "tutorial-series-kit@1"))
      experimentError("--input is only used to enable a series kit");
    if (id === "tutorial-series-kit@1" && enabling) {
      const plan = loadCampaign(root, args.project);
      const tutorials = plan.members.filter(
        ({ adapter }) => adapter.kind === "film" && adapter.playbook === "product-tutorial",
      );
      if (!tutorials.length) experimentError("The content-series campaign must include product-tutorial film members");
      if (
        !readExperiments(directory).some((item) => item.id === id) &&
        tutorials.some(({ projectId }) => existsSync(projectDirectory(root, projectId)))
      )
        experimentError("Enable the series kit before preparing any tutorial members");
    }
    const kit =
      id === "tutorial-series-kit@1" && enabling ? TutorialKitSchema.parse(input ?? DEFAULT_TUTORIAL_KIT) : undefined;
    const active = selectExperiment(
      directory,
      id,
      enabling,
      () => {
        if (
          id === "tutorial-camera@1" &&
          ["motion-plan.json", "briefs/beat-sheet.md"].some((file) =>
            existsSync(path.join(directory, "pipeline", file)),
          )
        )
          experimentError("Change the camera experiment before the beat-sheet begins");
        if (
          id === THREE_SHOT_EXPERIMENT &&
          ["design.json", "motion-plan.json", "briefs/look.md", "briefs/beat-sheet.md"].some((file) =>
            existsSync(path.join(directory, "pipeline", file)),
          )
        )
          experimentError("Change the 3D shot experiment before the look begins");
      },
      kit,
    );
    return { outputs: existsSync(experimentFile(directory)) ? [experimentFile(directory)] : [], metadata: { active } };
  }
  if (!input) experimentError("This action requires --input");
  if (args.action === "freeze") return { outputs: [freezeComparison(root, args.project, input)] };
  if (args.action === "outcome") return { outputs: [recordComparisonOutcome(root, args.project, input)] };
  const request = CameraRequestSchema.parse(input);
  const capture = readJson(scopedFile(root, request.capture));
  const words = readJson(scopedFile(root, request.words));
  const proposal = proposeTutorialCamera(capture, words, request);
  if (readProjectPlaybook(directory)?.id !== "product-tutorial")
    experimentError("The camera proposal belongs to a product-tutorial film");

  if (!startExperiment(directory, "tutorial-camera@1"))
    experimentError("Enable tutorial-camera@1 for this project first");
  const file = path.join(directory, "pipeline/tutorial-camera-proposal.json");
  atomicJson(file, { ...proposal, capture: request.capture, words: request.words, actions: request.actions });
  return { outputs: [file], metadata: { findings: proposal.findings, stops: proposal.stops.length } };
});
