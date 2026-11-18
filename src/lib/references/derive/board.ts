/** Static review board for one derivative: input and output side by side, steps, measurements, warnings. No scripts. */
import path from "node:path";
import type { DerivativeMediaPin, DerivativeReceipt, DerivativeSpec } from "../../../types/references";

const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** `pin.original` is public/-relative (projects/<id>/assets/imported/...); the board sits in the derivative folder. */
function preview(pin: DerivativeMediaPin, boardDir: string, publicDir: string, label: string): string {
  const src = esc(path.relative(boardDir, path.join(publicDir, pin.original)).split(path.sep).join("/"));
  const media = pin.contentType.startsWith("image/")
    ? `<img src="${src}" alt="${esc(label)}">`
    : pin.contentType.startsWith("video/")
      ? `<video src="${src}" controls muted playsinline preload="metadata"></video>`
      : pin.contentType.startsWith("audio/")
        ? `<audio src="${src}" controls preload="metadata"></audio>`
        : `<p><a href="${src}">${esc(pin.contentType)} (${pin.bytes} bytes)</a></p>`;
  const facts = [
    pin.width && pin.height ? `${pin.width}x${pin.height}` : "",
    pin.durationSec ? `${pin.durationSec.toFixed(3)} s` : "",
    pin.fps ? `${Number(pin.fps.toFixed(3))} fps` : "",
    pin.frameCount ? `${pin.frameCount} frames` : "",
    pin.hasAudio ? "audio" : "",
    pin.contentType,
  ].filter(Boolean);
  return `<figure>${media}<figcaption><b>${esc(label)}</b> · ${esc(facts.join(" · "))}<br><code>${esc(pin.sha256)}</code></figcaption></figure>`;
}

export function derivativeBoard(
  spec: DerivativeSpec,
  receipt: DerivativeReceipt,
  boardDir: string,
  publicDir: string,
): string {
  const steps = spec.steps.map((step) => `<li><code>${esc(JSON.stringify(step))}</code></li>`).join("");
  const measurements = Object.entries(receipt.measurements)
    .map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(String(value))}</td></tr>`)
    .join("");
  const warnings = receipt.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'"><title>Derivative ${esc(spec.id)}</title><style>body{font:16px system-ui;background:#16161a;color:#f2f2f2;padding:24px}main{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;max-width:560px}img,video{max-width:560px;max-height:400px;background:repeating-conic-gradient(#444 0 25%,#666 0 50%) 0 0/16px 16px}audio{width:480px}code{word-break:break-all}th{text-align:left;padding-right:16px}</style><h1>${esc(spec.id)}</h1><p>${esc(spec.purpose)}</p><main>${preview(receipt.input, boardDir, publicDir, "Input")}${preview(receipt.output, boardDir, publicDir, "Output")}</main><h2>Steps</h2><ol>${steps}</ol><p>Engine: ${esc(receipt.engine.kind)} · ${esc(receipt.engine.version)}${receipt.engine.operationId ? ` · operation <code>${esc(receipt.engine.operationId)}</code>` : ""}${receipt.costUsd === null ? "" : ` · $${esc(String(receipt.costUsd))}`}</p><h2>Measurements</h2><table>${measurements}</table><h2>Warnings</h2><ul>${warnings || "<li>none</li>"}</ul><p>Measurements are mechanical facts, not a judgement of the reference's fitness; inspect the output itself.</p></html>\n`;
}
