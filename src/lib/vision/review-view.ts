import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { VisionManifest } from "../../types/vision-review";

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
export function reviewLayout(info: { width: number; height: number }, profile: string, phone = false) {
  const tileWidth = phone ? 390 : profile === "overview" ? 300 : info.height > info.width ? 460 : 600;
  const tileHeight = Math.round((tileWidth * info.height) / info.width);
  if (tileHeight + 260 > 2000) throw new Error("Source aspect ratio cannot fit a legible review page; request a crop.");
  const columns = profile === "overview" ? Math.max(1, Math.floor(1960 / (tileWidth + 16))) : 2;
  const rows = Math.max(1, Math.floor((2000 - 100) / (tileHeight + 172)));
  return {
    tileWidth,
    tileHeight,
    columns,
    perPage: columns * rows,
    width: columns * (tileWidth + 16) + 16,
    height: (count: number) => 100 + Math.ceil(count / columns) * (tileHeight + 172),
  };
}
export type ReviewLayout = ReturnType<typeof reviewLayout>;
export function renderReviewHtml(
  manifest: VisionManifest,
  frames: VisionManifest["frames"],
  layout: ReviewLayout,
  root: string,
): string {
  const fields = manifest.request.fields;
  const cards = frames
    .map((frame) => {
      const preview = path.join(root, "frames", `preview-${frame.frame}.png`);
      const isDiff = frame.reasons.some((reason) => reason.startsWith("x4 pixel difference"));
      const image = readFileSync(!isDiff && existsSync(preview) ? preview : path.join(root, frame.path)).toString(
        "base64",
      );
      const lines = [
        fields.includes("selectionReason") ? `Selection (${frame.basis}): ${frame.reasons.join("; ")}` : "",
        fields.includes("text") ? (frame.text ? `Declared text: ${frame.text}` : "Visible text: unverified") : "",
        fields.includes("measurements")
          ? frame.measurements.length
            ? frame.measurements.map((m) => `${m.basis}: ${m.name}=${m.value}`).join("; ")
            : "Measurements: unavailable"
          : "",
        fields.includes("findings") ? "Verdict: requires review; no automatic pass" : "",
      ].filter(Boolean);
      return `<figure><a href="${escape(frame.path)}"><img alt="${escape(frame.id)}" src="data:image/png;base64,${image}"></a><figcaption><strong>${frame.id} · ${frame.timeSec.toFixed(3)} s${frame.clipId ? ` · ${escape(frame.clipId)}` : ""}</strong>${lines.map((line) => `<div title="${escape(line)}">${escape(line)}</div>`).join("")}<small><a href="manifest.json">Full metadata</a> · <a href="${escape(frame.path)}">Original</a>${frame.crops.map((crop, i) => ` · <a href="${escape(crop.path)}">Crop ${i + 1}</a>`).join("")}</small></figcaption></figure>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>Frame review</title><style>*{box-sizing:border-box}body{margin:0;padding:16px;background:#101318;color:#f4f6f8;font:20px Arial,sans-serif;width:${layout.width}px}header{height:84px}h1{font-size:24px;margin:0 0 8px}p{font-size:17px;margin:0;color:#bfc9d6}.grid{display:grid;grid-template-columns:repeat(${layout.columns},${layout.tileWidth}px);gap:16px}figure{margin:0;height:${layout.tileHeight + 156}px;background:#1d2530}img{display:block;width:${layout.tileWidth}px;height:${layout.tileHeight}px;object-fit:contain;background:#080b10}figcaption{height:156px;padding:8px;line-height:25px;overflow:hidden}strong,figcaption div,small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}small{font-size:15px;color:#bfc9d6}a{color:inherit}</style><header><h1>${escape(manifest.profile)} · ${manifest.source.width}×${manifest.source.height} · ${manifest.source.fps.toFixed(3)} fps</h1><p>Source ${manifest.source.kind} ${manifest.source.sha256.slice(0, 12)} · needs review · ${manifest.omitted.length} omitted · missing data ≠ pass</p></header><main class="grid">${cards}</main></html>`;
}
