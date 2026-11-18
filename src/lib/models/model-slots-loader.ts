import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ModelSlotsFileSchema,
  type ModelSlotsFile,
  ModelUseCasesFileSchema,
  type ModelUseCasesFile,
} from "../../types/model-slots";

export const MODEL_SLOTS_FILE = fileURLToPath(new URL("./model-slots.json", import.meta.url));
export function modelSlotsPath(): string {
  return process.env.AGENTBROS_MODEL_SLOTS ?? MODEL_SLOTS_FILE;
}
/** No cache: maintenance edits and path overrides are visible immediately. */
export function loadModelSlots(file = modelSlotsPath()): ModelSlotsFile {
  return ModelSlotsFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export const MODEL_USE_CASES_FILE = fileURLToPath(new URL("./model-use-cases.json", import.meta.url));
export function modelUseCasesPath(): string {
  return process.env.AGENTBROS_MODEL_USE_CASES ?? MODEL_USE_CASES_FILE;
}
export function loadModelUseCases(file = modelUseCasesPath()): ModelUseCasesFile {
  return ModelUseCasesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
