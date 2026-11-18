/**
 * Timeline section: the offline realtime editor (RU-R), its finite local channel (RU-RC) and drafts from a registered
 * still (RU-RS), the review:ui parity checklist. The rules live in `realtime-controller.ts` (state machine) and
 * `realtime-model.ts` (pure); this file renders the snapshot. The panel is a `<details id="realtime-panel">`, closed by
 * default; element ids keep review:ui's `rt-*` names. Nothing here connects a provider or executes generation.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Disclosure } from "@/components/ui/disclosure";
import { Input, Textarea } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { TimelineSection, type TimelineSectionProps } from "../section";
import { RealtimeEditorController, type RealtimeSnapshot } from "./realtime-controller";
import {
  displayText,
  STILL_DEFAULTS,
  stillLabel,
  type DeriveForm,
  type DisplayValue,
  type StillForm,
} from "./realtime-model";

type Strings = ReturnType<typeof useI18n>["d"]["timeline"]["realtime"];

const preClass =
  "max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap break-all";

/** Every form control inside `root` passes its HTML constraints (review:ui's `checkValidity()` gate). */
const controlsValid = (root: HTMLElement | null) =>
  !!root &&
  [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")].every(
    (element) => element.checkValidity(),
  );

/** Buttons wrap their (long, translated) labels instead of widening the page at 390 px. */
function WrapButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button className={cn("h-auto min-h-9 max-w-full py-1.5 whitespace-normal break-words", className)} {...props} />
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function Pre({ id, label, value }: { id: string; label: string; value: DisplayValue }) {
  const text = displayText(value);
  return (
    <pre id={id} role="region" aria-label={label} tabIndex={text ? 0 : -1} className={cn(preClass, !text && "hidden")}>
      {text}
    </pre>
  );
}

function Sub({ heading, intro, children }: { heading: string; intro?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t pt-3">
      <h4 className="text-sm font-semibold">{heading}</h4>
      {intro ? <p className="text-sm text-muted-foreground">{intro}</p> : null}
      {children}
    </div>
  );
}

export function RealtimeSection({ api }: TimelineSectionProps) {
  const { d } = useI18n();
  const t = d.timeline.realtime;
  const initialMessages = useRef(t.msg).current;
  const controller = useMemo(
    () => new RealtimeEditorController({ api, messages: initialMessages }),
    [api, initialMessages],
  );
  useEffect(() => {
    controller.messages = t.msg;
  }, [controller, t.msg]);
  useEffect(() => {
    controller.attach();
    const onVisibility = () => controller.visibilityChanged();
    const onPageHide = () => controller.pageHidden();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      controller.dispose();
    };
  }, [controller]);
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  return (
    <TimelineSection id="realtime" title={t.title} description={t.description}>
      <Disclosure
        id="realtime-panel"
        summary={t.panel}
        contentClassName="mt-0"
        onToggle={(event) => controller.setPanelOpen(event.currentTarget.open)}
      >
        <RealtimeBody s={s} t={t} controller={controller} fileUrl={(file) => api.fileUrl(file)} />
      </Disclosure>
    </TimelineSection>
  );
}

