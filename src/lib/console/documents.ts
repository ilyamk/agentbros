import { closeSync, fstatSync, readSync } from "node:fs";
import path from "node:path";
import {
  DOCUMENT_EDIT_LIMIT,
  STRATEGY_DOCUMENTS,
  type ConsoleDocument,
  type ConsoleDocumentLocator,
  type ConsoleDocumentSave,
} from "../../types/console-document";
import { StrategySchema } from "../../types/studio";
import { ChainRefusal, nextAction, openFilmProject, sealStep } from "../film/state";
import { HttpError, forbidden } from "../local-server/errors";
import { assertRealDirectory, openRegularFile, resolveConfined } from "../local-server/paths";
import { writeFileAtomic } from "./control";
import { resolveMedia, TEXT_LIMIT } from "./media";
import { OUT_PREFIX } from "./urls";
import { projectPaths, sha256 } from "./view/files";

function readText(file: string) {
  const { fd, size } = openRegularFile(file);
  try {
    if (size > TEXT_LIMIT) throw forbidden("Text document exceeds 2 MiB");
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!read) break;
      offset += read;
    }
    if (offset !== size) throw new HttpError(409, "STALE", "The document changed while being read. Try again.");
    const contents = bytes.subarray(0, size);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contents);
    return { text, revision: sha256(contents), size, mode: fstatSync(fd).mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

function strategyInReview(root: string, directory: string): boolean {
  const next = nextAction(openFilmProject(directory, { rootDir: root }));
  return next.action === "ask" && next.step === "strategy";
}

function strategyFile(directory: string, relative: string): string {
  return resolveConfined(assertRealDirectory(directory, "Project"), relative);
}

export function readConsoleDocument(root: string, project: string, locator: ConsoleDocumentLocator): ConsoleDocument {
  const { projectDir } = projectPaths(root, project);
  const strategy = locator.root !== "out" && STRATEGY_DOCUMENTS.some((file) => file === locator.path);
  const file = strategy
    ? strategyFile(projectDir, locator.path)
    : resolveMedia(root, project, [...(locator.root === "out" ? [OUT_PREFIX] : []), ...locator.path.split("/")]);
  if (typeof file !== "string" && !file.contentType.startsWith("text/")) throw forbidden("This file is not a document");
  const { text, revision, size } = readText(typeof file === "string" ? file : file.file);
  return { text, revision, editable: strategy && size <= DOCUMENT_EDIT_LIMIT && strategyInReview(root, projectDir) };
}

/** Runs in the same project queue as decision submissions. A save creates a new review, never an approval. */
export function saveStrategyDocument(root: string, project: string, request: ConsoleDocumentSave): ConsoleDocument {
  const { projectDir } = projectPaths(root, project);
  const file = strategyFile(projectDir, request.path);
  const previous = readText(file);
  if (request.revision !== previous.revision || !strategyInReview(root, projectDir))
    throw new HttpError(409, "STALE", "The strategy review changed. Open the latest document before editing.");
  assertRealDirectory(path.join(projectDir, "pipeline", "chain"), "Film receipts directory");
  const size = Buffer.byteLength(request.text);
  if (!request.text.trim() || request.text.includes("\0") || size > DOCUMENT_EDIT_LIMIT)
    throw new HttpError(400, "VALIDATION", "Enter a non-empty text document of at most 64 KiB.");
  if (request.path.endsWith(".json")) {
    let value: unknown;
    try {
      value = JSON.parse(request.text);
    } catch {
      throw new HttpError(400, "VALIDATION", "The strategy must contain valid JSON.");
    }
    const parsed = StrategySchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(400, "VALIDATION", `${issue?.path.join(".") || "Strategy"}: ${issue?.message}`);
    }
  }

  const revision = sha256(request.text);
  if (revision !== previous.revision) {
    if (readText(file).revision !== previous.revision)
      throw new HttpError(409, "STALE", "The document changed. Open the latest version before editing.");
    writeFileAtomic(file, request.text, previous.mode);
    try {
      sealStep(openFilmProject(projectDir, { rootDir: root }), "strategy");
    } catch (error) {
      if (readText(file).revision === revision) writeFileAtomic(file, previous.text, previous.mode);
      if (error instanceof ChainRefusal) throw new HttpError(400, "VALIDATION", error.message);
      throw error;
    }
  }
  return { text: request.text, revision, editable: true };
}
