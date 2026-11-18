import { z } from "zod";
import { isSafeRelativePath } from "./console";

export const STRATEGY_DOCUMENTS = ["pipeline/strategy.md", "pipeline/strategy.json"] as const;
export const DOCUMENT_EDIT_LIMIT = 64 * 1024;

const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const ConsoleDocumentLocatorSchema = z.strictObject({
  path: z.string().max(1024).refine(isSafeRelativePath, "Invalid document path"),
  root: z.enum(["project", "out"]).optional(),
});
export const ConsoleDocumentSchema = z.strictObject({ text: z.string(), revision, editable: z.boolean() });
export const ConsoleDocumentSaveSchema = z.strictObject({
  path: z.enum(STRATEGY_DOCUMENTS),
  text: z.string().max(DOCUMENT_EDIT_LIMIT),
  revision,
});

export type ConsoleDocumentLocator = z.infer<typeof ConsoleDocumentLocatorSchema>;
export type ConsoleDocument = z.infer<typeof ConsoleDocumentSchema>;
export type ConsoleDocumentSave = z.infer<typeof ConsoleDocumentSaveSchema>;
