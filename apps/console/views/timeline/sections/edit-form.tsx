/**
 * The selected clip and the operation form (RU-T03–T10, RU-P01–P05, RU-AU01–AU04). Field ids are review:ui's
 * (`#edit-start`, `#transfer-num`, `#copy-headline`, `#reframe-x`, `#split-at-num`, …); every input or change goes
 * through `session.setField`, which cancels the proposal (RU-K08). The form is keyed on `snap.formKey`, so it is
 * rebuilt with fresh defaults whenever the selection, the operation or the displayed state changes.
 */
import type { ReactNode } from "react";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, Textarea } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  COPY_LIMITS,
  currentClip,
  isOperation,
  number,
  OPERATIONS,
  REFRAME_FORMATS,
  unsupportedReason,
  type Operation,
} from "./edit-commands";
import type { EditPartProps } from "./edit-session";

function Field({
  id,
  label,
  type = "text",
  value,
  onChange,
  ...rest
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  step?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} {...rest} />
    </div>
  );
}

function Notice({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-sm text-muted-foreground sm:col-span-2">
      {children}
    </p>
  );
}

export function OperationForm({ state, session, snap, t }: EditPartProps) {
  const { f } = useI18n();
  const { selected, operation, values } = snap;
  let target: ReturnType<typeof currentClip> | undefined;
  try {
    target = selected ? currentClip(state, selected) : undefined;
  } catch {
    target = undefined;
  }
  const str = (id: string) => (typeof values[id] === "string" ? (values[id] as string) : "");
  const set = (id: string) => (value: string) => session.setField(id, value);
  const field = (id: string, label: string, type = "number") => (
    <Field key={id} id={id} label={label} type={type} value={str(id)} onChange={set(id)} />
  );

  const fields = (): ReactNode => {
    if (!target) return null;
    const { track, clip } = target;
    const reason = unsupportedReason(operation, track, clip);
    if (reason) return <Notice>{t.unsupported[reason]}</Notice>;
    const fl = t.field;
    switch (operation) {
      case "move":
        return field("edit-start", fl.moveStart);
      case "trim":
        return [field("edit-start", fl.sourceStart), field("edit-end", fl.sourceEnd)];
      case "rate":
        return [field("rate-num", fl.rateNum), field("rate-den", fl.rateDen)];
      case "transition":
        return field("fade-frames", fl.fadeFrames);
      case "captions":
        return (clip.captions ?? []).map((caption, i) =>
          field(
            `caption-${i}`,
            f(fl.caption, { n: i + 1, start: number(caption.start), end: number(caption.end) }),
            "text",
          ),
        );
      case "transfer": {
        const targets = state.tracks.filter((other) => other.kind === "visual" && other.id !== track.id);
        return [
          <div key="target" className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="target-track">{fl.targetTrack}</Label>
            <SelectField
              id="target-track"
              value={str("target-track")}
              onValueChange={(value) => session.setField("target-track", value)}
              options={targets.map((other) => ({ value: other.id, label: other.id }))}
            />
          </div>,
          field("transfer-num", fl.outputStartNum),
          field("transfer-den", fl.outputStartDen),
        ];
      }
      case "authored-copy":
        return [
          <Notice key="notice">{t.notice.authoredCopy}</Notice>,
          ...(["headline", "subtext"] as const).map((key) => (
            <div key={key} className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={`copy-${key}-mode`}>{f(fl.copyMode, { field: fl.copyField[key] })}</Label>
              <SelectField
                id={`copy-${key}-mode`}
                value={str(`copy-${key}-mode`)}
                onValueChange={(value) => session.setField(`copy-${key}-mode`, value)}
                options={(key === "subtext" ? (["keep", "set", "remove"] as const) : (["keep", "set"] as const)).map(
                  (choice) => ({ value: choice, label: fl.copyChoice[choice] }),
                )}
              />
              <Label htmlFor={`copy-${key}`} className="sr-only">
                {f(fl.copyText, { field: fl.copyField[key] })}
              </Label>
              <Textarea
                id={`copy-${key}`}
                value={str(`copy-${key}`)}
                maxLength={COPY_LIMITS[key]}
                rows={key === "headline" ? 3 : 4}
                onChange={(event) => session.setField(`copy-${key}`, event.target.value)}
              />
            </div>
          )),
        ];
      case "visual-reframe":
        return [
          <div key="format" className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="reframe-format">{fl.format}</Label>
            <SelectField
              id="reframe-format"
              value={str("reframe-format")}
              onValueChange={(value) => session.setField("reframe-format", value)}
              options={REFRAME_FORMATS.map((name) => ({ value: name, label: fl.formats[name] }))}
            />
          </div>,
          field("reframe-x", fl.reframeX),
          field("reframe-y", fl.reframeY),
          <Label key="reset" htmlFor="reframe-reset" className="sm:col-span-2">
            <Checkbox
              id="reframe-reset"
              checked={values["reframe-reset"] === true}
              onCheckedChange={(checked) => session.setField("reframe-reset", checked === true)}
            />
            {fl.reframeReset}
          </Label>,
          <Notice key="notice">{t.notice.reframe}</Notice>,
        ];
      case "visual-remove":
        return <Notice>{t.notice.remove}</Notice>;
      case "visual-slip":
        return [
          <Notice key="notice">{t.notice.slip}</Notice>,
          field("slip-num", fl.slipNum),
          field("slip-den", fl.slipDen),
        ];
      case "visual-split":
        return [
          <Notice key="notice">{t.notice.split}</Notice>,
          field("split-at-num", fl.splitNum),
          field("split-at-den", fl.splitDen),
          field("split-right-id", fl.splitId, "text"),
        ];
      case "audio-position":
      case "audio-trim": {
        const output = state.timebase ? `${state.timebase.num}/${state.timebase.den}` : "?";
        const source = `${clip.source.timebase.num}/${clip.source.timebase.den}`;
        return [
          <Notice key="notice" id="audio-position-notice">
            {t.notice.audioPosition}
          </Notice>,
          <Notice key="clocks">{f(t.notice.audioClocks, { output, source })}</Notice>,
          ...(operation === "audio-position"
            ? [field("audio-position-num", fl.outputStartNum), field("audio-position-den", fl.outputStartDen)]
            : [
                field("audio-source-start-num", fl.audioSourceStartNum),
                field("audio-source-start-den", fl.audioSourceStartDen),
                field("audio-source-end-num", fl.audioSourceEndNum),
                field("audio-source-end-den", fl.audioSourceEndDen),
              ]),
        ];
      }
      case "audio-gain": {
        const gain = clip.payload?.audioGain;
        const shown = typeof gain === "number" ? gain : 1;
        return [
          <Notice key="notice" id="audio-mix-notice">
            {t.notice.audioMix}
          </Notice>,
          <Field
            key="gain"
            id="audio-gain"
            label={fl.gain}
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={str("audio-gain")}
            onChange={set("audio-gain")}
          />,
          <Notice key="current">{f(gain === 0 ? fl.currentGainMuted : fl.currentGain, { gain: shown })}</Notice>,
          <div key="quick" className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void session.prepareGain(0)}>
              {fl.prepareMute}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void session.prepareGain(null)}>
              {fl.prepareGainReset}
            </Button>
          </div>,
        ];
      }
      case "audio-loop":
        return [
          <Notice key="notice" id="audio-mix-notice">
            {t.notice.audioMix}
          </Notice>,
          <Notice key="loop">{t.notice.loop}</Notice>,
          <div key="select" className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="audio-loop">{fl.loop}</Label>
            <SelectField
              id="audio-loop"
              value={str("audio-loop")}
              onValueChange={(value) => session.setField("audio-loop", value)}
              options={[
                { value: "", label: fl.loopChoice.default },
                { value: "true", label: fl.loopChoice.on },
                { value: "false", label: fl.loopChoice.off },
              ]}
            />
          </div>,
        ];
    }
  };

  const selection = target
    ? f(t.selection, { kind: target.track.kind, clip: target.clip.id, asset: target.clip.assetId })
    : t.selectClip;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h4 className="text-sm font-semibold">{t.selected}</h4>
      <p id="selection" className={cn("text-sm wrap-anywhere", !target && "text-muted-foreground")}>
        {selection}
      </p>
      <div className="flex max-w-md min-w-0 flex-col gap-1">
        <Label htmlFor="operation">{t.operation}</Label>
        <SelectField
          id="operation"
          value={operation}
          onValueChange={(value) => {
            if (isOperation(value)) void session.setOperation(value as Operation);
          }}
          options={OPERATIONS.map((name) => ({ value: name, label: t.operations[name] }))}
        />
      </div>
      <div
        id="fields"
        key={snap.formKey}
        role="group"
        aria-label={t.fields}
        className="grid min-w-0 gap-3 sm:grid-cols-2"
      >
        {fields()}
      </div>
      <div>
        <Button id="prepare" type="button" onClick={() => void session.prepare()}>
          {t.prepare}
        </Button>
      </div>
    </div>
  );
}
