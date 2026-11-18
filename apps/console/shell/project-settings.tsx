import { useEffect, useId, useRef, useState } from "react";
import { Settings, Trash2 } from "lucide-react";
import { asFailure, isAmbiguous } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { PROJECT_TITLE_LIMIT, ProjectTitleSchema } from "../../../src/types/project-display";

export function ProjectSettings({ project, title }: { project: string; title: string }) {
  const { d, f } = useI18n();
  const copy = d.projectSettings;
  const store = useConsoleStore();
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(title);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const canSave = ProjectTitleSchema.safeParse(name).success && name.trim() !== title;
  const canDelete = confirmation === project;

  useEffect(() => {
    if (open) field.current?.focus();
  }, [confirming, open]);

  function changeOpen(next: boolean) {
    if (pending) return;
    if (next) {
      setName(title);
      setConfirming(false);
      setConfirmation("");
      setError(undefined);
    }
    setOpen(next);
  }

  async function submit() {
    if (pending || !(confirming ? canDelete : canSave)) return;
    setError(undefined);
    setPending(true);
    try {
      if (confirming) {
        await store.client.removeProject!(project, confirmation);
        store.forgetProject(project);
      } else {
        await store.client.renameProject!(project, name.trim());
        void store.loadHome();
      }
      setOpen(false);
    } catch (cause) {
      const failure = asFailure(cause);
      setError(failure.message);
      if (isAmbiguous(failure) || failure.status === 404) void store.loadHome();
    } finally {
      setPending(false);
    }
  }

  const label = f(copy.open, { title });
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="absolute end-2 top-2 size-9 text-muted-foreground hover:text-foreground"
          title={label}
          aria-label={label}
        >
          <Settings aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent showClose={!pending}>
        <DialogHeader>
          <DialogTitle>{confirming ? f(copy.confirmTitle, { title }) : copy.title}</DialogTitle>
          <DialogDescription>{confirming ? copy.warning : f(copy.projectId, { id: project })}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-2">
            <label htmlFor={id} className="text-sm font-medium">
              {confirming ? f(copy.confirmLabel, { id: project }) : copy.name}
            </label>
            {confirming ? (
              <Input
                key="confirmation"
                id={id}
                ref={field}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={pending}
                autoComplete="off"
                spellCheck={false}
                maxLength={128}
              />
            ) : (
              <Input
                key="title"
                id={id}
                ref={field}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={pending}
                maxLength={PROJECT_TITLE_LIMIT}
              />
            )}
          </div>
          {error ? (
            <p role="alert" className="text-sm whitespace-pre-line text-destructive">
              {error}
            </p>
          ) : null}
          {confirming ? (
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                  setConfirmation("");
                  setError(undefined);
                }}
              >
                {d.app.cancel}
              </Button>
              <Button type="submit" variant="destructive" disabled={!canDelete || pending}>
                {pending ? copy.deleting : copy.confirmDelete}
              </Button>
            </DialogFooter>
          ) : (
            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline"
                className="text-destructive"
                disabled={pending}
                onClick={() => {
                  setConfirming(true);
                  setError(undefined);
                }}
              >
                <Trash2 aria-hidden="true" />
                {copy.delete}
              </Button>
              <div className="flex flex-wrap justify-end gap-2">
                <DialogClose asChild>
                  <Button type="button" variant="outline" disabled={pending}>
                    {d.app.cancel}
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={!canSave || pending}>
                  {pending ? copy.saving : copy.save}
                </Button>
              </div>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
