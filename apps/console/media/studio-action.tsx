/**
 * "Open in Remotion Studio" (RFC 0004 D21 as amended 2026-11-18, §17): the console asks the server whether Studio can
 * open the project (`studioStatus`), then starts or reuses a loopback-only Studio of the project in its current state
 * (`studioOpen`) and shows it in a new tab. The tab is opened blank in the click itself (a tab opened after the reply
 * would be blocked as a pop-up), cut from this page (`opener = null`: Studio gets no handle on the signed-in console)
 * and pointed at the returned URL; on failure it is closed and the message shown. Where Studio cannot open the project
 * (a campaign container, no server), the reason and the copyable `pnpm studio` command stand in.
 */
import { useEffect, useId, useState } from "react";
import type { FORMATS, StudioStatusResponse } from "@contract";

type Format = (typeof FORMATS)[number];
import { Check, Copy, Hourglass, MonitorPlay } from "lucide-react";
import { asFailure } from "@/api/errors";
import type { ApiClient } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/i18n";
import { snapshotMode } from "@/lib/snapshot-mode";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "@/store/context";

export const STUDIO_COMMAND = "pnpm studio";

/** Copies text with the async clipboard API; false when it is missing or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!globalThis.navigator?.clipboard?.writeText) return false;
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function useCopy() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (text: string) => setState((await copyText(text)) ? "copied" : "failed");
  return { state, copy, reset: () => setState("idle") };
}

type StudioStatusState =
  | { kind: "loading" }
  | { kind: "ready"; status: StudioStatusResponse }
  | { kind: "error"; message: string }
  /** The client has no Studio routes (no server). */
  | { kind: "none" };

/** One status request per client and project, shared by every launcher on the page (several players, the header). */
const statusCache = new WeakMap<ApiClient, Map<string, Promise<StudioStatusResponse>>>();
const statusListeners = new Set<() => void>();

function fetchStatus(client: ApiClient, project: string, fresh = false): Promise<StudioStatusResponse> | undefined {
  if (!client.studioStatus) return undefined;
  let byProject = statusCache.get(client);
  if (!byProject) statusCache.set(client, (byProject = new Map()));
  let pending = fresh ? undefined : byProject.get(project);
  if (!pending) {
    pending = client.studioStatus(project);
    byProject.set(project, pending);
    // A failed request is not cached: the next launcher asks again.
    pending.catch(() => byProject.delete(project));
  }
  return pending;
}

/** Re-reads the status (after an open) and tells every launcher of the page. */
function refreshStatus(client: ApiClient, project: string) {
  void fetchStatus(client, project, true)
    ?.catch(() => undefined)
    .finally(() => {
      for (const listener of [...statusListeners]) listener();
    });
}

/** Test hook: forget cached statuses. */
export function resetStudioStatusCache(client: ApiClient) {
  statusCache.delete(client);
}

export function useStudioStatus(project: string | undefined): StudioStatusState {
  const client = useConsoleStore().client;
  const [state, setState] = useState<StudioStatusState>(() =>
    project && client.studioStatus ? { kind: "loading" } : { kind: "none" },
  );
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!project) return setState({ kind: "none" });
    const pending = fetchStatus(client, project);
    if (!pending) return setState({ kind: "none" });
    let live = true;
    pending.then(
      (status) => live && setState({ kind: "ready", status }),
      (failure) => live && setState({ kind: "error", message: asFailure(failure).message }),
    );
    return () => {
      live = false;
    };
  }, [client, project, version]);
  return state;
}

export interface OpenInStudioProps {
  /** The project Studio opens; without it only the command is offered. */
  project?: string;
  /** Remotion composition id of this render, when the caller knows it (MediaRef does not carry it). */
  composition?: string;
}

/** A local Remotion Studio: meaningless on a static snapshot (WP15). */
export function OpenInStudio(props: OpenInStudioProps) {
  return snapshotMode() ? null : <LiveOpenInStudio {...props} />;
}

function LiveOpenInStudio({ project, composition }: OpenInStudioProps) {
  const { d, f } = useI18n();
  const studio = useStudioStatus(project);
  if (project && studio.kind === "loading")
    return (
      <p role="status" className="flex items-center gap-1.5 text-muted-foreground">
        <Hourglass className="size-3.5" aria-hidden="true" />
        {d.media.studio.checking}
      </p>
    );
  if (project && studio.kind === "ready" && studio.status.available)
    return <StudioLauncher project={project} status={studio.status} />;
  const note =
    studio.kind === "ready" && studio.status.reason
      ? f(d.media.studio.unavailable, { reason: studio.status.reason })
      : studio.kind === "error"
        ? f(d.media.studio.statusFailed, { message: studio.message })
        : undefined;
  return <CopyStudioCommand composition={composition} note={note} />;
}

/** The Studio button of the project header: shown only where Studio can open the project. */
export function StudioHeaderButton({ project }: { project: string }) {
  const studio = useStudioStatus(snapshotMode() ? undefined : project);
  if (studio.kind !== "ready" || !studio.status.available) return null;
  return <StudioLauncher project={project} status={studio.status} compact />;
}

/**
 * Opens a blank tab now (in the click, so it is not blocked), clears the session it inherited and cuts its opener, asks
 * the server to start Studio, then points the tab at it; closes it on failure.
 */
