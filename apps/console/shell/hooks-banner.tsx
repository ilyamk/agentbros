/**
 * The hooks notice at the top of every page (RFC 0004 §7.1 H3): while Claude Code's or Codex's hooks are missing or
 * out of date in this checkout, a banner asks the user to connect them. Its dialog explains why hooks matter, shows
 * each harness's status, checks again, and installs with `harness:setup --hooks --apply` (`POST /api/hooks/install`)
 * only on the user's click after the plan and the command are shown. The user may hide the banner for good (this
 * browser); Settings keeps the hooks. Snapshot mode and clients without `hooks` show nothing.
 */
import { useState } from "react";
import type { HooksResponse } from "@contract";
import { Plug, RefreshCw, X } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { asFailure } from "@/api/errors";
import { snapshotMode } from "@/lib/snapshot-mode";
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
import { CopyCommand, STATE_TONE } from "./hooks";
import {
  dismissHooksBanner,
  hooksBannerDismissed,
  hooksComplete,
  hooksStale,
  refreshHooks,
  useHooksState,
} from "./hooks-state";

export function HooksBanner() {
  const { d } = useI18n();
  const client = useConsoleStore().client;
  const live = !snapshotMode() && !!client.hooks;
  const { hooks } = useHooksState(client, live);
  const [dismissed, setDismissed] = useState(hooksBannerDismissed);
  const [open, setOpen] = useState(false);
  const t = d.hooksBanner;

  const show = live && !dismissed && !!hooks && !hooksComplete(hooks.status);
  return (
    <>
      {show ? (
        <div className="px-4 pt-4 lg:px-8">
          <section
            aria-labelledby="hooks-banner-title"
            data-hooks-banner
            className="flex flex-wrap items-center gap-3 rounded-xl border border-status-waiting/50 bg-status-waiting/10 p-4 text-sm"
          >
            <Plug className="size-5 shrink-0 text-status-waiting" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
              <h2 id="hooks-banner-title" className="font-semibold">
                {hooksStale(hooks.status) ? t.titleStale : t.title}
              </h2>
              <p className="text-muted-foreground">{t.body}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setOpen(true)} data-hooks-banner-open>
                {t.open}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t.dismiss}
                title={t.dismiss}
                data-hooks-banner-dismiss
                onClick={() => {
                  dismissHooksBanner();
                  setDismissed(true);
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          </section>
        </div>
      ) : null}
      {open ? <HooksDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Why hooks matter, the status per harness, Check again, Install or Update after the plan, and Close. */
export function HooksDialog({ onClose }: { onClose: () => void }) {
  const { d, f } = useI18n();
  const client = useConsoleStore().client;
  const live = !snapshotMode() && !!client.hooks;
  const { hooks, error: loadError, checking } = useHooksState(client, live);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [trust, setTrust] = useState<string[]>();
  const [checked, setChecked] = useState(false);
  const t = d.hooksBanner;
  const s = d.settings;

  const status = hooks?.status;
  const complete = !!status && hooksComplete(status);
  const conflicts = hooks?.plan.filter((item) => item.action === "conflict") ?? [];

  const check = async () => {
    setError(undefined);
    setChecked(false);
    await refreshHooks(client);
    setChecked(true);
  };

  const install = async () => {
    if (!client.installHooks) return;
    setBusy(true);
    setError(undefined);
    try {
      const reply = await client.installHooks();
      if (reply.ok) {
        setTrust(reply.trust ?? []);
        await refreshHooks(client);
      } else setError(f(s.installFailed, { message: reply.message ?? reply.result?.error ?? "" }));
    } catch (failure) {
      setError(f(s.installFailed, { message: asFailure(failure).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent data-hooks-dialog className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-5" aria-hidden="true" />
            {t.dialogTitle}
          </DialogTitle>
          <DialogDescription>{t.why}</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
          <li>{t.reasonActivity}</li>
          <li>{t.reasonDecisions}</li>
          <li>{t.reasonOrient}</li>
          <li>{t.reasonGuard}</li>
        </ul>
        <p className="text-sm font-medium">{t.important}</p>

        <section aria-labelledby="hooks-dialog-status" className="flex flex-col gap-2">
          <h3 id="hooks-dialog-status" className="text-sm font-semibold">
            {t.statusTitle}
          </h3>
          <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-1 text-sm">
            {(["claude", "codex"] as const).map((harness) => (
              <div key={harness} className="contents">
                <dt>{s.harness[harness]}</dt>
                <dd data-hook-state={status?.[harness] ?? "unknown"}>
                  {status ? (
                    <ToneBadge tone={STATE_TONE[status[harness]]}>{s.hooksState[status[harness]]}</ToneBadge>
                  ) : (
                    <span className="text-muted-foreground">
                      {!live ? s.hooksSnapshot : loadError ? s.hooksUnknown : s.hooksLoading}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {status && !complete && hooks ? <InstallPlan hooks={hooks} /> : null}
        </section>

        {conflicts.map((item) => (
          <p key={item.harness} role="alert" className="text-sm text-status-blocked">
            {f(s.installConflict, { file: item.file, conflict: item.conflict ?? "" })}
          </p>
        ))}
        {trust ? (
          <div role="status" className="flex flex-col gap-1 text-sm" data-hooks-trust>
            <p className="font-medium">{s.installed}</p>
            <ul className="list-disc ps-5 text-muted-foreground">
              {trust.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground empty:hidden">
          {checking ? s.hooksLoading : checked && !trust ? (complete ? t.checkedComplete : t.checkedIncomplete) : null}
        </p>
        <p role="alert" className="text-sm text-status-blocked empty:hidden">
          {error ?? (checked ? loadError : undefined)}
        </p>
        <p className="text-xs text-muted-foreground">{t.settingsHint}</p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {d.app.close}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void check()}
            disabled={busy || checking || !live}
            data-hooks-check
          >
            <RefreshCw aria-hidden="true" />
            {t.check}
          </Button>
          {status && !complete ? (
            <Button
              onClick={() => void install()}
              disabled={busy || checking || conflicts.length > 0 || !client.installHooks}
              data-hooks-confirm
            >
              <Plug aria-hidden="true" />
              {busy ? s.installing : hooksStale(status) ? t.update : t.install}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the install runs and writes, so the click that installs is the user's yes to this exact plan. */
function InstallPlan({ hooks }: { hooks: HooksResponse }) {
  const { d, f } = useI18n();
  const s = d.settings;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">{f(s.installBody, { command: hooks.command })}</p>
      <ul className="flex flex-col gap-1">
        {hooks.plan.map((item) => (
          <li key={item.harness} className="flex min-w-0 flex-wrap gap-x-2">
            <code className="font-mono text-xs break-all">{item.file}</code>
            <span className="text-muted-foreground">{s.hookAction[item.action]}</span>
          </li>
        ))}
      </ul>
      <CopyCommand command={hooks.command} />
    </div>
  );
}
