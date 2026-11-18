/**
 * Settings' harness hooks (RFC 0004 §7.1 H3): the real status of this checkout's hooks (`GET /api/hooks`), the
 * install or update command to copy, and an Install button that runs the same command (`POST /api/hooks/install`,
 * `harness:setup --hooks --apply`) only after the user confirms the plan. After an install the one trust step per
 * harness is shown as harness:setup states it. Snapshot mode shows no status and no button. The status is shared with the
 * top banner (`hooks-banner.tsx`) through `hooks-state.ts`.
 */
import { useEffect, useState } from "react";
import { HOOKS_INSTALL_COMMAND, type HooksResponse, type HooksStatus } from "@contract";
import { Copy, Plug } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { asFailure } from "@/api/errors";
import { refreshHooks, useHooksState } from "./hooks-state";
import { snapshotMode } from "@/lib/snapshot-mode";
import type { Tone } from "@/lib/status";
import { ToneBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const STATE_TONE: Record<HooksStatus["claude"], Tone> = {
  installed: "done",
  missing: "upcoming",
  stale: "stale",
};

export function HooksSettings() {
  const { d } = useI18n();
  const store = useConsoleStore();
  const client = store.client;
  const live = !snapshotMode() && !!client.hooks;
  const { hooks, error } = useHooksState(client, live);
  const [confirming, setConfirming] = useState(false);
  const [trust, setTrust] = useState<string[]>();

  // Settings always shows a fresh status; the banner and its dialog share it.
  useEffect(() => {
    if (live) void refreshHooks(client);
  }, [live, client]);

  const t = d.settings;
  const status = hooks?.status;
  const outdated = status && (status.claude !== "installed" || status.codex !== "installed");
  return (
    <div className="flex flex-col gap-3" data-hooks-settings>
      <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-1 text-sm">
        {(["claude", "codex"] as const).map((harness) => (
          <div key={harness} className="contents">
            <dt>{t.harness[harness]}</dt>
            <dd data-hook-state={status?.[harness] ?? "unknown"}>
              {status ? (
                <ToneBadge tone={STATE_TONE[status[harness]]}>{t.hooksState[status[harness]]}</ToneBadge>
              ) : (
                <span className="text-muted-foreground">
                  {!live ? t.hooksSnapshot : error ? t.hooksUnknown : t.hooksLoading}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {error ? (
        <p role="alert" className="text-sm text-status-blocked">
          {error}
        </p>
      ) : null}
      <CopyCommand command={hooks?.command ?? HOOKS_INSTALL_COMMAND} />
      {live && status && outdated ? (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          data-hooks-install
          disabled={!client.installHooks}
          onClick={() => {
            setTrust(undefined);
            setConfirming(true);
          }}
        >
          <Plug aria-hidden="true" />
          {status.claude === "stale" || status.codex === "stale" ? t.update : t.install}
        </Button>
      ) : null}
      {trust ? (
        <div role="status" className="flex flex-col gap-1 text-sm" data-hooks-trust>
          <p className="font-medium">{t.installed}</p>
          <ul className="list-disc ps-5 text-muted-foreground">
            {trust.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {confirming && hooks ? (
        <InstallDialog
          hooks={hooks}
          onClose={() => setConfirming(false)}
          onInstalled={(steps) => {
            setConfirming(false);
            setTrust(steps);
            void refreshHooks(client);
          }}
        />
      ) : null}
    </div>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const { d } = useI18n();
  const [copied, setCopied] = useState<"ok" | "failed">();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 rounded-md bg-muted px-2 py-1 font-mono text-xs break-all select-all" data-hooks-command>
        {command}
      </code>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          navigator.clipboard?.writeText(command).then(
            () => setCopied("ok"),
            () => setCopied("failed"),
          ) ?? setCopied("failed");
        }}
      >
        <Copy aria-hidden="true" />
        {d.settings.copy}
      </Button>
      <span role="status" className="text-xs text-muted-foreground empty:hidden">
        {copied === "ok" ? d.settings.copied : copied === "failed" ? d.settings.copyFailed : null}
      </span>
    </div>
  );
}

function InstallDialog({
  hooks,
  onClose,
  onInstalled,
}: {
  hooks: HooksResponse;
  onClose: () => void;
  onInstalled: (trust: string[]) => void;
}) {
  const { d, f } = useI18n();
  const store = useConsoleStore();
  const t = d.settings;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const conflicts = hooks.plan.filter((item) => item.action === "conflict");

  const install = async () => {
    if (!store.client.installHooks) return;
    setBusy(true);
    setError(undefined);
    try {
      const reply = await store.client.installHooks();
      if (reply.ok) onInstalled(reply.trust ?? []);
      else setError(f(t.installFailed, { message: reply.message ?? reply.result?.error ?? "" }));
    } catch (failure) {
      setError(f(t.installFailed, { message: asFailure(failure).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent data-hooks-dialog>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-5" aria-hidden="true" />
            {t.installTitle}
          </DialogTitle>
          <DialogDescription>{f(t.installBody, { command: hooks.command })}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1 text-sm">
          {hooks.plan.map((item) => (
            <li key={item.harness} className="flex min-w-0 flex-wrap gap-x-2">
              <code className="font-mono text-xs break-all">{item.file}</code>
              <span className="text-muted-foreground">{t.hookAction[item.action]}</span>
            </li>
          ))}
        </ul>
        {conflicts.map((item) => (
          <p key={item.harness} role="alert" className="text-sm text-status-blocked">
            {f(t.installConflict, { file: item.file, conflict: item.conflict ?? "" })}
          </p>
        ))}
        <p role="status" aria-live="polite" className="text-sm text-status-blocked empty:hidden">
          {error}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {d.app.cancel}
          </Button>
          <Button onClick={() => void install()} disabled={busy || conflicts.length > 0} data-hooks-confirm>
            {busy ? t.installing : t.installConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
