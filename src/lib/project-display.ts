import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProjectDisplaySchema } from "../types/project-display";

export const PROJECT_DISPLAY_FILE = "project-display.json";

export function readProjectTitle(directory: string): string | undefined {
  const file = path.join(directory, PROJECT_DISPLAY_FILE);
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 4096) return undefined;
    const parsed = ProjectDisplaySchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data.title : undefined;
  } catch {
    return undefined;
  }
}

export function writeProjectTitle(directory: string, title: string): string {
  const display = ProjectDisplaySchema.parse({ v: 1, title });
  const file = path.join(directory, PROJECT_DISPLAY_FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(display, null, 2)}\n`, { flag: "wx" });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return file;
}
