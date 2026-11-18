/**
 * Compare two versions (RFC 0004 US17) in the project history: any two renders, files or step outputs the view already
 * carries, picked as A and B. Pictures and audio open in the WP6 `Compare` (side by side or wipe); text documents the
 * media route serves (`.md`, `.txt`, `.srt`, `.csv`, `.vtt`) are fetched and shown as a line diff; step outputs the
 * view carries as data (critic rounds, idea and script candidates) are diffed as text or as JSON with sorted keys.
 * Nothing is written. The view keeps no history of one overwritten file, so a version is a distinct file or record.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { MEDIA_KINDS, MediaRefSchema, type MediaRef, type ProjectView } from "@contract";
import { GitCompare } from "lucide-react";
import { useI18n, type I18n } from "@/i18n";
import { mediaUrl } from "../../../../src/lib/console/urls";
import { collapse, DIFF_MAX_CHARS, diffLines, normaliseText, type DiffRow } from "@/lib/line-diff";
import { cn } from "@/lib/utils";
import { Compare } from "@/media/compare";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type VersionGroup = "video" | "image" | "audio" | "document" | "record";

/** Where a record version comes from, for its label. */
export type RecordSource =
  | { type: "critic"; step: string; round: number }
  | { type: "candidate"; pool: "ideas" | "scripts"; id: string; title?: string };

export interface Version {
  key: string;
  group: VersionGroup;
  /** A file (renders, pictures, audio, text documents). */
  media?: MediaRef;
  /** A step output the view carries as data: its text, or JSON. */
  record?: { source: RecordSource; text: string; json: boolean };
}

const KINDS = new Set<string>(MEDIA_KINDS);
/** Documents the media route serves as text (src/lib/console/media.ts TEXT_TYPES and `.vtt`). */
const SERVED_TEXT = /\.(md|txt|srt|csv|vtt)$/i;
const groupOf = (media: MediaRef): VersionGroup => (media.kind === "strip" ? "image" : (media.kind as VersionGroup));
export const versionKey = (media: Pick<MediaRef, "root" | "path">) => `${media.root ?? "project"}:${media.path}`;
/** Pictures with pictures, sound with sound, any text with any text. */
export const comparable = (a: Version, b: Version) =>
  (a.group === "record" ? "document" : a.group) === (b.group === "record" ? "document" : b.group);

const sortedJson = (value: unknown) => normaliseText("record.json", JSON.stringify(value)).text;

/** Every version the view carries, once each: renders first, then other files, then step outputs. */
export function collectVersions(view: ProjectView): Version[] {
  const found = new Map<string, Version>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string" && typeof record.kind === "string" && KINDS.has(record.kind)) {
      const parsed = MediaRefSchema.safeParse(record);
      if (parsed.success) {
        const key = versionKey(parsed.data);
        const servable = parsed.data.kind !== "document" || SERVED_TEXT.test(parsed.data.path);
        if (servable && !found.has(key)) found.set(key, { key, media: parsed.data, group: groupOf(parsed.data) });
        return;
      }
    }
    for (const item of Object.values(record)) visit(item, depth + 1);
  };
  visit(view.media, 0);
  visit(view, 0);
  for (const round of view.film?.critic?.rounds ?? []) {
    const key = `critic:${round.step}:${round.round}`;
    found.set(key, {
      key,
      group: "record",
      record: { source: { type: "critic", step: round.step, round: round.round }, text: sortedJson(round), json: true },
    });
  }
  for (const pool of [view.film?.ideas, view.film?.scripts])
    for (const item of pool?.items ?? []) {
      const key = `${pool!.kind}:${pool!.round}:${item.id}`;
      found.set(key, {
        key,
        group: "record",
        record: {
          source: { type: "candidate", pool: pool!.kind, id: item.id, ...(item.title ? { title: item.title } : {}) },
          text: item.text.endsWith("\n") ? item.text : `${item.text}\n`,
          json: false,
        },
      });
    }
  return [...found.values()];
}

/** A version's name in the picker, in the UI language; file paths and agent text as written. */
export function versionLabel({ d, f }: Pick<I18n, "d" | "f">, version: Version): string {
  const t = d.history.compare;
  if (version.media) return `${version.media.root === "out" ? "out/" : ""}${version.media.path}`;
  const source = version.record!.source;
  if (source.type === "critic") return f(t.criticRound, { step: source.step, round: source.round });
  return f(t.candidate, { pool: t.pools[source.pool], id: source.id, title: source.title ?? "" });
}

