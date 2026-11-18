import { useEffect, useRef, useState } from "react";
import type { MediaRef } from "@contract";
import { STRATEGY_DOCUMENTS, type ConsoleDocument } from "../../../src/types/console-document";
import { asFailure } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n";
import type { ConsoleStore } from "@/store/store";
import { mediaLabel } from "./media-facts";

export function DocumentDialog({
  project,
  media,
  store,
  close,
}: {
  project: string;
  media: MediaRef;
  store: ConsoleStore;
  close: () => void;
}) {
  const { d, f } = useI18n();
  const { client } = store;
  const [activePath, setActivePath] = useState(media.path);
  const [document, setDocument] = useState<ConsoleDocument>();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [discard, setDiscard] = useState(false);
  const writing = useRef(false);
  const label = activePath === media.path ? mediaLabel(media) : activePath.split("/").at(-1);
  const editablePath = media.root === "out" ? undefined : STRATEGY_DOCUMENTS.find((file) => file === activePath);
  const canEdit = !!(document?.editable && editablePath && client.saveDocument);
  const dirty = draft !== undefined && draft !== document?.text;

  useEffect(() => {
    if (!client.document) return;
    const abort = new AbortController();
    void client.document(project, { path: activePath, root: media.root }, abort.signal).then(
      (loaded) => {
        if (!abort.signal.aborted) setDocument(loaded);
      },
      (failure) => {
        if (!abort.signal.aborted) setError(asFailure(failure).message);
      },
    );
    return () => abort.abort();
  }, [activePath, attempt, client, media.root, project]);

  const closeRequest = () => {
    if (writing.current) return;
    if (dirty) setDiscard(true);
    else close();
  };

  const save = async () => {
    if (
      !canEdit ||
      !client.saveDocument ||
      !document ||
      !editablePath ||
      draft === undefined ||
      !dirty ||
      writing.current
    )
      return;
    writing.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await client.saveDocument(project, { path: editablePath, text: draft, revision: document.revision });
      close();
      store.notify({ tone: "success", title: d.media.document.saved });
      void store.loadHome();
      void store.loadView(project);
    } catch (failure) {
      setError(asFailure(failure).message);
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeRequest();
      }}
    >
      <DialogContent className="max-h-[90dvh] min-w-0 gap-3 sm:max-w-3xl">
        <DialogTitle className="truncate pe-6">{label}</DialogTitle>
        <DialogDescription className={editablePath ? undefined : "sr-only"}>
          {editablePath === "pipeline/strategy.json"
            ? d.media.document.strategyData
            : editablePath
              ? d.media.document.strategySummary
              : f(d.media.open, { label: label ?? "" })}
        </DialogDescription>
        {editablePath ? (
          <div className="flex flex-wrap gap-2">
            {STRATEGY_DOCUMENTS.map((file) => (
              <Button
                key={file}
                size="sm"
                variant={file === activePath ? "secondary" : "outline"}
                aria-pressed={file === activePath}
                disabled={dirty || saving}
                onClick={() => {
                  if (file === activePath) return;
                  setDocument(undefined);
                  setDraft(undefined);
                  setError(undefined);
                  setActivePath(file);
                }}
              >
                {file.split("/").at(-1)}
              </Button>
            ))}
          </div>
        ) : null}
        {document ? (
          draft !== undefined ? (
            <Textarea
              aria-label={d.media.document.contents}
              className="field-sizing-fixed h-[min(55dvh,32rem)] resize-none p-3 font-mono md:text-sm"
              spellCheck={false}
              readOnly={saving}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setDiscard(false);
              }}
            />
          ) : (
            <pre className="max-h-[min(55dvh,32rem)] overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-sm whitespace-pre-wrap wrap-anywhere">
              {document.text}
            </pre>
          )
        ) : !client.document ? (
          <p role="status" className="text-sm text-muted-foreground">
            {d.media.placeholder}
          </p>
        ) : !error ? (
          <p role="status" className="text-sm text-muted-foreground">
            {d.app.loading}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm wrap-anywhere text-destructive">
            {error}
          </p>
        ) : null}
        {discard ? (
          <p role="alert" className="text-sm">
            {d.media.document.unsaved}
          </p>
        ) : null}
        <DialogFooter>
          {discard ? (
            <>
              <Button variant="outline" onClick={() => setDiscard(false)}>
                {d.media.document.keepEditing}
              </Button>
              <Button variant="destructive" onClick={close}>
                {d.media.document.discard}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={closeRequest} disabled={saving}>
                {d.app.close}
              </Button>
              {!document && error ? (
                <Button
                  onClick={() => {
                    setError(undefined);
                    setAttempt((value) => value + 1);
                  }}
                >
                  {d.app.retry}
                </Button>
              ) : null}
              {canEdit && document && draft === undefined ? (
                <Button onClick={() => setDraft(document.text)}>{d.media.document.edit}</Button>
              ) : null}
              {draft !== undefined ? (
                <Button onClick={() => void save()} disabled={saving || !dirty}>
                  {saving ? d.media.document.saving : d.media.document.save}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
