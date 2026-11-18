import { upscaleFor } from "./resolution";
import type { DownloadTarget } from "./types";

type Rendition = { url: string; width: number; height: number; bytes?: number; label?: string };

/** The smallest file that fills the target frame without enlargement, else the largest; no target takes the largest. */
export function pickRendition<T extends Rendition>(
  renditions: readonly T[],
  target: DownloadTarget | undefined,
): T | undefined {
  const bySize = [...renditions].sort((a, b) => a.width * a.height - b.width * b.height || a.url.localeCompare(b.url));
  const largest = bySize.at(-1);
  if (!target) return largest;
  return bySize.find((item) => (upscaleFor(item, target.format, target.zoom) ?? Infinity) <= 1) ?? largest;
}