function RealtimeBody({
  s,
  t,
  controller,
  fileUrl,
}: {
  s: RealtimeSnapshot;
  t: Strings;
  controller: RealtimeEditorController;
  fileUrl: (file: string) => string;
}) {
  const { f } = useI18n();
  const off = s.disabled;
  const [newId, setNewId] = useState("");
  const [ceiling, setCeiling] = useState("1");
  const [session, setSession] = useState("");
  const [request, setRequest] = useState("");
  const [requestFile, setRequestFile] = useState("");
  const [completeRevision, setCompleteRevision] = useState("");
  const [manifest, setManifest] = useState("");

  return (
    <div className="mt-3 flex min-w-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t.intro}</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field label={t.editor} htmlFor="rt-editor">
          <SelectField
            id="rt-editor"
            value={s.selectedEditor}
            disabled={off.editor}
            onValueChange={(value) => controller.selectEditor(value)}
            placeholder={t.noEditorsOption}
            options={[
              ...(s.editors.length ? [] : [{ value: "", label: t.noEditorsOption }]),
              ...s.editors.map((editor) => ({
                value: editor.editorId,
                label: f(t.editorOption, { editor: editor.editorId, sequence: editor.sequence }),
              })),
            ]}
          />
        </Field>
        <WrapButton
          id="rt-refresh"
          type="button"
          variant="outline"
          disabled={off.refresh}
          onClick={() => controller.refreshClicked()}
        >
          <RefreshCw aria-hidden="true" />
          {t.refreshEditor}
        </WrapButton>
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-end">
        <Field label={t.newEditor} htmlFor="rt-new-id">
          <Input
            id="rt-new-id"
            placeholder={t.newEditorPlaceholder}
            maxLength={101}
            value={newId}
            onChange={(e) => setNewId(e.currentTarget.value)}
          />
        </Field>
        <Field label={t.ceiling} htmlFor="rt-ceiling">
          <Input
            id="rt-ceiling"
            type="number"
            min="0.01"
            step="0.01"
            value={ceiling}
            onChange={(e) => setCeiling(e.currentTarget.value)}
          />
        </Field>
        <WrapButton
          id="rt-create"
          type="button"
          disabled={off.create}
          onClick={() => void controller.create(newId, Number(ceiling))}
        >
          {t.create}
        </WrapButton>
      </div>
      <output
        id="rt-status"
        role="status"
        aria-label={t.statusLabel}
        data-tone={s.status.tone}
        className={cn(
          "block min-h-6 text-sm whitespace-pre-wrap break-words",
          s.status.tone === "error" && "text-destructive",
        )}
      >
        {displayText(s.status.value)}
      </output>
      <Pre id="rt-summary" label={t.summaryLabel} value={s.summary} />

      <Sub heading={t.channel.heading} intro={t.channel.intro}>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <Field label={t.channel.session} htmlFor="rt-channel-session">
              <Input
                id="rt-channel-session"
                maxLength={100}
                placeholder={t.channel.sessionPlaceholder}
                value={session}
                onChange={(e) => setSession(e.currentTarget.value)}
              />
            </Field>
          </div>
          <WrapButton
            id="rt-channel-open"
            type="button"
            disabled={off.channelOpen}
            onClick={() => void controller.openChannel(session)}
          >
            {t.channel.open}
          </WrapButton>
          <WrapButton
            id="rt-channel-close"
            type="button"
            variant="outline"
            disabled={off.channelClose}
            onClick={() => controller.closeChannel()}
          >
            {t.channel.close}
          </WrapButton>
          <WrapButton
            id="rt-channel-status"
            type="button"
            variant="outline"
            disabled={off.channelStatus}
            onClick={() => controller.inspectChannel()}
          >
            {t.channel.inspect}
          </WrapButton>
        </div>
        <output
          id="rt-channel-summary"
          tabIndex={displayText(s.channel.summary) ? 0 : -1}
          role="status"
          aria-label={t.channel.summaryLabel}
          className={cn(preClass, "block", !displayText(s.channel.summary) && "hidden")}
        >
          {displayText(s.channel.summary)}
        </output>
        <div id="rt-channel-unresolved" className="flex flex-wrap gap-2">
          {s.channel.unresolved.map((item) => (
            <WrapButton
              key={`${item.localSessionId}/${item.messageId}`}
              type="button"
              variant="destructive"
              className="h-auto max-w-full whitespace-normal break-all text-start"
              disabled={off.reconcile}
              onClick={() => void controller.reconcile(item)}
            >
              {f(t.channel.acknowledge, { session: item.localSessionId, message: item.messageId })}
            </WrapButton>
          ))}
        </div>
      </Sub>

      <Sub heading={t.add.heading} intro={t.add.intro}>
        <Textarea
          id="rt-request"
          aria-label={t.add.request}
          rows={6}
          placeholder={t.add.requestPlaceholder}
          className="font-mono text-xs"
          value={request}
          onChange={(e) => setRequest(e.currentTarget.value)}
        />
        <div className="flex flex-wrap gap-2">
          <WrapButton id="rt-add" type="button" disabled={off.add} onClick={() => void controller.addInline(request)}>
            {t.add.inline}
          </WrapButton>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Input
            id="rt-request-file"
            aria-label={t.add.file}
            placeholder={t.add.filePlaceholder}
            className="min-w-0 flex-1 basis-56"
            value={requestFile}
            onChange={(e) => setRequestFile(e.currentTarget.value)}
          />
          <WrapButton
            id="rt-add-file"
            type="button"
            variant="outline"
            disabled={off.addFile}
            onClick={() => void controller.addFile(requestFile)}
          >
            {t.add.fromFile}
          </WrapButton>
        </div>
      </Sub>

      <StillDraft s={s} t={t} controller={controller} />

      <DeriveFields key={s.composer?.stamp ?? 0} s={s} t={t} controller={controller} />

      <Sub heading={t.revisions.heading}>
        <div id="rt-revisions" className="flex min-w-0 flex-col gap-2">
          {s.current && !s.current.revisions.length ? (
            <p className="text-sm text-muted-foreground">{t.revisions.none}</p>
          ) : null}
          {s.current?.revisions.map((revision) => (
            <article
              key={revision.revisionId}
              data-revision={revision.revisionId}
              aria-label={f(t.revisions.title, { revision: revision.revisionId, status: revision.status })}
              className="flex min-w-0 flex-col gap-1 rounded-lg border p-3 text-sm"
            >
              <strong className="break-all">
                {f(t.revisions.title, { revision: revision.revisionId, status: revision.status })}
              </strong>
              <p className="break-all">
                {f(t.revisions.session, { session: revision.sessionId, high: revision.highUsd })}
              </p>
              <p className="font-mono text-xs break-all">{f(t.revisions.input, { hash: revision.inputHash })}</p>
              <p className="font-mono text-xs break-all">{f(t.revisions.request, { sha: revision.request.sha256 })}</p>
              {revision.result ? (
                <p className="font-mono text-xs break-all">
                  {f(t.revisions.manifest, { sha: revision.result.sha256 })}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-1">
                <WrapButton
                  size="sm"
                  type="button"
                  data-action="queue"
                  disabled={off.revision(revision, "queue")}
                  onClick={() => void controller.mutate("queue", { revisionId: revision.revisionId })}
                >
                  {t.revisions.queue}
                </WrapButton>
                <WrapButton
                  size="sm"
                  type="button"
                  variant="outline"
                  data-action="inspect"
                  disabled={off.revision(revision, "inspect")}
                  onClick={() => void controller.inspectRequest(revision.revisionId)}
                >
                  {t.revisions.inspect}
                </WrapButton>
                <WrapButton
                  size="sm"
                  type="button"
                  variant="outline"
                  data-action="derive"
                  disabled={off.revision(revision, "derive")}
                  onClick={() => void controller.editRequest(revision.revisionId)}
                >
                  {t.revisions.edit}
                </WrapButton>
                <WrapButton
                  size="sm"
                  type="button"
                  variant="outline"
                  data-action="select"
                  disabled={off.revision(revision, "select")}
                  onClick={() => void controller.mutate("select", { revisionId: revision.revisionId })}
                >
                  {t.revisions.select}
                </WrapButton>
              </div>
            </article>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <WrapButton
            id="rt-handoff"
            type="button"
            disabled={off.handoff}
            onClick={() => void controller.mutate("handoff")}
          >
            {t.handoff}
          </WrapButton>
          <WrapButton
            id="rt-cancel"
            type="button"
            variant="outline"
            disabled={off.cancel}
            onClick={() => void controller.mutate("cancel")}
          >
            {t.cancel}
          </WrapButton>
          <WrapButton
            id="rt-recover"
            type="button"
            variant="outline"
            disabled={off.recover}
            onClick={() => void controller.mutate("recover")}
          >
            {t.recover}
          </WrapButton>
        </div>
      </Sub>

      <Sub heading={t.complete.heading}>
        <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
          <Input
            id="rt-complete-revision"
            aria-label={t.complete.revision}
            placeholder={t.complete.revisionPlaceholder}
            value={completeRevision}
            onChange={(e) => setCompleteRevision(e.currentTarget.value)}
          />
          <Input
            id="rt-manifest"
            aria-label={t.complete.manifest}
            placeholder={t.complete.manifestPlaceholder}
            value={manifest}
            onChange={(e) => setManifest(e.currentTarget.value)}
          />
          <WrapButton
            id="rt-complete"
            type="button"
            disabled={off.complete}
            onClick={() => void controller.mutate("complete", { revisionId: completeRevision, manifest })}
          >
            {t.complete.attach}
          </WrapButton>
        </div>
        <Pre id="rt-request-detail" label={t.requestDetail} value={s.requestDetail as DisplayValue} />
      </Sub>

      <Sub heading={t.preview.heading} intro={t.preview.note}>
        <div id="rt-preview" className="grid min-w-0 gap-3 sm:grid-cols-2">
          {s.current?.frames.length ? (
            s.current.frames.map((frame, index) => (
              <figure key={frame.file} className="flex min-w-0 flex-col gap-1">
                <img
                  src={fileUrl(frame.file)}
                  alt={f(t.preview.alt, { index: index + 1 })}
                  className="max-h-80 w-auto max-w-full rounded-md border object-contain"
                />
                <figcaption className="font-mono text-xs break-all">
                  {f(t.preview.original, { sha: frame.sha256 })}
                </figcaption>
              </figure>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">{t.preview.none}</p>
          )}
        </div>
      </Sub>
    </div>
  );
}

/** review:ui's element ids for the still form's controls. */
const STILL_IDS: Record<keyof StillForm, string> = {
  revisionId: "rt-still-revision",
  sessionId: "rt-still-session",
  prompt: "rt-still-prompt",
  seed: "rt-still-seed",
  bound: "rt-still-bound",
  frames: "rt-still-frames",
  inputBytes: "rt-still-input-bytes",
  responseBytes: "rt-still-response-bytes",
  controls: "rt-still-controls",
  timeoutMs: "rt-still-timeout",
};

function StillDraft({ s, t, controller }: { s: RealtimeSnapshot; t: Strings; controller: RealtimeEditorController }) {
  const [form, setForm] = useState<StillForm>(STILL_DEFAULTS);
  const fields = useRef<HTMLFieldSetElement>(null);
  const still = s.still;
  const fieldsOff =
    still.pending ||
    !still.ready ||
    !still.context ||
    !still.sources.some((source) => source.assetId === still.selected);
  const set = (key: keyof StillForm) => (event: { currentTarget: { value: string } }) => {
    const value = event.currentTarget.value;
    setForm((old) => ({ ...old, [key]: value }));
  };
  const num = (key: keyof StillForm, label: string, min: string, max?: string) => (
    <Field label={label} htmlFor={STILL_IDS[key]}>
      <Input
        id={STILL_IDS[key]}
        required
        type="number"
        min={min}
        max={max}
        step={max ? "1" : "any"}
        value={form[key]}
        onChange={set(key)}
      />
    </Field>
  );
  return (
    <Sub heading={t.still.heading} intro={t.still.intro}>
      <div className="grid min-w-0 gap-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end">
        <WrapButton
          id="rt-still-refresh"
          type="button"
          variant="outline"
          disabled={still.pending || !still.ready}
          onClick={() => void controller.loadStills()}
        >
          {t.still.load}
        </WrapButton>
        <Field label={t.still.source} htmlFor="rt-still-source">
          <SelectField
            id="rt-still-source"
            disabled={still.pending || !still.ready || !still.context}
            value={still.selected}
            onValueChange={(value) => controller.chooseStill(value)}
            placeholder={t.still.sourcePlaceholder}
            options={[
              ...(still.context ? [{ value: "", label: t.still.sourcePlaceholder }] : []),
              ...still.sources.map((source) => ({ value: source.assetId, label: stillLabel(source) })),
            ]}
          />
        </Field>
      </div>
      <Pre id="rt-still-summary" label={t.still.summaryLabel} value={still.summary} />
      <fieldset
        ref={fields}
        id="rt-still-fields"
        aria-label={t.still.fields}
        disabled={fieldsOff}
        className="grid min-w-0 gap-3 disabled:opacity-60 sm:grid-cols-2"
      >
        <Field label={t.still.revision} htmlFor="rt-still-revision">
          <Input id="rt-still-revision" required maxLength={100} value={form.revisionId} onChange={set("revisionId")} />
        </Field>
        <Field label={t.still.session} htmlFor="rt-still-session">
          <Input id="rt-still-session" required maxLength={100} value={form.sessionId} onChange={set("sessionId")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t.still.prompt} htmlFor="rt-still-prompt">
            <Textarea id="rt-still-prompt" required maxLength={4096} value={form.prompt} onChange={set("prompt")} />
          </Field>
        </div>
        <Field label={t.still.seed} htmlFor="rt-still-seed">
          <Input id="rt-still-seed" required type="number" min="0" step="1" value={form.seed} onChange={set("seed")} />
        </Field>
        <Field label={t.still.bound} htmlFor="rt-still-bound">
          <Input
            id="rt-still-bound"
            required
            type="number"
            min="0.000001"
            step="any"
            value={form.bound}
            onChange={set("bound")}
          />
        </Field>
        {num("frames", t.still.frames, "1", "2")}
        {num("inputBytes", t.still.inputBytes, "1", "4194304")}
        {num("responseBytes", t.still.responseBytes, "1", "16777216")}
        {num("controls", t.still.controls, "1", "64")}
        {num("timeoutMs", t.still.timeout, "50", "100000")}
        <div className="sm:col-span-2">
          <WrapButton
            id="rt-still-save"
            type="button"
            onClick={() => void controller.saveStill(form, controlsValid(fields.current))}
          >
            {t.still.save}
          </WrapButton>
        </div>
      </fieldset>
    </Sub>
  );
}

function DeriveFields({ s, t, controller }: { s: RealtimeSnapshot; t: Strings; controller: RealtimeEditorController }) {
  const prefill = s.composer?.prefill;
  const [form, setForm] = useState<DeriveForm>(
    prefill ?? {
      revisionId: "",
      sessionId: "",
      prompt: "",
      seed: "",
      steps: "3",
      scheduleMu: "2.3",
      feedback: "1",
      imageSize: "square",
      interpolation: false,
      bound: "",
    },
  );
  const fields = useRef<HTMLFieldSetElement>(null);
  const set = (key: keyof DeriveForm) => (event: { currentTarget: { value: string } }) => {
    const value = event.currentTarget.value;
    setForm((old) => ({ ...old, [key]: value }));
  };
  return (
    <Sub heading={t.derive.heading} intro={t.derive.intro}>
      <fieldset
        ref={fields}
        id="rt-derive-fields"
        aria-label={t.derive.fields}
        disabled={s.disabled.derive}
        className="grid min-w-0 gap-3 disabled:opacity-60 sm:grid-cols-2"
      >
        <Field label={t.derive.source} htmlFor="rt-derive-source">
          <Input id="rt-derive-source" readOnly value={s.composer?.sourceRevision ?? ""} />
        </Field>
        <Field label={t.derive.revision} htmlFor="rt-derive-revision">
          <Input
            id="rt-derive-revision"
            required
            maxLength={100}
            value={form.revisionId}
            onChange={set("revisionId")}
          />
        </Field>
        <Field label={t.derive.session} htmlFor="rt-derive-session">
          <Input id="rt-derive-session" required maxLength={100} value={form.sessionId} onChange={set("sessionId")} />
        </Field>
        <Field label={t.derive.seed} htmlFor="rt-derive-seed">
          <Input id="rt-derive-seed" required type="number" min="0" step="1" value={form.seed} onChange={set("seed")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t.derive.prompt} htmlFor="rt-derive-prompt">
            <Textarea id="rt-derive-prompt" required maxLength={4096} value={form.prompt} onChange={set("prompt")} />
          </Field>
        </div>
        <Field label={t.derive.steps} htmlFor="rt-derive-steps">
          <Input
            id="rt-derive-steps"
            required
            type="number"
            min="1"
            max="8"
            step="1"
            value={form.steps}
            onChange={set("steps")}
          />
        </Field>
        <Field label={t.derive.schedule} htmlFor="rt-derive-schedule">
          <Input
            id="rt-derive-schedule"
            required
            type="number"
            min="0.3"
            max="2.5"
            step="0.1"
            value={form.scheduleMu}
            onChange={set("scheduleMu")}
          />
        </Field>
        <Field label={t.derive.feedback} htmlFor="rt-derive-feedback">
          <Input
            id="rt-derive-feedback"
            required
            type="number"
            min="0"
            max="1"
            step="0.1"
            value={form.feedback}
            onChange={set("feedback")}
          />
        </Field>
        <Field label={t.derive.size} htmlFor="rt-derive-size">
          <SelectField
            id="rt-derive-size"
            value={form.imageSize}
            onValueChange={(value) => set("imageSize")({ currentTarget: { value } })}
            options={[
              { value: "square", label: "square" },
              { value: "square_hd", label: "square_hd" },
            ]}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox
            id="rt-derive-interpolation"
            checked={form.interpolation}
            onCheckedChange={(checked) => setForm((old) => ({ ...old, interpolation: checked === true }))}
          />
          {t.derive.interpolation}
        </label>
        <Field label={t.derive.bound} htmlFor="rt-derive-bound">
          <Input
            id="rt-derive-bound"
            required
            type="number"
            min="0.000001"
            step="any"
            value={form.bound}
            onChange={set("bound")}
          />
        </Field>
        <div className="flex items-end">
          <WrapButton
            id="rt-derive-save"
            type="button"
            onClick={() => void controller.saveDerive(form, controlsValid(fields.current))}
          >
            {t.derive.save}
          </WrapButton>
        </div>
      </fieldset>
    </Sub>
  );
}
