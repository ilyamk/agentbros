import {
  Check,
  CircleAlert,
  CircleMinus,
  CircleX,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CredentialValueSchema,
  type CredentialList,
  type CredentialSave,
} from "../../../src/types/console-credentials";
import { asFailure } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { TONE_ICON, TONE_TEXT } from "@/lib/status";
import { useConsole, useConsoleStore } from "@/store/context";

type Key = CredentialList["keys"][number];

const KEY_STATUS = {
  set: { icon: TONE_ICON.done, tone: "done" },
  unset: { icon: CircleAlert, tone: "paused" },
  malformed: { icon: CircleX, tone: "blocked" },
  incomplete: { icon: CircleAlert, tone: "paused" },
  edited: { icon: TONE_ICON.current, tone: "current" },
  removed: { icon: CircleMinus, tone: "paused" },
} as const;
type Feedback =
  | "copied"
  | "saved"
  | "copyError"
  | "loadError"
  | "saveError"
  | "revealError"
  | "conflict"
  | "invalid"
  | "higgsfield"
  | "openverse";

async function copyKey(value: () => Promise<string>): Promise<void> {
  const clipboard = navigator.clipboard;
  if (typeof ClipboardItem === "function" && typeof clipboard?.write === "function") {
    await clipboard.write([
      new ClipboardItem({ "text/plain": value().then((text) => new Blob([text], { type: "text/plain" })) }),
    ]);
  } else {
    await clipboard.writeText(await value());
  }
}

function CredentialRow({
  entry,
  editable,
  busy,
  change,
  edit,
  reveal,
  notify,
}: {
  entry: Key;
  editable: boolean;
  busy: boolean;
  change?: string | null;
  edit: (value: string | null | undefined) => void;
  reveal: (signal: AbortSignal) => Promise<string | null>;
  notify: (feedback: Feedback) => void;
}) {
  const { d, f } = useI18n();
  const t = d.credentials;
  const [visible, setVisible] = useState(false);
  const [revealed, setRevealed] = useState<string>();
  const [reading, setReading] = useState(false);
  const [copied, setCopied] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);

  const hasSavedKey = entry.state !== "unset";
  const value = change === undefined ? (revealed ?? "") : (change ?? "");
  const available = change === undefined ? hasSavedKey : !!change;
  const id = `credential-${entry.name}`;
  const disabled = !editable || busy || reading;
  const state = change === null ? "removed" : change !== undefined ? "edited" : entry.state;
  const { icon: StateIcon, tone } = KEY_STATUS[state];
  const statusText = state === "removed" || state === "edited" ? t[state] : t.state[state];
  const description = (t.integrations as Partial<Record<string, string>>)[entry.name];
  const named = (text: string) => f(text, { key: entry.name });

  const read = async (use: (value: () => Promise<string>) => Promise<void>, failure: Feedback) => {
    const controller = new AbortController();
    active.current = controller;
    setReading(true);
    try {
      await use(async () => {
        const value = change ?? revealed ?? (await reveal(controller.signal));
        if (controller.signal.aborted || !value) throw new Error();
        return value;
      });
    } catch (error) {
      if (!controller.signal.aborted) notify(asFailure(error).code === "CONFLICT" ? "conflict" : failure);
    } finally {
      if (!controller.signal.aborted) setReading(false);
    }
  };

  const toggle = () => {
    if (visible) {
      setVisible(false);
      setRevealed(undefined);
    } else if (change !== undefined || !hasSavedKey) {
      setVisible(true);
    } else {
      void read(async (get) => {
        setRevealed(await get());
        setVisible(true);
      }, "revealError");
    }
  };

  return (
    <li className="grid min-w-0 gap-3 border-b py-4 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-1">
        <a
          className="inline-flex items-center gap-1 self-start text-sm font-medium text-link hover:underline"
          href={entry.signup}
          target="_blank"
          rel="noopener noreferrer"
        >
          {entry.service}
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
        {description && <p className="text-sm leading-snug text-muted-foreground">{description}</p>}
      </div>
      <div className="grid min-w-0 gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <Label htmlFor={id} className="break-all font-mono text-xs">
            {entry.name}
          </Label>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <StateIcon className={`size-3.5 shrink-0 ${TONE_TEXT[tone]}`} aria-hidden="true" />
            {statusText}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <Input
            id={id}
            type={visible ? "text" : "password"}
            value={value}
            className="flex-1 font-mono"
            placeholder={hasSavedKey && change === undefined ? "••••••••••••" : t.placeholder}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            maxLength={2048}
            disabled={disabled}
            onChange={(event) => {
              setRevealed(undefined);
              setCopied(false);
              edit(event.currentTarget.value || undefined);
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={named(visible ? t.hide : t.show)}
            title={named(visible ? t.hide : t.show)}
            onClick={toggle}
          >
            {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled || !available}
            aria-label={named(t.copy)}
            title={named(t.copy)}
            onClick={() =>
              void read(async (get) => {
                await copyKey(get);
                setCopied(true);
                notify("copied");
              }, "copyError")
            }
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled || !available}
            aria-label={named(t.remove)}
            title={named(t.remove)}
            onClick={() => {
              setVisible(false);
              setRevealed(undefined);
              setCopied(false);
              edit(hasSavedKey ? null : undefined);
            }}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </div>
    </li>
  );
}

