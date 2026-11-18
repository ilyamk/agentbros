import { CliErrorObject } from "../cli";
import { StudioRefusal } from "./studio";

/** A studio refusal is the caller's to fix, not an internal fault. */
export function studioRefusals<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof StudioRefusal) throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: error.message });
    throw error;
  }
}

export const KIND_SPEC = {
  name: "kind",
  required: true,
  choices: ["ideas", "scripts"],
  description: "ideas: the concept teams' pool; scripts: the script variants' pool",
} as const;
