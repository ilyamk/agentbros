/**
 * Timeline section: snapshots and takes (RU-N01–N05, the review:ui parity checklist), as review:ui did it
 * (client:573-574, 502-515, 526-530, 652-679):
 *
 * - Save exact snapshot: `mutate {action:'snapshot', expectedRevision, label}`; the service is idempotent per timeline.
 * - The list shows `label · revision N · fullhash`, plus `createdAt` and the duration (returned, never shown before).
 * - Left and Right hold `current` plus every snapshot; a choice survives a refresh while it still exists.
 * - Compare shows `{equal, leftHash, rightHash}` and each side's clips.
 * - Choose uses Right, refuses `current`, appends a review choice; the last one is shown with `matchesCurrent`.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { useI18n } from "@/i18n";
import { formatTime } from "@/lib/format";
import type { CompareResult, ReviewState } from "../api";
import { TimelineSection, type TimelineSectionProps } from "../section";
import { Field, frameNumber, JsonBlock } from "./review-kit";

const CURRENT = "current";

/** The select's value after a refresh: kept while the take still exists, else the current revision (client:513). */
export function keptTake(value: string, state: Pick<ReviewState, "snapshots">): string {
  return value === CURRENT || state.snapshots.some((snapshot) => snapshot.hash === value) ? value : CURRENT;
}

export function SnapshotsSection({ state, api, controller }: TimelineSectionProps) {
  const { d, f, locale } = useI18n();
  const t = d.timeline.snapshots;
  const [label, setLabel] = useState("");
  const [actor, setActor] = useState("");
  const [left, setLeft] = useState(CURRENT);
  const [right, setRight] = useState(CURRENT);
  const [comparison, setComparison] = useState<CompareResult>();
  const leftValue = keptTake(left, state);
  const rightValue = keptTake(right, state);
  const busy = controller.getSnapshot().status.kind === "working";

  /** Sends a snapshot or choice at the revision shown now (CAS) and displays the state the service read back. */
  const send = async (
    body: { action: "snapshot"; label: string } | { action: "choose"; snapshotHash: string; actor: string },
  ) => {
    const revision = controller.getSnapshot().state?.revision ?? null;
    if (revision === null) throw new Error(d.timeline.common.uninitializedTitle);
    controller.display(await api.mutate({ ...body, expectedRevision: revision }));
  };
  const save = () => void controller.run(() => send({ action: "snapshot", label }));
  const choose = () =>
    void controller.run(async () => {
      if (rightValue === CURRENT) throw new Error(t.chooseCurrent);
      await send({ action: "choose", snapshotHash: rightValue, actor });
    });
  const compare = () =>
    void controller.run(async () => {
      setComparison(await api.compare(leftValue, rightValue));
    });

  const option = (value: string) =>
    value === CURRENT
      ? state.revision === null
        ? t.currentNone
        : f(t.current, { revision: String(state.revision) })
      : (() => {
          const snapshot = state.snapshots.find((s) => s.hash === value)!;
          return f(t.option, { label: snapshot.label, hash: snapshot.hash.slice(0, 12) });
        })();
  const options = [CURRENT, ...state.snapshots.map((snapshot) => snapshot.hash)];
  const selected = state.selected;

  return (
    <TimelineSection id="snapshots" title={t.title} description={t.description}>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="min-w-0 flex-1">
          <Field htmlFor="label" label={t.label}>
            <Input
              id="label"
              value={label}
              maxLength={160}
              placeholder={t.labelPlaceholder}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
        </div>
        <Button id="snapshot" type="submit" disabled={busy || state.revision === null}>
          {t.save}
        </Button>
      </form>

      <div>
        <h4 className="text-sm font-medium">{t.list}</h4>
        <ul id="snapshots" className="flex flex-col gap-1 text-sm">
          {state.snapshots.length === 0 ? <li className="text-muted-foreground">{t.none}</li> : null}
          {state.snapshots.map((snapshot) => (
            <li key={snapshot.hash} className="min-w-0">
              <p className="wrap-anywhere">
                {f(t.row, { label: snapshot.label, revision: snapshot.revision, hash: snapshot.hash })}
              </p>
              <p className="text-xs text-muted-foreground">
                {f(t.rowMeta, {
                  createdAt: formatTime(snapshot.createdAt, locale, true),
                  frames: snapshot.durationInFrames,
                })}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ["left", leftValue, setLeft, t.left],
            ["right", rightValue, setRight, t.right],
          ] as const
        ).map(([side, value, set, title]) => (
          <Field key={side} htmlFor={side} label={title}>
            <SelectField
              id={side}
              value={value}
              onValueChange={set}
              options={options.map((take) => ({ value: take, label: option(take) }))}
            />
          </Field>
        ))}
      </div>
      <div>
        <Button id="compare" variant="outline" onClick={compare} disabled={busy}>
          {t.compare}
        </Button>
      </div>
      {comparison ? (
        <div className="flex min-w-0 flex-col gap-2">
          <JsonBlock
            id="comparison"
            value={{ equal: comparison.equal, leftHash: comparison.left.hash, rightHash: comparison.right.hash }}
          />
          <div id="take-comparison" className="grid min-w-0 gap-2 sm:grid-cols-2">
            {(["left", "right"] as const).map((side) => {
              const take = comparison[side];
              return (
                <article key={side} className="min-w-0 rounded-md border p-2 text-sm wrap-anywhere">
                  <strong>{f(t.sideHeading, { side: t.side[side], revision: take.revision })}</strong>
                  <p className="font-mono text-xs">{take.hash}</p>
                  {take.timeline.tracks.flatMap((track) =>
                    track.clips.map((clip) => (
                      <p key={`${track.id}/${clip.id}`}>
                        {f(t.clipRow, {
                          kind: track.kind,
                          id: clip.id,
                          start: frameNumber(clip.start),
                          end: frameNumber(clip.end),
                          asset: clip.assetId,
                        })}
                      </p>
                    )),
                  )}
                </article>
              );
            })}
          </div>
        </div>
      ) : null}

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          choose();
        }}
      >
        <div className="min-w-0 flex-1">
          <Field htmlFor="actor" label={t.actor}>
            <Input
              id="actor"
              value={actor}
              maxLength={160}
              placeholder={t.actorPlaceholder}
              onChange={(event) => setActor(event.target.value)}
            />
          </Field>
        </div>
        <Button id="choose" type="submit" variant="outline" disabled={busy || state.revision === null}>
          {t.choose}
        </Button>
      </form>
      <JsonBlock
        id="choice"
        aria-live="polite"
        value={
          selected
            ? { ...selected, matchesCurrent: selected.snapshotHash === state.timelineHash, notice: t.choiceNotice }
            : t.noChoice
        }
      />
    </TimelineSection>
  );
}
