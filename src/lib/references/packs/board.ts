/** Static, escaped review boards for packs and their results (no scripts; CSP forbids everything but local media). */
import path from "node:path";
import type { DerivativeMediaPin, ReferencePackReceipt } from "../../../types/references";

export const esc = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const HEAD = (title: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'"><title>${esc(title)}</title><style>body{font:16px system-ui;background:#16161a;color:#f2f2f2;padding:24px}main{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;max-width:420px;background:#222228;padding:8px;border-radius:6px}img,video{max-width:404px;max-height:320px;display:block;background:repeating-conic-gradient(#444 0 25%,#666 0 50%) 0 0/16px 16px}audio{width:404px}.warn{color:#ffb4a2;padding-left:18px}.marker{font:700 22px ui-monospace,monospace;color:#ffd166}code{word-break:break-all}pre{white-space:pre-wrap;background:#222228;padding:12px;border-radius:6px}th{text-align:left;padding-right:16px;vertical-align:top}</style>`;

/** A media element for a public/-relative original, linked relative to the board's own folder. */
export function mediaTag(contentType: string, src: string, label: string): string {
  const href = esc(src);
  if (contentType.startsWith("image/")) return `<img src="${href}" alt="${esc(label)}">`;
  if (contentType.startsWith("video/"))
    return `<video src="${href}" controls muted playsinline preload="metadata"></video>`;
  return `<audio src="${href}" controls preload="metadata"></audio>`;
}
export const relativeSrc = (boardDir: string, file: string): string =>
  path.relative(boardDir, file).split(path.sep).join("/");

export function pinFacts(pin: DerivativeMediaPin): string {
  return [
    pin.width && pin.height ? `${pin.width}×${pin.height}` : "",
    pin.durationSec ? `${pin.durationSec.toFixed(3)} s` : "",
    pin.fps ? `${Number(pin.fps.toFixed(3))} fps` : "",
    pin.frameCount ? `${pin.frameCount} frames` : "",
    pin.hasAudio ? "has audio" : "",
    `${pin.bytes} bytes`,
    pin.contentType,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Warnings that name this attachment's requirement key, listed under its figure. */
const own = (key: string, warnings: string[]) => {
  const mine = warnings.filter((w) =>
    new RegExp(`(^|[^a-z0-9-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`).test(w),
  );
  return mine.length ? `<ul class="warn">${mine.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
};
type BoardAttachment = ReferencePackReceipt["attachments"][number] & {
  slot: string;
  order: number;
  roleSentence: string;
  element?: { index: number; part: string };
  characters?: string[];
};

function attachmentFigures(
  attachments: BoardAttachment[],
  boardDir: string,
  publicDir: string,
  warnings: string[] = [],
): string {
  return attachments
    .map((a) => {
      const field = a.pointer.replace(/^\//, "");
      const label = a.marker || `${field} (bound by position)`;
      const element = a.element ? ` · element ${a.element.index} ${a.element.part}` : "";
      return `<figure>${mediaTag(a.media.contentType, relativeSrc(boardDir, path.join(publicDir, a.media.original)), label)}<figcaption><div class="marker">${esc(a.marker || `${field} — bound by position`)}</div><b>${esc(a.requirementKey)}</b> · slot ${esc(a.slot)} #${a.order}${esc(element)}<br>${esc(a.roleSentence)}<br><small>${esc(pinFacts(a.media))}</small><br><small>field <code>${esc(a.pointer)}</code></small>${a.characters?.length ? `<br><small>character: ${esc(a.characters.join(", "))}</small>` : ""}<br><small><code>${esc(a.media.sha256)}</code></small>${own(a.requirementKey, warnings)}</figcaption></figure>`;
    })
    .join("");
}

/** What the model will see, marker-labelled: attachments, compiled prompt, request summary, warnings. Deterministic. */
export function packBoard(args: {
  id: string;
  shotId: string;
  endpoint: string;
  provider: string;
  family: string;
  audioPolicy: string;
  attachments: BoardAttachment[];
  compiledPrompt: string;
  input: Record<string, unknown>;
  warnings: string[];
  boardDir: string;
  publicDir: string;
}): string {
  const params = Object.entries(args.input)
    .filter(([key]) => key !== "prompt")
    .map(([key, value]) => `<tr><th>${esc(key)}</th><td><code>${esc(JSON.stringify(value))}</code></td></tr>`)
    .join("");
  const warnings = args.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("");
  return `${HEAD(`Reference pack ${args.id}`)}<h1>${esc(args.id)} · shot ${esc(args.shotId)}</h1><p>${esc(args.provider)} · <code>${esc(args.endpoint)}</code> · profile ${esc(args.family)} · audio ${esc(args.audioPolicy)}</p><h2>Attachments, in the order the model receives them</h2><main>${attachmentFigures(args.attachments, args.boardDir, args.publicDir, args.warnings)}</main><h2>Compiled prompt</h2><pre>${esc(args.compiledPrompt)}</pre><h2>Request</h2><table>${params}</table><h2>Warnings</h2><ul>${warnings || "<li>none</li>"}</ul><p>Check every marker and every positional binding: each must name the picture, clip or sound the prompt means, and each input must show what its role sentence asks for. Measurements are mechanical facts, not a judgement of fitness.</p></html>\n`;
}

/** A result next to the pack's attachments, for the result review (RFC 0003 §10.3). Deterministic. */
export function resultBoard(args: {
  id: string;
  packSha256: string;
  outputSha256: string;
  result: { src: string; contentType: string; facts: string };
  frames: string[];
  attachments: BoardAttachment[];
  compiledPrompt: string;
  boardDir: string;
  publicDir: string;
}): string {
  const frames = args.frames
    .map((src, index) => `<figure><img src="${esc(src)}" alt="result sample ${index + 1}"></figure>`)
    .join("");
  return `${HEAD(`Result of ${args.id}`)}<h1>Result of ${esc(args.id)}</h1><p>pack <code>${esc(args.packSha256)}</code><br>output <code>${esc(args.outputSha256)}</code> · ${esc(args.result.facts)}</p><h2>Result</h2><main><figure>${mediaTag(args.result.contentType, args.result.src, "result")}</figure>${frames}</main><h2>Attachments</h2><main>${attachmentFigures(args.attachments, args.boardDir, args.publicDir)}</main><h2>Compiled prompt</h2><pre>${esc(args.compiledPrompt)}</pre><p>Review identity, wardrobe, preserved elements, other subjects, motion, naturalness (no copy of the reference's pose, light or background), prompt fit, temporal consistency and audio over the whole result, not only these samples. A failed dimension cannot pass; a reshoot asks the user.</p></html>\n`;
}
