import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicJson, locked } from "../campaigns/production/files";
import { CliErrorObject } from "../cli";
import { readProjectPlaybook } from "../playbooks/project";
import { TutorialKitSchema } from "./kit-schema";
import { findExperiment, THREE_SHOT_EXPERIMENT, type ExperimentId } from "./registry";

const SelectionSchema = z
  .object({
    id: z.string(),
    started: z.boolean().default(false),
    kit: TutorialKitSchema.optional(),
  })
  .strict();
const BindingSchema = z.object({ version: z.literal(1), selections: z.array(SelectionSchema) }).strict();
export type Selection = z.infer<typeof SelectionSchema>;

export const experimentFile = (directory: string) => path.join(directory, "pipeline/experiments.json");

export function experimentError(message: string): never {
  throw new CliErrorObject({ code: "VALIDATION", message });
}

export function readExperiments(directory: string): Selection[] {
  const file = experimentFile(directory);
  if (!existsSync(file)) return [];
  const binding = BindingSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (binding.selections.some(({ id, kit }) => (id === "tutorial-series-kit@1") !== Boolean(kit)))
    experimentError("A series kit selection must pin its kit.");
  if (new Set(binding.selections.map(({ id }) => id)).size !== binding.selections.length)
    experimentError("Duplicate experiment selection");
  for (const { id } of binding.selections) {
    if (!findExperiment(id)) experimentError(`Experiment version ${id} is unavailable in this checkout`);
  }
  return binding.selections;
}

export function writeExperiments(directory: string, selections: Selection[]) {
  atomicJson(experimentFile(directory), { version: 1, selections });
}

function updateExperiments(directory: string, update: (current: Selection[]) => Selection[]) {
  const pipeline = path.join(directory, "pipeline");
  mkdirSync(pipeline, { recursive: true });
  return locked(path.join(pipeline, ".experiments.lock"), () => {
    const current = readExperiments(directory);
    const next = update(current);
    if (next !== current) writeExperiments(directory, next);
    return next;
  });
}

export function selectExperiment(
  directory: string,
  id: string,
  enable: boolean,
  beforeChange?: () => void,
  kit?: Selection["kit"],
) {
  const entry = findExperiment(id);
  if (!entry) experimentError(`Unknown experiment: ${id}`);
  const playbook = readProjectPlaybook(directory)?.id;
  const supported =
    (id === THREE_SHOT_EXPERIMENT &&
      entry.playbooks.some((allowed) => allowed === playbook) &&
      existsSync(path.join(directory, "pipeline/brief.json"))) ||
    (id === "tutorial-series-kit@1" && playbook === "content-series") ||
    (id === "tutorial-camera@1" &&
      playbook === "product-tutorial" &&
      existsSync(path.join(directory, "pipeline/brief.json")));
  if (enable && id === "tutorial-series-kit@1" && !kit) experimentError("Select a series kit");
  if (!supported)
    experimentError(
      `Experiment ${id} cannot be changed on this project. Use the eligible playbook or recipe entry point.`,
    );
  return updateExperiments(directory, (current) => {
    const active = current.find((item) => item.id === id);
    if (Boolean(active) === enable) {
      if (kit && JSON.stringify(kit) !== JSON.stringify(active?.kit))
        experimentError(
          "This project already pins another kit. Disable the selection before it starts, or use a new project.",
        );
      return current;
    }
    if (active?.started) experimentError(`Experiment ${id} has started. Create a new project to try another approach.`);
    beforeChange?.();
    return enable
      ? [...current, { id, started: false, ...(kit ? { kit } : {}) }]
      : current.filter((item) => item.id !== id);
  });
}

export function startExperiment(directory: string, id: ExperimentId): boolean {
  if (!readExperiments(directory).some((item) => item.id === id)) return false;
  return updateExperiments(directory, (current) =>
    current.some((item) => item.id === id && !item.started)
      ? current.map((item) => (item.id === id ? { ...item, started: true } : item))
      : current,
  ).some((item) => item.id === id);
}

export function experimentInstructions(directory: string, step?: string | null) {
  const playbook = readProjectPlaybook(directory)?.id;
  return readExperiments(directory).flatMap(({ id }) => {
    const entry = findExperiment(id)!;
    // A recipe draft records its selection before it has a bound playbook.
    if (playbook && !entry.playbooks.some((allowed) => allowed === playbook)) return [];
    if (step && !entry.steps.some((entryStep) => entryStep === step)) return [];
    return [
      {
        id: entry.id,
        status: entry.status,
        steps: entry.steps,
        instruction: entry.instruction.replaceAll("<id>", path.basename(directory)),
      },
    ];
  });
}
