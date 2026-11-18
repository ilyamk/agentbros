/**
 * A media slot in a static snapshot (RFC 0004 WP15, D18): the snapshot carries no media, so the slot names the file and
 * links it by a path relative to the snapshot (`out/<id>/console-snapshot.html`), which opens only next to the
 * checkout. Never an inlined file, never a server URL.
 */
import type { MediaRef } from "@contract";
import { FileX } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { mediaLabel } from "./media-facts";

const encodePath = (relative: string) => relative.split("/").map(encodeURIComponent).join("/");

/** The file's path relative to `out/<project>/console-snapshot.html`. */
export function snapshotHref(project: string, media: MediaRef): string {
  return media.root === "out"
    ? `./${encodePath(media.path)}`
    : `../../public/projects/${encodeURIComponent(project)}/${encodePath(media.path)}`;
}

export function SnapshotMedia({ project, media, className }: { project: string; media: MediaRef; className?: string }) {
  const { d } = useI18n();
  return (
    <figure
      data-snapshot-media=""
      className={cn("flex min-w-0 flex-col gap-1 rounded-lg border border-dashed p-3 text-sm", className)}
    >
      <span className="flex items-center gap-2 text-muted-foreground">
        <FileX className="size-4 shrink-0" aria-hidden="true" />
        {d.snapshot.mediaOmitted}
      </span>
      <figcaption className="font-medium break-all">{mediaLabel(media)}</figcaption>
      <a
        href={snapshotHref(project, media)}
        className="text-xs break-all underline underline-offset-4"
        title={d.snapshot.openLocal}
      >
        {media.root === "out" ? `out/${project}/` : `public/projects/${project}/`}
        {media.path}
      </a>
    </figure>
  );
}
