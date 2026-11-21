import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { digest, immutableJson, projectDirectory } from "../campaigns/production/files";
import { experimentError, readExperiments, startExperiment, writeExperiments } from "./project";

const id = "tutorial-series-kit@1";
export const tutorialKitFile = (directory: string) => path.join(directory, "pipeline/tutorial-series-kit.json");

export function bindTutorialKit(root: string, campaign: string, directory: string): string | undefined {
  const parent = projectDirectory(root, campaign);
  if (!startExperiment(parent, id)) return;
  const selection = readExperiments(parent).find((item) => item.id === id)!;
  const file = tutorialKitFile(directory);
  const current = readExperiments(directory);
  immutableJson(file, { version: 1, experiment: id, campaign, kit: selection.kit, kitHash: digest(selection.kit) });
  const previous = current.find((item) => item.id === id);
  if (previous && digest(previous.kit) !== digest(selection.kit))
    experimentError("This episode already pins another series kit");
  if (!previous) writeExperiments(directory, [...current, selection]);
  return file;
}

export function assertTutorialKit(directory: string) {
  const selection = readExperiments(directory).find((item) => item.id === id);
  if (!selection) return;
  const file = tutorialKitFile(directory);
  if (!existsSync(file)) experimentError("This episode is missing its pinned tutorial series kit");
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.experiment !== id || record.kitHash !== digest(selection.kit) || digest(record.kit) !== record.kitHash)
    experimentError("This episode no longer matches its pinned tutorial series kit");
}
