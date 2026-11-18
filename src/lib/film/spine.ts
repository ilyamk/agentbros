import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HEADING = "## User's words";

const spineFile = (projectDir: string) => path.join(projectDir, "pipeline", "spine.md");

/** The markdown block of .agents/skills/creative-studio/references/spine-template.md, for one project. */
export function spineFromTemplate(templateText: string, projectId: string): string {
  const block = /```markdown\n([\s\S]*?)\n```/.exec(templateText)?.[1];
  if (!block) throw new Error("The spine template has no markdown block.");
  return `${block.replaceAll("PROJECT_ID", projectId).trimEnd()}\n\n${HEADING}\n`;
}

const oneLine = (words: string) => words.replace(/\s+/g, " ").trim();

/** Adds the user's words for a step once; repeating the same words changes nothing. */
export function appendUserWords(
  projectDir: string,
  stepId: string,
  words: string,
  at: string = new Date().toISOString(),
): void {
  const file = spineFile(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, "utf8") : `# Spine\n\n${HEADING}\n`;
  if (readUserWords(projectDir, stepId).includes(oneLine(words))) return;
  const line = `- **${stepId}** (${at.slice(0, 10)}): ${oneLine(words)}\n`;
  const withHeading = text.includes(HEADING) ? text : `${text.trimEnd()}\n\n${HEADING}\n`;
  const start = withHeading.indexOf(HEADING) + HEADING.length;
  const nextHeading = withHeading.indexOf("\n## ", start);
  if (nextHeading < 0) writeFileSync(file, `${withHeading.trimEnd()}\n${line}`);
  else writeFileSync(file, `${withHeading.slice(0, nextHeading).trimEnd()}\n${line}${withHeading.slice(nextHeading)}`);
}

/** The user's words for a step, oldest first. */
export function readUserWords(projectDir: string, stepId: string): string[] {
  const file = spineFile(projectDir);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(HEADING);
  if (start < 0) return [];
  const nextHeading = text.indexOf("\n## ", start + HEADING.length);
  const section = nextHeading < 0 ? text.slice(start) : text.slice(start, nextHeading);
  const words: string[] = [];
  for (const match of section.matchAll(/^- \*\*([a-z-]+)\*\* \([^)]*\): (.*)$/gm))
    if (match[1] === stepId && match[2]) words.push(match[2]);
  return words;
}