export function CredentialSettings() {
  const { d } = useI18n();
  const t = d.credentials;
  const client = useConsoleStore().client;
  const ready = useConsole((state) => state.session.status === "ready");
  const [list, setList] = useState<CredentialList>();
  const [changes, setChanges] = useState<CredentialSave["changes"]>({});
  const [feedback, setFeedback] = useState<Feedback>();
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openStatus, setOpenStatus] = useState<"opened" | "openError">();
  const [generation, setGeneration] = useState(0);
  const loadRequest = useRef<AbortController | undefined>(undefined);
  const saveRequest = useRef<AbortController | undefined>(undefined);
  const openRequest = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async () => {
    if (!client.credentials || !ready) return;
    loadRequest.current?.abort();
    const controller = new AbortController();
    loadRequest.current = controller;
    try {
      setList(await client.credentials(controller.signal));
    } catch {
      if (!controller.signal.aborted) setFeedback("loadError");
    }
  }, [client, ready]);

  useEffect(() => {
    void load();
    return () => {
      loadRequest.current?.abort();
      saveRequest.current?.abort();
      openRequest.current?.abort();
    };
  }, [load]);

  const openEditor = async () => {
    if (!client.openCredentialEditor || opening) return;
    const controller = new AbortController();
    openRequest.current = controller;
    setOpening(true);
    setOpenStatus(undefined);
    try {
      await client.openCredentialEditor(controller.signal);
      setOpenStatus("opened");
    } catch {
      if (!controller.signal.aborted) setOpenStatus("openError");
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  };

  const reset = () => {
    setGeneration((current) => current + 1);
    setChanges({});
  };

  const save = async () => {
    if (
      !client.saveCredentials ||
      !list?.editable ||
      !Object.keys(changes).length ||
      busy ||
      feedback === "conflict" ||
      feedback === "saveError"
    )
      return;
    if (Object.values(changes).some((value) => value !== null && !CredentialValueSchema.safeParse(value).success)) {
      setFeedback("invalid");
      return;
    }
    const controller = new AbortController();
    saveRequest.current = controller;
    setBusy(true);
    setFeedback(undefined);
    try {
      setList(await client.saveCredentials({ revision: list.revision, changes }, controller.signal));
      reset();
      setFeedback("saved");
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = asFailure(error).code;
      setFeedback(
        code === "CONFLICT"
          ? "conflict"
          : code === "HIGGSFIELD_CREDENTIAL"
            ? "higgsfield"
            : code === "OPENVERSE_CREDENTIALS"
              ? "openverse"
              : code === "VALIDATION"
                ? "invalid"
                : "saveError",
      );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  if (!client.credentials || !client.revealCredential || !client.saveCredentials)
    return <p className="text-sm text-muted-foreground">{t.unavailable}</p>;
  if (!list)
    return (
      <div className="flex items-center gap-2">
        <p role="status" className="text-sm text-muted-foreground">
          {feedback ? t[feedback] : t.loading}
        </p>
        {feedback === "loadError" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setFeedback(undefined);
              void load();
            }}
          >
            {d.app.retry}
          </Button>
        )}
      </div>
    );

  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!list.editable && (
        <div className="flex flex-col items-start gap-2 pb-2">
          {client.openCredentialEditor && (
            <Button type="button" onClick={() => void openEditor()} disabled={opening}>
              <ExternalLink aria-hidden="true" />
              {t.openEditor}
            </Button>
          )}
          <p className="text-sm text-muted-foreground" role="status">
            {openStatus === "openError" || !client.openCredentialEditor ? (
              <>
                {t.openError} <code>pnpm console --open</code>
              </>
            ) : openStatus === "opened" ? (
              t.opened
            ) : (
              t.locked
            )}
          </p>
        </div>
      )}
      <ul className="min-w-0">
        {list.keys.map((entry) => (
          <CredentialRow
            key={`${generation}-${list.editable}-${entry.name}`}
            entry={entry}
            editable={list.editable}
            busy={busy}
            change={list.editable ? changes[entry.name] : undefined}
            edit={(value) => {
              setFeedback((current) => (current === "conflict" || current === "saveError" ? current : undefined));
              setChanges((current) => {
                const next = { ...current };
                if (value === undefined) delete next[entry.name];
                else next[entry.name] = value;
                return next;
              });
            }}
            reveal={(signal) => client.revealCredential!(entry.name, list.revision, signal)}
            notify={setFeedback}
          />
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        <p className="mr-auto text-sm text-muted-foreground" role="status">
          {feedback && (
            <span className="inline-flex items-center gap-1">
              {(feedback === "saved" || feedback === "copied") && <Check className="size-4" aria-hidden="true" />}
              {t[feedback]}
            </span>
          )}
        </p>
        <Button
          variant="outline"
          disabled={!list.editable || busy}
          onClick={() => {
            reset();
            setFeedback(undefined);
            void load();
          }}
        >
          {t.cancel}
        </Button>
        <Button
          type="submit"
          disabled={
            !list.editable ||
            busy ||
            feedback === "conflict" ||
            feedback === "saveError" ||
            !Object.keys(changes).length
          }
        >
          {busy && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {t.save}
        </Button>
      </div>
    </form>
  );
}
