/**
 * The OS half of console notifications (RFC 0004 D23, WP14 decision). macOS only; nothing is bundled or downloaded:
 *
 * - `terminal-notifier`, when the user has it on PATH (Homebrew): the click opens the console at the card (`-open`).
 * - else `osascript` `display notification`: always present, but a click cannot open a URL (macOS may open Script
 *   Editor instead); the open console tab's browser notifications are the click-through path then.
 *
 * A bundled Swift helper was not chosen: `UNUserNotificationCenter` needs a signed `.app` bundle with its own
 * permission prompt and a live delegate for clicks, more than a worker, and no binary may live in git. Title and body
 * travel as arguments (never inside AppleScript source), so no text can inject script.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

export interface OsNotification {
  title: string;
  body: string;
  /** Opened on click (when the sender can). */
  url: string;
  /** A later notification with the same group replaces the earlier one. */
  group: string;
}

export interface NotificationSender {
  readonly name: "terminal-notifier" | "osascript" | "none";
  readonly clickThrough: boolean;
  send(notification: OsNotification): Promise<void>;
}

export type Runner = (file: string, args: readonly string[]) => Promise<void>;

const SEND_TIMEOUT_MS = 5000;

export const runFile: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: SEND_TIMEOUT_MS, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

/** One line, no control characters, bounded: what any sender passes on. */
export const plain = (text: string, max: number) =>
  text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);

/** The AppleScript reads its text from `argv`, so the title and body are data, never script. */
export const OSASCRIPT_SCRIPT = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
] as const;

export function osascriptArgs(notification: OsNotification): string[] {
  return [
    ...OSASCRIPT_SCRIPT.flatMap((statement) => ["-e", statement]),
    plain(notification.title, 120),
    plain(notification.body, 240),
  ];
}

export function terminalNotifierArgs(notification: OsNotification): string[] {
  return [
    "-title",
    plain(notification.title, 120),
    "-message",
    plain(notification.body, 240),
    "-open",
    notification.url,
    "-group",
    plain(notification.group, 200),
  ];
}

export const noSender: NotificationSender = { name: "none", clickThrough: false, send: async () => undefined };

export function osascriptSender(run: Runner = runFile, file = "/usr/bin/osascript"): NotificationSender {
  return { name: "osascript", clickThrough: false, send: (n) => run(file, osascriptArgs(n)) };
}

export function terminalNotifierSender(file: string, run: Runner = runFile): NotificationSender {
  return { name: "terminal-notifier", clickThrough: true, send: (n) => run(file, terminalNotifierArgs(n)) };
}

const executable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `name` on PATH (plus the Homebrew prefixes a daemon's PATH may lack), or undefined. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = [...(env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (executable(file)) return file;
  }
  return undefined;
}

/** The best sender on this machine: terminal-notifier, else osascript, else none (not macOS). */
export function detectSender(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: Runner } = {},
): NotificationSender {
  if ((options.platform ?? process.platform) !== "darwin") return noSender;
  const notifier = findOnPath("terminal-notifier", options.env);
  if (notifier) return terminalNotifierSender(notifier, options.run);
  return executable("/usr/bin/osascript") ? osascriptSender(options.run) : noSender;
}
