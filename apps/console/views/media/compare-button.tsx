/** "Compare with source" (2026-11-20): opens the A/B compare (side by side or wipe) of a file and the file it was made from. */
import type { MediaRef } from "@contract";
import { Columns2 } from "lucide-react";
import { useI18n } from "@/i18n";
import { Compare } from "@/media/compare";
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

export function CompareButton({ project, item, source }: { project: string; item: MediaRef; source: MediaRef }) {
  const { d, f } = useI18n();
  const name = (media: MediaRef) => media.label ?? media.path.split("/").at(-1) ?? media.path;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns2 aria-hidden="true" />
          {d.mediaTab.compare}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[92vh] flex-col overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{d.mediaTab.compare}</DialogTitle>
          <DialogDescription className="break-all">
            {f(d.mediaTab.compareTitle, { a: name(source), b: name(item) })}
          </DialogDescription>
        </DialogHeader>
        <Compare project={project} a={source} b={item} />
        <DialogFooter>
          <DialogClose asChild>
            <Button>{d.mediaTab.close}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
