/**
 * The per-machine console token (RFC 0004 D15): `out/console/session.json`, mode 0600, 32 random bytes as hex, stable
 * across server restarts so the harness browser can reload. Never logged, never in the lock file.
 */
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { ConsoleSessionSchema, SESSION_FILE, type ConsoleSession } from "../../types/console";
import { newToken } from "../local-server/security";

export const sessionPath = (rootDir: string) => path.join(rootDir, SESSION_FILE);

/** The session when the file is valid. Tightens a loose mode to 0600. */
function readSession(rootDir: string): ConsoleSession | undefined {
  const file = sessionPath(rootDir);
  try {
    const parsed = ConsoleSessionSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return undefined;
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    return parsed.data;
  } catch {
    return undefined;
  }
}

export const readSessionToken = (rootDir: string) => readSession(rootDir)?.token;
export const readCredentialSessionToken = (rootDir: string) => readSession(rootDir)?.credentialsToken;

/** Reads the token, creating the file (exclusively, mode 0600) when absent and replacing an invalid one. */
export function loadOrCreateSessionToken(rootDir: string): string {
  const existing = readSessionToken(rootDir);
  if (existing) return existing;
  const file = sessionPath(rootDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = newToken();
  const body = JSON.stringify({ v: 1, token }) + "\n";
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Another process created it meanwhile, or the existing file is invalid: prefer a valid one, else replace it.
  const raced = readSessionToken(rootDir);
  if (raced) return raced;
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return token;
}
