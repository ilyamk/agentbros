/**
 * Notification settings and delivery state (RFC 0004 D23, WP14) in `out/console/notify.json`: the user's switches
 * (off until enabled, per-kind toggles), each project's journal cursor and the keys already notified, so a restart
 * never repeats a notice. Read leniently (a corrupt file means defaults) and written atomically.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CONSOLE_OUT_DIR } from "../../types/console";
import { writeFileAtomic } from "./control";
import { NOTIFY_KINDS, type NotifyKind } from "./notify-rules";

/** Proposed for the contract (src/types/console.ts) beside the other `out/console` files. */
export const NOTIFY_STATE_FILE = `${CONSOLE_OUT_DIR}/notify.json`;
/** `off` turns every notification off whatever the settings say (tests set it). */
export const NOTIFY_ENV = "AGENTBROS_NOTIFY";

/** `AGENTBROS_NOTIFY` read like the other console switches: trimmed, any case, `off`, `0`, `false` or `no`. */
export function notifyDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["off", "0", "false", "no"].includes((env[NOTIFY_ENV] ?? "").trim().toLowerCase());
}
/** Notified keys remembered (oldest dropped first). */
export const SEEN_MAX = 4000;

const KindsSchema = z.strictObject(
  Object.fromEntries(NOTIFY_KINDS.map((kind) => [kind, z.boolean()])) as Record<NotifyKind, z.ZodBoolean>,
);

export const NotifySettingsSchema = z.strictObject({
  /** Off until the user turns it on (first-run prompt or Settings). */
  enabled: z.boolean(),
  /** The first-run prompt was answered (either way). */
  prompted: z.boolean(),
  kinds: KindsSchema,
});
export type NotifySettings = z.infer<typeof NotifySettingsSchema>;

/** A Settings change: any subset of the switches. */
export const NotifySettingsPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  prompted: z.boolean().optional(),
  kinds: KindsSchema.partial().optional(),
});
export type NotifySettingsPatch = z.infer<typeof NotifySettingsPatchSchema>;

const CursorSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  ino: z.number().nonnegative().optional(),
});

export const NotifyStateSchema = z.strictObject({
  v: z.literal(1),
  settings: NotifySettingsSchema,
  /** When notifications were last turned on: projects older than this start at their journal's end. */
  enabledAt: z.number().nonnegative().optional(),
  cursors: z.record(z.string(), CursorSchema),
  seen: z.array(z.string().max(512)).max(SEEN_MAX),
  cooldowns: z.record(z.string(), z.number()),
});
export type NotifyState = z.infer<typeof NotifyStateSchema>;

export const defaultSettings = (): NotifySettings => ({
  enabled: false,
  prompted: false,
  kinds: Object.fromEntries(NOTIFY_KINDS.map((kind) => [kind, true])) as Record<NotifyKind, boolean>,
});

export const defaultState = (): NotifyState => ({
  v: 1,
  settings: defaultSettings(),
  cursors: {},
  seen: [],
  cooldowns: {},
});

export const notifyStateFile = (rootDir: string) => path.join(rootDir, NOTIFY_STATE_FILE);

export function readNotifyState(rootDir: string): NotifyState {
  try {
    const parsed = NotifyStateSchema.safeParse(JSON.parse(readFileSync(notifyStateFile(rootDir), "utf8")));
    return parsed.success ? parsed.data : defaultState();
  } catch {
    return defaultState();
  }
}

export function writeNotifyState(rootDir: string, state: NotifyState): void {
  writeFileAtomic(notifyStateFile(rootDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function applySettingsPatch(settings: NotifySettings, patch: NotifySettingsPatch): NotifySettings {
  return {
    enabled: patch.enabled ?? settings.enabled,
    prompted: patch.prompted ?? settings.prompted,
    kinds: { ...settings.kinds, ...patch.kinds },
  };
}