export function CompareVersions({ view }: { view: ProjectView }) {
  const i18n = useI18n();
  const { d } = i18n;
  const t = d.history.compare;
  const id = useId();
  const versions = useMemo(() => collectVersions(view), [view]);
  const [aKey, setA] = useState<string>();
  const [bKey, setB] = useState<string>();
  const a = versions.find((item) => item.key === aKey);
  const b = versions.find((item) => item.key === bKey);
  const groups = (["video", "image", "audio", "document", "record"] as const).filter((group) =>
    versions.some((item) => item.group === group),
  );

  const picker = (label: string, value: string | undefined, set: (key: string) => void, which: "a" | "b") => (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span id={`${id}-${which}`} className="text-xs font-medium">
        {label}
      </span>
      <Select value={value ?? ""} onValueChange={set}>
        <SelectTrigger
          aria-labelledby={`${id}-${which}`}
          className="w-full min-w-0 [&>span]:min-w-0 [&>span]:truncate"
          data-version-pick={which}
        >
          <SelectValue placeholder={t.pick} />
        </SelectTrigger>
        <SelectContent>
          {groups.flatMap((group) =>
            versions
              .filter((item) => item.group === group)
              .map((item) => (
                <SelectItem key={item.key} value={item.key}>
                  {`${t.groups[group]} · ${versionLabel(i18n, item)}`}
                </SelectItem>
              )),
          )}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-3 rounded-md border p-3"
      data-compare-versions
    >
      <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold">
        <GitCompare className="size-4 text-muted-foreground" aria-hidden="true" />
        {t.title}
      </h3>
      {versions.length < 2 ? (
        <p className="text-sm text-muted-foreground">{t.none}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t.hint}</p>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            {picker(t.a, aKey, setA, "a")}
            {picker(t.b, bKey, setB, "b")}
          </div>
          {a && b ? (
            a.key === b.key ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t.same}
              </p>
            ) : !comparable(a, b) ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t.sameKind}
              </p>
            ) : a.media && b.media && a.group !== "document" ? (
              <Compare project={view.project.id} a={a.media} b={b.media} />
            ) : (
              <TextDiff project={view.project.id} a={a} b={b} />
            )
          ) : null}
        </>
      )}
    </section>
  );
}

type Loaded =
  | { status: "loading" }
  | { status: "error"; text: string }
  | { status: "ready"; rows: DiffRow[]; json: boolean; added: number; removed: number };

async function fetchText(project: string, media: MediaRef, signal: AbortSignal): Promise<string> {
  const response = await fetch(mediaUrl(project, media), { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const size = Number(response.headers.get("content-length") ?? 0);
  if (size > DIFF_MAX_CHARS) throw new RangeError("too large");
  const text = await response.text();
  if (text.length > DIFF_MAX_CHARS) throw new RangeError("too large");
  return text;
}

function TextDiff({ project, a, b }: { project: string; a: Version; b: Version }) {
  const i18n = useI18n();
  const { d, f } = i18n;
  const t = d.history.compare;
  const [state, setState] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    const load = async (version: Version): Promise<{ text: string; json: boolean }> => {
      if (version.record) return { text: version.record.text, json: version.record.json };
      const path = versionLabel(i18n, version);
      try {
        return normaliseText(version.media!.path, await fetchText(project, version.media!, controller.signal));
      } catch (error) {
        if (error instanceof RangeError) throw new Error(f(t.tooLarge, { path }));
        throw new Error(f(t.failed, { path, message: (error as Error).message }));
      }
    };
    Promise.all([load(a), load(b)]).then(
      ([x, y]) => {
        const ops = diffLines(x.text, y.text);
        setState({
          status: "ready",
          rows: collapse(ops),
          json: x.json && y.json,
          added: ops.filter((op) => op.kind === "added").length,
          removed: ops.filter((op) => op.kind === "removed").length,
        });
      },
      (error: Error) => {
        if (!controller.signal.aborted) setState({ status: "error", text: error.message });
      },
    );
    return () => controller.abort();
    // `f` and `t` follow the language; a language switch need not refetch.
  }, [project, a.key, b.key]);

  if (state.status === "loading") return <p className="text-sm text-muted-foreground">{t.loading}</p>;
  if (state.status === "error")
    return (
      <p role="alert" className="text-sm text-status-blocked">
        {state.text}
      </p>
    );
  if (!state.added && !state.removed)
    return (
      <p role="status" className="text-sm" data-diff-identical>
        {t.identical}
      </p>
    );
  return (
    <figure className="flex min-w-0 flex-col gap-1" data-text-diff>
      <figcaption className="text-xs text-muted-foreground" role="status">
        {f(t.summary, { added: state.added, removed: state.removed })}
        {state.json ? ` · ${t.jsonNote}` : ""}
      </figcaption>
      <pre
        aria-label={f(t.diff, { a: versionLabel(i18n, a), b: versionLabel(i18n, b) })}
        tabIndex={0}
        className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-5"
      >
        {state.rows.map((row, index) =>
          row.kind === "skip" ? (
            <div key={index} className="text-muted-foreground italic">
              {`  … ${row.count}`}
            </div>
          ) : (
            <div
              key={index}
              data-diff={row.kind}
              className={cn(
                "break-all whitespace-pre-wrap",
                row.kind === "added" && "bg-status-done/15",
                row.kind === "removed" && "bg-status-blocked/15",
              )}
            >
              <span aria-hidden="true">{row.kind === "added" ? "+ " : row.kind === "removed" ? "- " : "  "}</span>
              {row.kind !== "same" ? (
                <span className="sr-only">{row.kind === "added" ? t.added : t.removed}: </span>
              ) : null}
              {row.text}
            </div>
          ),
        )}
      </pre>
    </figure>
  );
}
