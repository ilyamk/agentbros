import { ChangeEntrySchema, ChangePathSchema, type ChangeEntry } from "../../types/contrib";
import { parseFields } from "./pr-block";

export function parseChangeEntry(source: string, file?: string): ChangeEntry {
  if (file !== undefined) ChangePathSchema.parse(file);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Expected change entry front matter between --- lines");
  const fields = parseFields(match[1]!);
  if (Object.hasOwn(fields, "body")) throw new Error("body is not a front matter field");
  const entry = ChangeEntrySchema.parse({ ...fields, body: match[2] });
  if (entry.breaking && !entry.body.split(/\r?\n[ \t]*\r?\n/).some((paragraph) => /^Migration:\s*\S/.test(paragraph))) {
    throw new Error("Breaking changes require a non-empty Migration: paragraph");
  }
  return entry;
}
