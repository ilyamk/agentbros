import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ReferenceSpeechTextSchema, type ReferenceSpeechText } from "../../types/reference";
import {
  hasVerbatim,
  readTrackedSpeechText,
  redactSpeechText,
  SPEECH_TEXT,
  SPEECH_TEXT_FULL,
  writeSpeechText,
} from "./speech-text";

export type RedactResult = {
  referenceId: string;
  /** redacted: the tracked layer held words, now moved; refreshed: rebuilt from the local file; recovered: words found in git history; kept: nothing to do; missing: no speech-text layer. */
  action: "redacted" | "refreshed" | "recovered" | "kept" | "missing";
  localFile?: string;
  /** Commit the words were recovered from. */
  fromCommit?: string;
  words?: number;
  screenTextItems?: number;
  note?: string;
};

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** The newest committed version of the tracked layer that still held the film's words, for a checkout whose local file was never written. */
export function speechTextFromHistory(directory: string): { layer: ReferenceSpeechText; commit: string } | undefined {
  const root = git(directory, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) return undefined;
  const relative = path.relative(root, path.join(directory, SPEECH_TEXT)).split(path.sep).join("/");
  const commits = git(root, ["log", "--format=%H", "--", relative])?.split("\n").filter(Boolean) ?? [];
  for (const commit of commits) {
    const raw = git(root, ["show", `${commit}:${relative}`]);
    if (!raw) continue;
    try {
      const layer = ReferenceSpeechTextSchema.parse(JSON.parse(raw));
      if (hasVerbatim(layer)) return { layer, commit };
    } catch {
      // an unparsable old version: keep looking
    }
  }
  return undefined;
}

const structureOf = (layer: ReferenceSpeechText) => {
  const { content: _content, ...rest } = redactSpeechText(layer);
  return rest;
};

/**
 * Moves a reference's verbatim speech and screen text out of the tracked speech-text.json into the git-ignored
 * media/speech-text.full.json and rewrites the tracked layer as structure. Idempotent. A checkout that only has the
 * structure (another machine, or after a merge) gets the words back from git history when they were ever committed.
 */
export function redactReference(
  directory: string,
  referenceId: string,
  options: { history?: boolean } = {},
): RedactResult {
  const tracked = readTrackedSpeechText(directory);
  if (!tracked) return { referenceId, action: "missing", note: `No ${SPEECH_TEXT}; nothing to redact.` };
  const localPath = path.join(directory, SPEECH_TEXT_FULL);
  const counts = (layer: ReferenceSpeechText) => ({
    words: layer.speech.words.length,
    screenTextItems: layer.screenText.items.length,
  });
  if (hasVerbatim(tracked)) {
    writeSpeechText(directory, tracked);
    return { referenceId, action: "redacted", localFile: SPEECH_TEXT_FULL, ...counts(tracked) };
  }
  const local = existsSync(localPath)
    ? ReferenceSpeechTextSchema.parse(JSON.parse(readFileSync(localPath, "utf8")))
    : undefined;
  if (local && hasVerbatim(local)) {
    if (isDeepStrictEqual(structureOf(local), structureOf(tracked)))
      return { referenceId, action: "kept", localFile: SPEECH_TEXT_FULL, ...counts(tracked) };
    writeSpeechText(directory, local);
    return {
      referenceId,
      action: "refreshed",
      localFile: SPEECH_TEXT_FULL,
      ...counts(local),
      note: "The tracked structure differed from the local text; rebuilt from the local file.",
    };
  }
  if (options.history === false)
    return {
      referenceId,
      action: "kept",
      ...counts(tracked),
      note: "Structure only and no local text on this machine.",
    };
  const found = speechTextFromHistory(directory);
  if (!found)
    return {
      referenceId,
      action: "kept",
      ...counts(tracked),
      note: "Structure only; no local text and none in git history. Rerun ref:analyze --layers speech-text with the media to get the words back.",
    };
  const matches = isDeepStrictEqual(structureOf(found.layer), structureOf(tracked));
  if (matches) {
    writeSpeechText(directory, found.layer);
    return {
      referenceId,
      action: "recovered",
      localFile: SPEECH_TEXT_FULL,
      fromCommit: found.commit,
      ...counts(found.layer),
    };
  }
  return {
    referenceId,
    action: "kept",
    fromCommit: found.commit,
    ...counts(tracked),
    note: `Words found in ${found.commit.slice(0, 8)} do not match the tracked structure (the layer was re-measured since); not restored. Rerun ref:analyze --layers speech-text with the media.`,
  };
}
