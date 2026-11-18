/**
 * The editing table (2026-11-18): the project's Timeline page (a campaign's review) opened in a new tab, and "Edit
 * myself", which also pauses the agent through the control API so the user's edits are not overwritten. The Timeline
 * page then shows {@link EditingBanner} until the user hands the project back (a resume with their words).
 *
 * The new tab is opened with `window.open(url, "_blank")` WITHOUT `noopener`, synchronously in the click handler: the
 * browser then copies this tab's sessionStorage, where the console keeps its session token (api/session.ts), so the new
 * tab is signed in without a token in its URL. A pause marks itself with {@link EDITING_TABLE_REASON} in the control
 * file's `reason`, which only the console reads: the banner shows only for that pause. Agents see the user's localized
 * words (`answer`) in the PAUSED message, which quotes `answer ?? reason`.
 */
import { useState } from "react";
import type { ProjectView } from "@contract";
import { ChevronDown, CirclePlay, PanelsTopLeft, SquarePen } from "lucide-react";
import { useI18n } from "@/i18n";
import { asFailure } from "@/api/errors";
import { projectHref } from "@/lib/router";
import { snapshotMode } from "@/lib/snapshot-mode";
import { useConsoleStore } from "@/store/context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The control `reason` of an "Edit myself" pause: a stable prefix the console matches (agents see `answer`). */
export const EDITING_TABLE_REASON = "editing-table: the user is editing the timeline themselves";

/** True while the project is paused by "Edit myself" (not by the generic Pause). */
export const isEditingPause = (control: ProjectView["control"]) =>
  control.state === "paused" && !!control.reason?.startsWith("editing-table");

/** This page's path and query (fixture, language, theme) with the project's Timeline route. */
export function editingTableUrl(project: string, location: Location = window.location): string {
  return `${location.pathname}${location.search}${projectHref(project, "timeline")}`;
}

/** Opens the editing table in a new tab with an opener, so the browser copies sessionStorage (the session) to it. */
export function openEditingTable(project: string): Window | null {
  return window.open(editingTableUrl(project), "_blank");
}

/** "Editing table" and its "Edit myself (pause agent)" option; nothing on a static snapshot. */
export function EditingTableActions({ view }: { view: ProjectView }) {
  return snapshotMode() ? null : <LiveEditingTableActions view={view} />;
}

function LiveEditingTableActions({ view }: { view: ProjectView }) {
  const { d, f } = useI18n();
  const store = useConsoleStore();
  const project = view.project.id;
  const [busy, setBusy] = useState(false);

  const blocked = () => store.notify({ tone: "error", title: d.editing.open, text: d.editing.popupBlocked });

  const open = () => {
    if (!openEditingTable(project)) blocked();
  };

  const editMyself = () => {
    // The tab first, in the click's user activation; the pause follows.
    if (!openEditingTable(project)) {
      blocked();
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const reply = await store.control(project, {
          state: "paused",
          answer: d.editing.pausePhrase,
          reason: EDITING_TABLE_REASON,
        });
        if (!reply.ok) {
          const message = reply.result?.message ?? reply.result?.error ?? "";
          store.notify({ tone: "error", title: d.editing.myself, text: f(d.editing.pauseFailed, { message }) });
          return;
        }
        store.notify({ tone: "success", title: d.notices.control, text: d.editing.paused });
      } catch (failure) {
        const message = asFailure(failure).message;
        store.notify({ tone: "error", title: d.editing.myself, text: f(d.editing.pauseFailed, { message }) });
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div role="group" aria-label={d.editing.open} className="flex items-center" data-editing-table>
      <Button
        variant="outline"
        size="sm"
        className="rounded-e-none"
        title={d.editing.openHint}
        onClick={open}
        data-editing-open
      >
        <PanelsTopLeft aria-hidden="true" />
        {d.editing.open}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            className="-ms-px rounded-s-none"
            aria-label={d.editing.more}
            title={d.editing.more}
            data-editing-more
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={busy || view.control.state !== "running"}
            title={d.editing.myselfHint}
            onSelect={editMyself}
            data-editing-myself
          >
            <SquarePen aria-hidden="true" />
            {d.editing.myself}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * On the Timeline page while "Edit myself" holds the pause: says so and hands the project back with a resume whose
 * words name the timeline revision the user left, when the page knows it.
 */
export function EditingBanner({ view, revision }: { view: ProjectView; revision?: number | null }) {
  const { d, f } = useI18n();
  const store = useConsoleStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (snapshotMode() || !isEditingPause(view.control)) return null;

  const handBack = async () => {
    setBusy(true);
    setError(undefined);
    const answer =
      revision !== undefined && revision !== null
        ? f(d.editing.resumePhrase, { revision })
        : d.editing.resumePhraseNoRevision;
    try {
      const reply = await store.control(view.project.id, { state: "running", answer });
      if (!reply.ok) {
        setError(f(d.editing.resumeFailed, { message: reply.result?.message ?? reply.result?.error ?? "" }));
        return;
      }
      store.notify({ tone: "success", title: d.notices.control, text: d.editing.resumed });
    } catch (failure) {
      setError(f(d.editing.resumeFailed, { message: asFailure(failure).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="editing-banner-title"
      data-editing-banner
      className="flex flex-wrap items-center gap-3 rounded-xl border border-status-waiting/50 bg-status-waiting/10 p-4 text-sm"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id="editing-banner-title" className="font-semibold">
          {d.editing.bannerTitle}
        </h2>
        <p className="text-muted-foreground">{d.editing.bannerBody}</p>
        <p role="status" aria-live="polite" className="text-status-blocked empty:hidden">
          {error}
        </p>
      </div>
      <Button onClick={() => void handBack()} disabled={busy} data-editing-done>
        <CirclePlay aria-hidden="true" />
        {busy ? d.decision.sending : d.editing.done}
      </Button>
    </section>
  );
}
