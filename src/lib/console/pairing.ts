/**
 * One-use pairing links (RFC 0004 D15, A1): a fresh browser (a harness preview pane, the Codex in-app browser) has no
 * cookie and no stored token, and agent-visible output never carries the long-lived token. Next-step answers and a
 * non-terminal `pnpm console` carry `<base>#pair=<code>` instead: a random code, single use, valid for
 * {@link PAIR_TTL_MS}, stored only as HMAC(token, code) in `out/console/pairing.json` (mode 0600, bound to this
 * checkout's token), at most {@link PAIR_MAX_OUTSTANDING} outstanding (the oldest goes first). The page exchanges it
 * with `POST /api/session/pair` for a browser session; every pairing is recorded (time and browser family, never the
 * code) and listed in Settings, and already-open tabs show a toast, so a code redeemed by anyone else is visible.
 *
 * Residual risk (the D15 boundary): whoever reads an answer can redeem its code before the user does (an agent with
 * curl, say) and gets the session token for this checkout; the record and the toast make that visible, not
 * impossible. Any process of the same OS user can read session.json anyway.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { withFileLock } from "./file-lock";
import { loadOrCreateSessionToken, readSessionToken } from "./session";

export const PAIRING_FILE = "out/console/pairing.json";
export const PAIR_TTL_MS = 10 * 60_000;
export const PAIR_MAX_OUTSTANDING = 5;
/** Pairings kept for Settings (newest last). */
export const PAIRED_KEEP = 20;
export const PAIR_CODE = /^[a-f0-9]{32}$/;

export interface PairedBrowser {
  at: string;
  /** A coarse browser family from the User-Agent ("Chrome", "Safari", "curl", …); never the full string. */
  agent: string;
}

interface PairingState {
  v: 1;
  codes: { hash: string; expiresAt: string }[];
  paired: PairedBrowser[];
}

const fileOf = (rootDir: string) => path.join(rootDir, PAIRING_FILE);
const hashOf = (token: string, code: string) =>
  createHmac("sha256", token).update(`agentbros-console/pair/v1:${code}`).digest("hex");

function read(rootDir: string): PairingState {
  try {
    const value = JSON.parse(readFileSync(fileOf(rootDir), "utf8")) as Partial<PairingState>;
    const codes = Array.isArray(value.codes)
      ? value.codes.filter(
          (code): code is PairingState["codes"][number] =>
            !!code && typeof code.hash === "string" && typeof code.expiresAt === "string",
        )
      : [];
    const paired = Array.isArray(value.paired)
      ? value.paired.filter(
          (item): item is PairedBrowser => !!item && typeof item.at === "string" && typeof item.agent === "string",
        )
      : [];
    return { v: 1, codes, paired };
  } catch {
    return { v: 1, codes: [], paired: [] };
  }
}

function write(rootDir: string, state: PairingState): void {
  const file = fileOf(rootDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

const locked = <T>(rootDir: string, work: () => T): T =>
  withFileLock(`${fileOf(rootDir)}.lock`, work, { waitMs: 2000, staleMs: 10_000, what: PAIRING_FILE });

const live = (state: PairingState, now: number) => state.codes.filter((code) => Date.parse(code.expiresAt) > now);

/** A fresh one-use code for this checkout (creating the token when needed). */
export function issuePairingCode(rootDir: string, now: Date = new Date()): string {
  const token = loadOrCreateSessionToken(rootDir);
  const code = randomBytes(16).toString("hex");
  locked(rootDir, () => {
    const state = read(rootDir);
    const codes = live(state, now.getTime());
    codes.push({ hash: hashOf(token, code), expiresAt: new Date(now.getTime() + PAIR_TTL_MS).toISOString() });
    write(rootDir, { ...state, codes: codes.slice(-PAIR_MAX_OUTSTANDING) });
  });
  return code;
}

/** `<base>#pair=<code>`, plus `&project=` and `&view=` like the session URL. */
export function pairingUrl(baseUrl: string, code: string, project?: string, view?: "timeline" | "history"): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}#pair=${code}${project ? `&project=${encodeURIComponent(project)}${view ? `&view=${view}` : ""}` : ""}`;
}

/** The browser family of a User-Agent (best effort, bounded). */
export function browserFamily(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const known: [RegExp, string][] = [
    [/Edg\//, "Edge"],
    [/OPR\//, "Opera"],
    [/Firefox\//, "Firefox"],
    [/Electron\//, "Electron"],
    [/HeadlessChrome\//, "Headless Chrome"],
    [/Chrome\//, "Chrome"],
    [/Safari\//, "Safari"],
    [/^curl\//, "curl"],
    [/^node|undici/i, "Node"],
    [/python/i, "Python"],
  ];
  for (const [pattern, name] of known) if (pattern.test(ua)) return name;
  return ua ? "Other" : "Unknown";
}

/**
 * Redeems a code: true (and the pairing recorded) when it is outstanding and unexpired for this checkout's token; a
 * code is gone after one attempt that matched. False for anything else, without telling why.
 */
export function redeemPairingCode(
  rootDir: string,
  code: string,
  options: { userAgent?: string; now?: Date; token?: string } = {},
): boolean {
  if (!PAIR_CODE.test(code)) return false;
  const token = options.token ?? readSessionToken(rootDir);
  if (!token) return false;
  const now = options.now ?? new Date();
  const expected = Buffer.from(hashOf(token, code), "hex");
  return locked(rootDir, () => {
    const state = read(rootDir);
    const codes = live(state, now.getTime());
    const index = codes.findIndex((entry) => {
      const stored = Buffer.from(entry.hash, "hex");
      return stored.length === expected.length && timingSafeEqual(stored, expected);
    });
    if (index < 0) {
      if (codes.length !== state.codes.length) write(rootDir, { ...state, codes });
      return false;
    }
    codes.splice(index, 1);
    const paired = [...state.paired, { at: now.toISOString(), agent: browserFamily(options.userAgent) }].slice(
      -PAIRED_KEEP,
    );
    write(rootDir, { v: 1, codes, paired });
    return true;
  });
}

/** The recorded pairings, oldest first. */
export const pairedBrowsers = (rootDir: string): PairedBrowser[] => read(rootDir).paired;