export async function launchStudio(
  client: ApiClient,
  project: string,
  format: Format | undefined,
  open: () => Window | null = () => window.open("", "_blank"),
): Promise<{ ok: true; reused: boolean } | { ok: false; reason: "blocked" | "failed"; message?: string }> {
  const tab = open();
  if (!tab) return { ok: false, reason: "blocked" };
  try {
    // A tab opened with an opener starts with a copy of this tab's sessionStorage, which holds the console's token
    // (api/session.ts). Studio is another origin and must not get it: clear the copy while the tab is still the
    // same-origin about:blank (the console's own sessionStorage is separate and stays).
    tab.sessionStorage.clear();
  } catch {
    // not reachable (another origin already, or storage disabled): there is nothing of ours to clear
  }
  try {
    // Studio is another origin: it gets no handle back on the signed-in console.
    tab.opener = null;
  } catch {
    // some browsers refuse; the URL below is loopback-only either way
  }
  try {
    if (!client.studioOpen) throw new Error("Studio needs the console server.");
    const reply = await client.studioOpen(project, format ? { format } : {});
    tab.location.href = reply.url;
    return { ok: true, reused: reply.reused };
  } catch (failure) {
    tab.close();
    return { ok: false, reason: "failed", message: asFailure(failure).message };
  }
}

function StudioLauncher({
  project,
  status,
  compact,
}: {
  project: string;
  status: StudioStatusResponse;
  compact?: boolean;
}) {
  const { d, f } = useI18n();
  const store = useConsoleStore();
  const formats = status.target?.kind === "project" ? (status.formats ?? []) : [];
  const [format, setFormat] = useState<Format | undefined>(status.running?.format ?? formats[0]);
  const [phase, setPhase] = useState<"idle" | "starting" | "opened" | "reused" | "failed" | "blocked">("idle");
  const [message, setMessage] = useState<string>();
  const formatId = useId();

  const start = async () => {
    setPhase("starting");
    setMessage(undefined);
    const result = await launchStudio(store.client, project, formats.length ? format : undefined);
    if (result.ok) {
      setPhase(result.reused ? "reused" : "opened");
      refreshStatus(store.client, project);
    } else {
      setPhase(result.reason);
      setMessage(result.message);
    }
  };

  const failed = phase === "failed" || phase === "blocked";
  const text =
    phase === "starting"
      ? d.media.studio.starting
      : phase === "opened"
        ? d.media.studio.opened
        : phase === "reused"
          ? d.media.studio.reused
          : phase === "blocked"
            ? d.media.studio.popupBlocked
            : phase === "failed"
              ? f(d.media.studio.failed, { message: message ?? "" })
              : "";

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", !compact && "flex-col items-start")} data-studio>
      <div className="flex flex-wrap items-center gap-2">
        {formats.length > 1 ? (
          <Select value={format} onValueChange={(value) => setFormat(value as Format)}>
            <SelectTrigger
              id={formatId}
              size="sm"
              aria-label={d.media.studio.format}
              className="min-w-0"
              data-studio-format
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {formats.map((item) => (
                <SelectItem key={item} value={item}>
                  {d.media.studio.formats[item]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button
          variant={compact ? "outline" : "ghost"}
          size="sm"
          onClick={() => void start()}
          disabled={phase === "starting"}
          aria-busy={phase === "starting"}
          data-studio-open
        >
          {phase === "starting" ? <Hourglass aria-hidden="true" /> : <MonitorPlay aria-hidden="true" />}
          {d.media.studio.open}
        </Button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "text-xs empty:hidden",
          failed ? "text-status-blocked" : "text-muted-foreground",
          // In the header only a failure takes room; progress is announced.
          compact && !failed && "sr-only",
        )}
        data-studio-status
      >
        {text}
      </p>
    </div>
  );
}

/** The command a person runs themselves: where Studio cannot be started from here. */
function CopyStudioCommand({ composition, note }: { composition?: string; note?: string }) {
  const { d, f } = useI18n();
  const [open, setOpen] = useState(false);
  const { state, copy } = useCopy();
  const panel = useId();
  const text = composition
    ? `${STUDIO_COMMAND}\n# ${f(d.media.studio.composition, { id: composition })}`
    : STUDIO_COMMAND;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
        className="self-start"
      >
        <MonitorPlay aria-hidden="true" />
        {d.media.studio.open}
      </Button>
      {note ? (
        <p className="text-xs text-muted-foreground" data-studio-unavailable>
          {note} {d.media.studio.fallback}
        </p>
      ) : null}
      {open ? (
        <div id={panel} className="flex min-w-0 flex-col gap-1.5 rounded-md border bg-muted/40 p-2 text-xs">
          <p className="text-muted-foreground">{d.media.studio.hint}</p>
          <pre className="overflow-x-auto rounded-sm bg-background px-2 py-1 font-mono text-foreground">
            <code data-studio-command>{STUDIO_COMMAND}</code>
            {composition ? (
              <>
                {"\n"}
                <span className="text-muted-foreground"># {f(d.media.studio.composition, { id: composition })}</span>
              </>
            ) : null}
          </pre>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void copy(text)}>
              {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {d.app.copy}
            </Button>
            <span role="status" className="text-muted-foreground">
              {state === "copied" ? d.media.studio.copied : state === "failed" ? d.media.studio.copyFailed : ""}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
