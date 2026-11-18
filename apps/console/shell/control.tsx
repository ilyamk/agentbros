/**
 * Pause, resume and stop (RFC 0004 D12, US7): a dialog asks for the user's words, prefilled in the UI language (D10),
 * then `POST /api/projects/:id/control`. A stop then lists the running paid jobs to cancel one by one (A9,
 * paid-jobs.tsx); while the project stays stopped with jobs in flight, "Paid jobs" reopens that list.
 */
import { useId, useState } from "react";
import type { ControlState, ProjectView } from "@contract";
import { CirclePause, CirclePlay, CircleStop, Coins } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { asFailure } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PaidJobs, inFlightJobs, type StopListing } from "./paid-jobs";

const ACTION = {
  paused: { Icon: CirclePause, verb: "pause", title: "pauseTitle", body: "pauseBody" },
  running: { Icon: CirclePlay, verb: "resume", title: "resumeTitle", body: "resumeBody" },
  stopped: { Icon: CircleStop, verb: "stop", title: "stopTitle", body: "stopBody" },
} as const;

export function ControlButtons({ view, compact }: { view: ProjectView; compact?: boolean }) {
  const { d } = useI18n();
  const [target, setTarget] = useState<ControlState | null>(null);
  const [jobsOpen, setJobsOpen] = useState(false);
  const state = view.control.state;
  const inFlight = state === "stopped" ? inFlightJobs(view).length : 0;
  const targets: ControlState[] =
    state === "running" ? ["paused", "stopped"] : state === "paused" ? ["running", "stopped"] : ["running"];
  return (
    <div role="group" aria-label={d.control.label} className="flex items-center gap-1">
      {targets.map((next) => {
        const { Icon, verb } = ACTION[next];
        return (
          <Button
            key={next}
            variant={next === "stopped" ? "outline" : "secondary"}
            size={compact ? "icon-sm" : "sm"}
            aria-label={compact ? d.control[verb] : undefined}
            title={d.control[verb]}
            data-control={next}
            onClick={() => setTarget(next)}
          >
            <Icon aria-hidden="true" />
            {compact ? null : d.control[verb]}
          </Button>
        );
      })}
      {inFlight ? (
        <Button
          variant="outline"
          size={compact ? "icon-sm" : "sm"}
          aria-label={compact ? d.control.jobs.open : undefined}
          title={d.control.jobs.open}
          data-paid-jobs-open
          onClick={() => setJobsOpen(true)}
        >
          <Coins aria-hidden="true" />
          {compact ? null : `${d.control.jobs.open} (${inFlight})`}
        </Button>
      ) : null}
      {target ? <ControlDialog view={view} target={target} onClose={() => setTarget(null)} /> : null}
      {jobsOpen ? (
        <Dialog open onOpenChange={(open) => (!open ? setJobsOpen(false) : undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{d.control.jobs.title}</DialogTitle>
              <DialogDescription>{d.control.stopBody}</DialogDescription>
            </DialogHeader>
            <PaidJobs view={view} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setJobsOpen(false)}>
                {d.app.close}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function ControlDialog({ view, target, onClose }: { view: ProjectView; target: ControlState; onClose: () => void }) {
  const { d, f, p } = useI18n();
  const store = useConsoleStore();
  const id = useId();
  const [words, setWords] = useState(d.control.phrases[target]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const [listing, setListing] = useState<StopListing>();
  const action = ACTION[target];

  const submit = async () => {
    if (!words.trim()) {
      setError(d.decision.emptyWords);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const reply = await store.control(view.project.id, { state: target, answer: words });
      if (!reply.ok) {
        const message = reply.result?.message ?? reply.result?.error ?? "";
        setError(f(d.control.failed, { message }));
        store.notify({ tone: "error", title: d.notices.control, text: message });
        return;
      }
      const done = f(d.control.done, { state: d.control[reply.control.state] });
      const jobs = reply.runningJobs?.length ? p(d.control.runningJobs, reply.runningJobs.length) : undefined;
      store.notify({ tone: "success", title: d.notices.control, text: [done, jobs].filter(Boolean).join(" ") });
      const metadata = reply.result?.metadata ?? {};
      const omitted = Array.isArray(metadata["runningJobsOmitted"]) ? metadata["runningJobsOmitted"].length : 0;
      const listError = typeof metadata["runningJobsError"] === "string" ? metadata["runningJobsError"] : undefined;
      // A stop lists what is in flight (D12): the user cancels each job separately below.
      if (reply.control.state === "stopped" && (jobs || omitted || listError)) {
        setResult(jobs ? `${done} ${jobs}` : done);
        setListing({ jobs: reply.runningJobs ?? [], ...(listError ? { error: listError } : {}), omitted });
      } else if (jobs) setResult(`${done} ${jobs}`);
      else onClose();
    } catch (failure) {
      const message = asFailure(failure).message;
      setError(f(d.control.failed, { message }));
      store.notify({ tone: "error", title: d.notices.control, text: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <action.Icon className="size-5" aria-hidden="true" />
            {d.control[action.title]}
          </DialogTitle>
          <DialogDescription>{d.control[action.body]}</DialogDescription>
        </DialogHeader>
        {result ? null : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-words`} className="text-sm font-medium">
              {d.decision.yourWords}
            </label>
            <Textarea
              id={`${id}-words`}
              value={words}
              onChange={(event) => setWords(event.target.value)}
              disabled={busy}
              rows={2}
            />
          </div>
        )}
        <p role="status" aria-live="polite" className="text-sm empty:hidden">
          {error ? <span className="text-status-blocked">{error}</span> : null}
          {result}
        </p>
        {listing ? <PaidJobs view={view} listing={listing} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {result ? d.app.close : d.app.cancel}
          </Button>
          {result ? null : (
            <Button
              variant={target === "stopped" ? "destructive" : "default"}
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? d.decision.sending : d.control[action.verb]}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
