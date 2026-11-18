/**
 * A small synchronous exclusive file lock for console writers (ratings.json, WP9), the same scheme as the start lock in
 * lock.ts: the lock file holds an owner token ({pid, at, id}); it is created exclusively; a stale lock (older than the
 * stale age, or its pid gone) is taken over atomically by renaming it to a unique name and re-checking that the moved
 * file is the one judged stale (a fresh lock moved by mistake is linked back); release removes the file only while it
 * still holds this owner's token, so a writer whose lock was broken never deletes the next owner's lock.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** One attempt: the release function when this caller now holds the lock, else undefined. */
export function tryFileLock(file: string, staleMs: number): (() => void) | undefined {
  mkdirSync(path.dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), id: randomBytes(8).toString("hex") });
  const release = () => {
    try {
      if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, mine);
    } finally {
      closeSync(fd);
    }
    return release;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let content: string;
  let age: number;
  try {
    content = readFileSync(file, "utf8");
    age = Date.now() - statSync(file).mtimeMs;
  } catch {
    return undefined; // released meanwhile: the caller retries
  }
  let holder: number | undefined;
  try {
    holder = (JSON.parse(content) as { pid?: number }).pid;
  } catch {
    holder = undefined;
  }
  const dead = holder !== undefined && holder !== process.pid && !pidAlive(holder);
  // An empty or half-written lock is someone's create in progress unless it is old.
  if (!(age > staleMs || (dead && content !== ""))) return undefined;
  const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(file, aside);
  } catch {
    return undefined;
  }
  let moved = "";
  try {
    moved = readFileSync(aside, "utf8");
  } catch {
    moved = "";
  }
  if (moved !== content) {
    // We moved a fresh lock another writer had just taken: put it back (link fails if a newer one exists).
    try {
      linkSync(aside, file);
    } catch {
      // a newer lock exists; leave it
    }
  }
  rmSync(aside, { force: true });
  return undefined; // the caller retries the exclusive create
}

/** Runs `work` holding `file`, waiting up to `waitMs` for another holder; TIMEOUT when it cannot. */
export function withFileLock<T>(
  file: string,
  work: () => T,
  options: { waitMs: number; staleMs: number; what: string },
): T {
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const release = tryFileLock(file, options.staleMs);
    if (release) {
      try {
        return work();
      } finally {
        release();
      }
    }
    if (Date.now() > deadline)
      throw new CliErrorObject({
        code: "TIMEOUT",
        message: `${options.what} is held by another writer; retry, or remove it if no writer is running.`,
      });
    sleep(5 + Math.floor(Math.random() * 20));
  }
}
