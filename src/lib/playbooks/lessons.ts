/**
 * Creative lessons for a playbook, from two sources: the curated harness lessons in design-reference/creative-lessons.md
 * (tagged `- **Playbook:** <id>`), and the user's own lessons in local memory (type `lesson`, scope.playbooks naming it).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadMemory } from "../memory";
import { playbooksRoot } from "./project";

export const LESSONS_FILE = "design-reference/creative-lessons.md";

export type PlaybookLesson =
  { source: "harness"; title: string; date?: string } | { source: "memory"; id: string; title: string; date: string };

/** Entries under `## Lessons`; the format example in the file's code fence is not a lesson. */
export function parseLessons(markdown: string): { title: string; playbooks: string[]; date?: string }[] {
  const body = markdown.replace(/```[\s\S]*?```/g, "").split(/^## Lessons\s*$/m)[1] ?? "";
  return body
    .split(/^### /m)
    .slice(1)
    .map((entry) => {
      const title = entry.split("\n", 1)[0]!.trim();
      const field = (name: string) =>
        new RegExp(`^- \\*\\*${name}(?::\\*\\*|\\*\\*:)\\s*(.+)$`, "m").exec(entry)?.[1]?.trim();
      const playbooks = (field("Playbook") ?? "")
        .split(/[,\s]+/)
        .map((id) => id.replaceAll("`", ""))
        .filter(Boolean);
      const date = field("Date")?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      return { title, playbooks, ...(date ? { date } : {}) };
    });
}

/** Harness lessons tagged with the playbook, then the user's active memory lessons scoped to it, newest first. */
export function lessonsFor(id: string, root = playbooksRoot(), memoryRoot?: string): PlaybookLesson[] {
  const file = path.join(root, LESSONS_FILE);
  const harness: PlaybookLesson[] = existsSync(file)
    ? parseLessons(readFileSync(file, "utf8"))
        .filter((lesson) => lesson.playbooks.includes(id))
        .map(({ title, date }) => ({ source: "harness", title, ...(date ? { date } : {}) }))
    : [];
  const memory: PlaybookLesson[] = loadMemory(memoryRoot)
    .entries.filter(
      (entry) => entry.type === "lesson" && entry.status === "active" && entry.scope.playbooks.includes(id),
    )
    .map((entry) => ({
      source: "memory" as const,
      id: entry.id,
      title: entry.summary,
      date: entry.reviewedAt ?? entry.createdAt,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return [...harness, ...memory];
}
