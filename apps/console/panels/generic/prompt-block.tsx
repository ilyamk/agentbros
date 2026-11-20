/**
 * A generation prompt as a compact block (2026-11-20): the title, its length in characters and a Show button. Prompts
 * can run to thousands of characters, so the text opens in a dialog with its own scroll, Copy and Close; the prompt is
 * shown exactly as written.
 */
import { useState } from "react";
import { Copy, FileText } from "lucide-react";
import { plural, useI18n } from "@/i18n";
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

export function PromptBlock({ prompt, subject }: { prompt: string; subject: string }) {
  const { d, locale } = useI18n();
  const [copied, setCopied] = useState<"ok" | "failed">();
  const characters = [...prompt].length;
  const copy = () => {
    const done = navigator.clipboard?.writeText(prompt);
    if (!done) return setCopied("failed");
    done.then(
      () => setCopied("ok"),
      () => setCopied("failed"),
    );
  };
  return (
    <div data-prompt className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2">
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="font-medium">{d.generations.promptTitle}</span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {plural(d.generations.promptChars, characters, locale)}
      </span>
      <Dialog onOpenChange={() => setCopied(undefined)}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="ms-auto">
            {d.generations.promptShow}
            <span className="sr-only">
              {" "}
              {d.generations.promptTitle} · {subject}
            </span>
          </Button>
        </DialogTrigger>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{d.generations.promptTitle}</DialogTitle>
            <DialogDescription className="break-all">
              {subject} · {plural(d.generations.promptChars, characters, locale)}
            </DialogDescription>
          </DialogHeader>
          <div
            tabIndex={0}
            data-prompt-text
            className="min-h-0 flex-1 overflow-y-auto rounded-md bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap select-text focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {prompt}
          </div>
          <DialogFooter className="items-center gap-2">
            <span role="status" className="me-auto text-xs text-muted-foreground empty:hidden">
              {copied === "ok"
                ? d.generations.promptCopied
                : copied === "failed"
                  ? d.generations.promptCopyFailed
                  : null}
            </span>
            <Button variant="outline" onClick={copy}>
              <Copy aria-hidden="true" />
              {d.generations.promptCopy}
            </Button>
            <DialogClose asChild>
              <Button>{d.generations.promptClose}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
