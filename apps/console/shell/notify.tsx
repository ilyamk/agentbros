/**
 * Notifications in the page (RFC 0004 D23, WP14): the bridge's provider (started once the session is ready, idle in
 * fixture mode), the first-run prompt and the Settings card with the master switch, per-kind toggles, the OS sender's
 * reach and the browser permission (asked only from a button).
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BellRing } from "lucide-react";
import { useI18n } from "@/i18n";
import { navigate } from "@/lib/router";
import { NOTIFY_KINDS, NotifyBridge, useNotify, type NotifyKind, type SentNotice } from "@/lib/notify";
import { useConsole, useConsoleStore } from "@/store/context";
import type { NoticeTone } from "@/store/store";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const BridgeContext = createContext<NotifyBridge | undefined>(undefined);

export const useNotifyBridge = () => useContext(BridgeContext);

const TONE: Record<NotifyKind, NoticeTone> = {
  decision: "warning",
  card: "warning",
  agent: "warning",
  failure: "error",
  render: "success",
  job: "success",
};

export function NotifyProvider({ children, intervalMs }: { children: ReactNode; intervalMs?: number }) {
  const store = useConsoleStore();
  const { d } = useI18n();
  const ready = useConsole((s) => s.session.status === "ready");
  const [bridge, setBridge] = useState<NotifyBridge>();
  // The dictionary follows the language; the bridge need not restart for it.
  const dictionary = useRef(d);
  dictionary.current = d;

  useEffect(() => {
    if (!ready || !store.client.text) return;
    const page = (item: SentNotice) => {
      const overflow = item.notice.key.startsWith("overflow:");
      const d = dictionary.current;
      store.notify({
        id: `notify-${item.notice.key}`,
        tone: TONE[item.notice.kind],
        title: overflow ? d.notify.overflow : d.settings.notificationKinds[item.notice.kind],
        text: item.notice.body,
        route: item.notice.route,
      });
    };
    const next = new NotifyBridge(store.client.text, { page, open: (route) => navigate(`#${route}`) }).start(
      intervalMs,
    );
    setBridge(next);
    return () => {
      void next.report(true);
      next.stop();
      setBridge(undefined);
    };
  }, [ready, store, intervalMs]);

  return <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>;
}

/** Asked once (D23): notifications stay off until the user turns them on here or in Settings. */
export function NotifyPrompt() {
  const { d } = useI18n();
  const bridge = useNotifyBridge();
  const { status } = useNotify(bridge);
  const [busy, setBusy] = useState(false);
  if (!bridge || !status || status.settings.prompted || status.disabledBy) return null;
  const answer = async (enabled: boolean) => {
    setBusy(true);
    try {
      // The click is the user gesture the browser permission needs.
      if (enabled) await bridge.allowBrowser();
      await bridge.update({ enabled, prompted: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby="notify-prompt-title"
      className="mx-4 mt-4 flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground lg:mx-8"
    >
      <h2 id="notify-prompt-title" className="flex items-center gap-2 font-semibold">
        <BellRing aria-hidden="true" className="size-4 text-muted-foreground" />
        {d.notify.promptTitle}
      </h2>
      <p className="text-sm text-muted-foreground">{d.notify.promptText}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
          {d.notify.promptEnable}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void answer(false)}>
          {d.notify.promptLater}
        </Button>
      </div>
    </section>
  );
}

/** The Settings card's content. */
export function NotificationSettings() {
  const { d, f } = useI18n();
  const bridge = useNotifyBridge();
  const { status, unavailable, permission } = useNotify(bridge);
  const [error, setError] = useState(false);
  const update = (patch: Parameters<NotifyBridge["update"]>[0]) => {
    setError(false);
    void bridge?.update(patch).catch(() => setError(true));
  };
  const off = !status || !!status.disabledBy;
  const reach = !status
    ? undefined
    : status.sender.name === "terminal-notifier"
      ? d.notify.osTerminalNotifier
      : status.sender.name === "osascript"
        ? f(d.notify.osOsascript, { command: "brew install terminal-notifier" })
        : d.notify.osNone;
  return (
    <>
      {!bridge || unavailable ? <p className="text-sm text-muted-foreground">{d.notify.unavailable}</p> : null}
      {status?.disabledBy ? <p className="text-sm text-status-waiting">{d.notify.envOff}</p> : null}
      <Label className="justify-between">
        {d.notify.enable}
        <Switch
          checked={!!status?.settings.enabled}
          disabled={off}
          onCheckedChange={(enabled) => update({ enabled, prompted: true })}
        />
      </Label>
      {NOTIFY_KINDS.map((kind) => (
        <Label key={kind} className="justify-between pl-4 font-normal">
          {d.settings.notificationKinds[kind]}
          <Switch
            checked={status ? status.settings.kinds[kind] : false}
            disabled={off || !status?.settings.enabled}
            onCheckedChange={(value) => update({ kinds: { [kind]: value } })}
          />
        </Label>
      ))}
      {reach ? <p className="text-sm text-muted-foreground">{reach}</p> : null}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{d.notify.browser}:</span>
        {permission === "default" ? (
          <Button size="sm" variant="outline" disabled={!bridge} onClick={() => void bridge?.allowBrowser()}>
            {d.notify.browserAllow}
          </Button>
        ) : (
          <span className="text-muted-foreground">
            {permission === "granted"
              ? d.notify.browserGranted
              : permission === "denied"
                ? d.notify.browserDenied
                : d.notify.browserUnsupported}
          </span>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-status-blocked">
          {d.notices.error}
        </p>
      ) : null}
    </>
  );
}
