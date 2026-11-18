import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin } from "../cli";
import { hashFile } from "../assets/registry";
import type { Finding } from "./reviews";
import type { RenderIdentity } from "../../types/delivery";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const frame = z.object({ file: z.string(), sha256: hash, frame: z.number().int().nonnegative() }).passthrough();
const section = z
  .object({ frames: z.array(frame), findings: z.array(z.record(z.string(), z.unknown())).default([]) })
  .passthrough();
const schema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    format: z.string(),
    sourceHash: hash,
    propsHash: hash,
    omittedEvents: z.number().int().nonnegative(),
    extraction: section.extend({ inputSha256: hash }),
    browser: section.extend({ fontMode: z.string() }).optional(),
  })
  .passthrough();
/** Existing measured failures cannot be overridden by a human approval checkbox. */
export function reviewQaEvidence(
  root: string,
  projectId: string,
  identity: RenderIdentity,
  outputSha256: string,
  serializedPropsHash: string,
  findings: Finding[],
) {
  const directory = path.join(root, "public/projects", projectId, "pipeline/qa-evidence");
  const records: Record<string, unknown>[] = [];
  const warn = (code: string, message: string) => findings.push({ code, severity: "warning", message });
  if (existsSync(directory)) {
    assertPathWithin(path.join(root, "public/projects", projectId), directory);
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name, "evidence.json");
      assertPathWithin(directory, file);
      if (!existsSync(file)) continue;
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (raw.sourceHash !== outputSha256 || ![identity.propsHash, serializedPropsHash].includes(String(raw.propsHash)))
        continue;
      const report = schema.parse(raw);
      const binding = report.renderIdentity as { sourceSnapshotHash?: string } | undefined;
      if (binding && binding.sourceSnapshotHash !== identity.sourceSnapshotHash) {
        warn(
          "QA_SOURCE_CHANGED",
          "Matching output report used different current code/font/media sources; its layout evidence is not a current production font proof",
        );
      }
      const productionFontsMeasured =
        !!binding &&
        binding.sourceSnapshotHash === identity.sourceSnapshotHash &&
        ["production-fonts", "cached-production-fonts"].includes(report.browser?.fontMode ?? "") &&
        !!report.browser?.frames.length &&
        report.browser.frames.every((f) => !!f.measurement && typeof f.measurement === "object");
      if (
        report.projectId !== projectId ||
        report.format !== identity.format ||
        report.extraction.inputSha256 !== outputSha256
      )
        throw new Error("QA evidence project/format/extraction source mismatch");
      const allFrames = [...report.extraction.frames, ...(report.browser?.frames ?? [])];
      for (const frame of allFrames) {
        const actual = path.resolve(root, frame.file);
        assertPathWithin(path.dirname(file), actual);
        if (frame.frame >= identity.durationInFrames || hashFile(actual) !== frame.sha256)
          throw new Error("QA frame checksum/path/index mismatch");
      }
      if (!report.extraction.frames.length)
        warn(
          "QA_EVIDENCE_INCOMPLETE",
          "Matching report has no extracted frame evidence; manual review remains required",
        );
      if (report.omittedEvents > 0)
        warn(
          "QA_EVIDENCE_OMISSIONS",
          `Event cap omitted ${report.omittedEvents} checks; incomplete sampling is not an automatic layout pass`,
        );
      if (!report.browser?.frames.length)
        warn(
          "BROWSER_QA_NOT_PROVEN",
          "No matching production DOM measurements; explicit manual visual/font review remains required",
        );
      else if (report.browser.frames.some((frame) => !frame.measurement || typeof frame.measurement !== "object"))
        warn("BROWSER_QA_NOT_PROVEN", "Browser frame lacks DOM measurements; no automatic layout/font pass is claimed");
      else if (!productionFontsMeasured)
        warn(
          "FONT_EVIDENCE_NOT_PRODUCTION",
          "Unbound/offline/substitute font evidence cannot prove current production font loading",
        );
      const measuredFrameFindings = (report.browser?.frames ?? []).flatMap((frame) => {
        const measurement = frame.measurement as { findings?: Record<string, unknown>[] } | undefined;
        return Array.isArray(measurement?.findings)
          ? measurement.findings.map((finding) => ({ frame: frame.frame, finding }))
          : [];
      });
      for (const item of [
        ...report.extraction.findings,
        ...(report.browser?.findings ?? []),
        ...measuredFrameFindings,
      ]) {
        const nested =
          item.finding && typeof item.finding === "object"
            ? (item.finding as Record<string, unknown>)
            : (item as Record<string, unknown>);
        findings.push({
          code: "QA_EVIDENCE_FAILURE",
          severity: "error",
          message: `Measured ${String(nested.code ?? "unknown failure")}: ${JSON.stringify(item)}`,
          path: file,
        });
      }
      records.push({
        file: path.relative(root, file),
        sha256: hashFile(file),
        sourceHash: report.sourceHash,
        propsHash: report.propsHash,
        frameHashes: allFrames.map((f) => ({
          file: path.relative(root, path.resolve(root, f.file)),
          sha256: f.sha256,
        })),
        productionFontsMeasured,
        omittedEvents: report.omittedEvents,
      });
    }
  }
  if (!records.length)
    warn(
      "AUTOMATED_QA_NOT_PROVEN",
      "No matching current-output/current-props measured report; production requires explicit manual visual/font review, no automatic layout pass is claimed",
    );
  return records;
}
