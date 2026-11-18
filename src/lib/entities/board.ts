import {
  existsSync,
  realpathSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { assertProjectId, validatePublicAsset } from "../render-plan";
import { readAssetRegistry, hashFile } from "../assets/registry";
import { listEntities, getEntityVersion } from "./service";
import { computeCoverage } from "../references/coverage";
import type { EntityCard, EntityVersion } from "../../types/entities";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const factsText = (facts: EntityCard["references"][number]["facts"]) =>
  facts && Object.keys(facts).length
    ? Object.entries(facts)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ")
    : "no declared facts";
/** Fixed sentence, voice samples, per-view facts and advisory coverage of one card version (text only, escaped). */
function entityDetails(version: EntityVersion): string {
  const card = version.card;
  const parts: string[] = [];
  if (card.fixedSentence) parts.push(`<p>Fixed sentence: <q>${esc(card.fixedSentence)}</q></p>`);
  const samples = card.kind === "character" ? (card.voice?.sampleAssetIds ?? []) : [];
  if (samples.length) parts.push(`<p>Voice samples: ${samples.map((id) => `<code>${esc(id)}</code>`).join("")}</p>`);
  if (card.references.length)
    parts.push(
      `<ul class="views">${card.references.map((ref) => `<li>${esc(ref.role)} · ${esc(factsText(ref.facts))}${ref.notes ? ` · ${esc(ref.notes)}` : ""}<code>${esc(ref.assetId)}</code></li>`).join("")}</ul>`,
    );
  const coverage = computeCoverage(version);
  const findings = coverage.ruleFindings.map((f) => `<li>${esc(f.severity)} · ${esc(f.rule)}: ${esc(f.message)}</li>`);
  parts.push(
    `<p>Coverage (advisory): ${coverage.satisfied ? "satisfied" : "not satisfied"}${coverage.missing.length ? ` · missing ${coverage.missing.map(esc).join(", ")}` : ""}${coverage.unrecognisedRoles.length ? ` · unrecognised roles ${coverage.unrecognisedRoles.map(esc).join(", ")}` : ""}</p>${findings.length ? `<ul class="findings">${findings.join("")}</ul>` : ""}`,
  );
  return parts.join("");
}
/** Static local review artifact; it does not execute Remotion or make generation calls. */
export function createAssetBoard(
  projectId: string,
  rootDir = process.cwd(),
): { file: string; assets: number; entities: number } {
  assertProjectId(projectId);
  const assets = readAssetRegistry(projectId, rootDir).assets,
    manifests = listEntities(projectId, rootDir);
  const project = path.resolve(rootDir, "public/projects", projectId),
    directory = path.join(project, "entities");
  if (existsSync(directory) && !realpathSync(directory).startsWith(`${realpathSync(project)}${path.sep}`))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Board directory symlink escapes project." });
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "asset-board.html");
  if (existsSync(file) && !realpathSync(file).startsWith(`${realpathSync(project)}${path.sep}`))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Board file symlink escapes project." });
  const assetRows = assets
    .map((asset) => {
      validatePublicAsset(asset.files.original, rootDir);
      if (hashFile(path.resolve(rootDir, "public", asset.files.original)) !== asset.hash)
        throw new CliErrorObject({ code: "VALIDATION", message: "Board asset original differs from registry." });
      const relative = path
        .relative(directory, path.resolve(rootDir, "public", asset.files.original))
        .split(path.sep)
        .map(encodeURIComponent)
        .join("/");
      const media =
        asset.kind === "image"
          ? `<img src="${esc(relative)}" alt="${esc(asset.provenance.originalFilename)}">`
          : asset.kind === "video"
            ? `<video controls preload="metadata" src="${esc(relative)}"></video>`
            : asset.kind === "audio"
              ? `<audio controls preload="metadata" src="${esc(relative)}"></audio>`
              : `<a href="${esc(relative)}">${esc(asset.kind)} file</a>`;
      const links = manifests.flatMap((manifest) => {
        const versions = [
          ...new Set([manifest.latestRevision, manifest.canonicalRevision].filter((v): v is number => v !== null)),
        ];
        return versions.flatMap((revision) => {
          const view = getEntityVersion(projectId, manifest.kind, manifest.id, { rootDir, revision });
          return view.version.referenceSnapshots
            .filter((r) => r.assetId === asset.id)
            .map(
              (ref) =>
                `${manifest.kind}/${manifest.id}@${revision} · ${ref.role} · ${view.canonical ? "canonical" : view.status}`,
            );
        });
      });
      return `<article>${media}<h2>${esc(asset.provenance.originalFilename ?? asset.id)}</h2><p>${esc(asset.kind)} · ${asset.media.width ?? ""}×${asset.media.height ?? ""} ${asset.media.durationSec ?? ""}</p><p>${esc(asset.provenance.origin)} · tool ${esc(asset.provenance.tool)} · model ${esc(asset.provenance.model)}</p><p>Licence: ${esc(asset.rights.licence)} · commercial: ${esc(asset.rights.commercialAllowed)}</p><p>API billing: ${esc(asset.provenance.billing.status)}${asset.provenance.billing.apiUsd === undefined ? "" : ` $${asset.provenance.billing.apiUsd}`}</p><p>${links.map(esc).join("<br>") || "Unbound candidate"}</p><a href="${esc(relative)}">Original</a><code>${esc(asset.id)}</code></article>`;
    })
    .join("\n");
  const entityRows = manifests
    .map((manifest) => {
      const view = getEntityVersion(projectId, manifest.kind, manifest.id, {
        rootDir,
        revision: manifest.latestRevision,
      });
      const card = view.version.card;
      return `<li><strong>${esc(card.name)}</strong> (${esc(manifest.kind)}/${esc(manifest.id)}) latest ${manifest.latestRevision}; canonical ${manifest.canonicalRevision ?? "awaiting explicit approval"}<p>${esc(card.description)}</p><p>Invariants: ${card.invariants.map(esc).join("; ")}</p>${entityDetails(view.version)}</li>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(projectId)} asset board</title><style>body{font:16px system-ui;background:#f7f7fa;color:#202026;margin:32px}h1{font-size:32px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}article{background:white;border-radius:16px;padding:20px;overflow-wrap:anywhere}img,video{width:100%;height:220px;object-fit:contain;background:#eee}audio{width:100%}code{display:block;font-size:11px;margin-top:12px}h2{font-size:18px}li{margin-bottom:20px}.views li,.findings li{margin-bottom:4px}</style></head><body><h1>${esc(projectId)} — asset & entity board</h1><p>Local originals · immutable references · declared approval records. Unknown billing and rights remain unknown.</p><h2>Entities</h2><ul>${entityRows || "<li>No entity cards yet</li>"}</ul><h2>Assets</h2><section class="grid">${assetRows || "<p>No imported assets yet</p>"}</section></body></html>`;
  const temporary = path.join(directory, `.${randomUUID()}.board.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, html);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { file: path.relative(rootDir, file), assets: assets.length, entities: manifests.length };
}
