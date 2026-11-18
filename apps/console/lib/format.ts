/** Locale-aware number, money, time and duration formatting for the console (UI language, not the user's text). */

const usdCache = new Map<string, Intl.NumberFormat>();

/** `$3.10`; `null`/`undefined` is rendered by the caller (unknown price is never free). */
export function formatUsd(value: number, locale: string): string {
  let format = usdCache.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
    usdCache.set(locale, format);
  }
  return format.format(value);
}

export function formatNumber(value: number, locale: string, digits = 0): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

/** Compact duration: `41 s`, `6 min`, `1 h 05 min`, using the dictionary's unit templates. */
export function formatDuration(ms: number, units: { s: string; min: string; h: string; hmin: string }): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return units.s.replace("{n}", String(seconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return units.min.replace("{n}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (minutes % 60 === 0) return units.h.replace("{n}", String(hours));
  return units.hmin.replace("{h}", String(hours)).replace("{m}", String(minutes % 60).padStart(2, "0"));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

/**
 * `4 minutes ago` in the UI language. Every caller shows a past moment, so a time after `now` (clock skew between the
 * server and the browser, or a fixture clock) reads as "now", never as the future.
 */
export function formatRelative(at: string | number, now: number, locale: string): string {
  const time = typeof at === "number" ? at : Date.parse(at);
  const diff = Math.min(0, time - now);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  for (const [unit, size] of UNITS)
    if (Math.abs(diff) >= size || unit === "second") return format.format(Math.round(diff / size), unit);
  return format.format(0, "second");
}

let zone: string | undefined;
/** Fixture mode shows times in UTC so screenshots do not depend on the machine; live mode uses the local zone. */
export function setDisplayTimeZone(value: string | undefined): void {
  zone = value;
}

/** Clock time and date, `09:14` or `17 Nov, 09:14`. */
export function formatTime(at: string, locale: string, withDate = false): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(withDate ? { day: "numeric", month: "short" } : {}),
    timeZone: zone,
  }).format(new Date(at));
}

/** First characters of a hash, for status lines. */
export const shortHash = (sha: string) => sha.slice(0, 8);

/** A command line from argv, quoting arguments with spaces; `<words>` replaced by the user's words. */
export function commandLine(argv: readonly string[], words?: string): string {
  return argv
    .map((arg) => (arg === "<words>" && words !== undefined ? words : arg))
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`))
    .join(" ");
}
