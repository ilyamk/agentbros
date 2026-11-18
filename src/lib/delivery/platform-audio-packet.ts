import path from "node:path";
import type { z } from "zod";
type DeliveryRequest = z.output<typeof DeliveryRequestSchema>;
import { DeliveryManifestSchema, DeliveryRequestSchema } from "../../types/delivery";
import { PlatformAudioPacketSchema, packetName, type PlatformAudioPacket } from "../../types/platform-audio-packet";
import { platformAudioHash } from "./platform-audio-plan";
import {
  readPlatformAudioPin,
  readPlatformAudioJson,
  writePlatformAudioBytes,
  copyPlatformAudioFile,
  platformAudioDirectory,
} from "./platform-audio-input";
import { assertProjectId } from "../render-plan";
type Manifest = ReturnType<typeof DeliveryManifestSchema.parse>;
/** Trusted in-process result only; never exposed as a request/CLI/MCP check override. */
export type CheckedNativeDelivery = {
  manifest: Manifest;
  report: string;
  subtitles: { name: string; content: string }[];
};
const ONE = 1024 * 1024;
function semantic(manifest: Manifest) {
  const { createdAt: _, ...rest } = manifest;
  return rest;
}
function bytes(value: unknown) {
  const b = Buffer.from(JSON.stringify(value, null, 2));
  if (b.length > ONE) throw Error("Native packet metadata exceeds bound");
  return b;
}
function eligible(request: DeliveryRequest, checked: CheckedNativeDelivery) {
  const m = DeliveryManifestSchema.parse(checked.manifest);
  assertProjectId(request.projectId);
  if (
    !request.platformAudioPlacement ||
    m.projectId !== request.projectId ||
    platformAudioHash(m.request) !== platformAudioHash(request) ||
    m.state !== "draft-needs-review" ||
    m.findings.some((x) => x.severity === "error") ||
    m.platformAudioPlacement?.localStatus !== "ready-for-manual-placement" ||
    m.platformAudioPlacement.status !== "pending-manual" ||
    !m.platformAudioPlacement.selection
  )
    throw Error("Native handoff requires fresh blocker-free native draft");
  const wanted = request.formats.flatMap((f) => request.variants.map((v) => f + ":" + v));
  if (
    m.outputs.length !== wanted.length ||
    new Set(m.outputs.map((x) => x.format + ":" + x.variant)).size !== wanted.length ||
    m.outputs.some((x) => !wanted.includes(x.format + ":" + x.variant)) ||
    m.sourceIdentities.length !== wanted.length
  )
    throw Error("Native packet must cover every requested output");
  for (const output of m.outputs) {
    const matches = m.sourceIdentities.filter(
      (i) => i.format === output.format && i.captions === (output.variant === "clean" ? "off" : "on"),
    );
    if (
      matches.length !== 1 ||
      matches[0].projectId !== request.projectId ||
      matches[0].sourceSnapshotHash !== output.sourceSnapshotHash ||
      matches[0].propsHash !== output.propsHash
    )
      throw Error("Output identity correspondence invalid");
  }
  if (
    m.platformAudioPlacement.movieBindings.length !== request.platformAudioPlacement.entries.length ||
    m.platformAudioPlacement.findings.length
  )
    throw Error("Native packet movie bindings incomplete");
  return m;
}
function verifySources(root: string, m: Manifest) {
  const pins = new Map<string, { sha256: string; role: string }>();
  let total = 0;
  for (const s of [...m.sourceIdentities.flatMap((i) => i.sources), ...m.platformAudioPlacement!.selection!.sources]) {
    const old = pins.get(s.path);
    if (old && (old.sha256 !== s.sha256 || old.role !== s.role)) throw Error("Cross-output source pin conflict");
    pins.set(s.path, { sha256: s.sha256, role: s.role });
  }
  if (pins.size > 512) throw Error("Packet source count exceeds bound");
  for (const [file, pinned] of pins) {
    if (file.includes("\\") || file.split("/").some((x) => ["", ".", ".."].includes(x)))
      throw Error("Unsafe source pin");
    const pin = readPlatformAudioPin(path.resolve(root, file), root);
    total += pin.bytes;
    if (total > 1024 * ONE || pin.sha256 !== pinned.sha256) throw Error("Packet source pin stale/aggregate exceeded");
  }
}
function filePlan(root: string, request: DeliveryRequest, checked: CheckedNativeDelivery, m: Manifest) {
  const files: { file: string; sha256: string; bytes: number; content?: Buffer; source?: string }[] = [];
  let total = 0;
  for (const o of m.outputs) {
    const expected = path.join("out", request.projectId, `${o.format}${o.variant === "clean" ? "-clean" : ""}.mp4`);
    if (o.path !== expected.split(path.sep).join("/")) throw Error("Movie path differs from fixed output");
    const source = path.join(root, o.path),
      pin = readPlatformAudioPin(source, path.join(root, "out", request.projectId));
    total += pin.bytes;
    if (total > 1024 * ONE || pin.sha256 !== o.sha256) throw Error("Packet movie stale/aggregate exceeded");
    files.push({ file: `${o.format}-${o.variant}.mp4`, ...pin, source });
  }
  let subtitleBytes = 0;
  for (const subtitle of checked.subtitles) {
    packetName.parse(subtitle.name);
    if (!/\.(srt|vtt)$/.test(subtitle.name)) throw Error("Only selected subtitle files allowed");
    const content = Buffer.from(subtitle.content);
    subtitleBytes += content.length;
    if (!content.length || content.length > 4 * ONE || subtitleBytes > 16 * ONE)
      throw Error("Packet subtitle bytes exceed bound");
    files.push({ file: subtitle.name, sha256: platformAudioHashBytes(content), bytes: content.length, content });
  }
  if (request.subtitleTracks) {
    const expected = m.subtitleOutputs ?? [];
    if (
      expected.length !== checked.subtitles.length ||
      expected.some((e) => files.filter((f) => f.file === e.filename && f.sha256 === e.sha256).length !== 1)
    )
      throw Error("Selected subtitle correspondence invalid");
  } else if (
    request.subtitles.length !== checked.subtitles.length ||
    request.subtitles.some((f) => !files.some((x) => x.file === "captions." + f))
  )
    throw Error("Legacy subtitle correspondence invalid");
  const content = bytes({
    version: 1,
    state: "draft-needs-review",
    productionReady: false,
    status: "pending-manual",
    manifest: semantic(m),
    instructions:
      "Manually select the exact declared native track/account/territory and placement; set rational source/video offsets and check reviewed marks. Discrepancies require a new plan. No upload or availability/permission verification.",
  });
  files.push({
    file: "platform-audio-handoff.json",
    sha256: platformAudioHashBytes(content),
    bytes: content.length,
    content,
  });
  const credits = Buffer.from(
    [
      "# Credits",
      "",
      ...m.rights.map((r) => String(r.attribution ?? "")).filter(Boolean),
      "",
      "Native track restrictions/reviews are declarations; platform access and permission remain unverified.",
    ].join("\n"),
  );
  if (credits.length > ONE) throw Error("Credits exceed bound");
  files.push({ file: "credits.md", sha256: platformAudioHashBytes(credits), bytes: credits.length, content: credits });
  if (new Set(files.map((f) => f.file.toLowerCase())).size !== files.length)
    throw Error("Packet output filename collision");
  return files;
}
import { createHash } from "node:crypto";
const platformAudioHashBytes = (content: Buffer) => createHash("sha256").update(content).digest("hex");
function expectedPacket(root: string, request: DeliveryRequest, checked: CheckedNativeDelivery) {
  const manifest = eligible(request, checked);
  verifySources(root, manifest);
  const files = filePlan(root, request, checked, manifest),
    plain = files.map(({ file, sha256, bytes }) => ({ file, sha256, bytes }));
  const id = platformAudioHash({ version: 1, manifest: semantic(manifest), files: plain });
  const report = readPlatformAudioJson(checked.report, path.join(root, "public/projects", request.projectId), ONE);
  if (platformAudioHash(semantic(DeliveryManifestSchema.parse(report.value))) !== platformAudioHash(semantic(manifest)))
    throw Error("Checked report bytes differ");
  const packet = PlatformAudioPacketSchema.parse({
    version: 1,
    id,
    basisSha256: id,
    projectId: request.projectId,
    state: "draft-needs-review",
    productionReady: false,
    status: "pending-manual",
    checkReport: { file: path.relative(root, checked.report).split(path.sep).join("/"), sha256: report.sha256 },
    manifest,
    files: plain,
    provenance:
      "Local correspondence only; supplied reviews are declarations; platform placement, account access and legal permission remain unverified",
  });
  bytes(packet);
  return { packet, files };
}
function readback(root: string, directory: string, packet: PlatformAudioPacket) {
  if (platformAudioHash({ version: 1, manifest: semantic(packet.manifest), files: packet.files }) !== packet.id)
    throw Error("Packet canonical digest mismatch");
  verifySources(root, packet.manifest);
  for (const file of packet.files) {
    const actual = readPlatformAudioPin(path.join(directory, file.file), directory, file.bytes);
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw Error("Packet readback mismatch");
  }
  const sums = readPlatformAudioJson(path.join(directory, "checksums.json"), directory, ONE);
  if (platformAudioHash(sums.value) !== platformAudioHash(packet.files)) throw Error("Packet checksum table mismatch");
  const report = readPlatformAudioJson(
    path.join(root, packet.checkReport.file),
    path.join(root, "public/projects", packet.projectId),
    ONE,
  );
  if (
    report.sha256 !== packet.checkReport.sha256 ||
    platformAudioHash(semantic(DeliveryManifestSchema.parse(report.value))) !==
      platformAudioHash(semantic(packet.manifest))
  )
    throw Error("Historical packet report changed");
}
/** Fresh trusted service checks own authorization; no check/copy resume or receipt downgrade. */
export function nativePacket(
  root: string,
  request: DeliveryRequest,
  check: () => CheckedNativeDelivery,
  recover?: string,
) {
  if (recover && !/^[a-f0-9]{64}$/.test(recover)) throw Error("Recovery requires exact content ID");
  const expected = expectedPacket(root, request, check()),
    scope = path.join(root, "out", request.projectId),
    directory = path.join(scope, "handoffs", recover ?? expected.packet.id),
    marker = path.join(directory, "handoff.json");
  if (recover && recover !== expected.packet.id) throw Error("Recovery content/source/gates changed");
  let old: PlatformAudioPacket | undefined;
  try {
    old = PlatformAudioPacketSchema.parse(readPlatformAudioJson(marker, scope, ONE).value);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (old) {
    if (
      old.id !== expected.packet.id ||
      platformAudioHash(semantic(old.manifest)) !== platformAudioHash(semantic(expected.packet.manifest)) ||
      platformAudioHash(old.files) !== platformAudioHash(expected.packet.files)
    )
      throw Error("Immutable marker content conflict");
    readback(root, directory, old);
  } else {
    if (recover) throw Error("Recovery marker absent; no copy/replay");
    platformAudioDirectory(directory, scope);
    for (const file of expected.files) {
      const target = path.join(directory, file.file);
      if (file.source) copyPlatformAudioFile(file.source, scope, target, scope, file.sha256);
      else
        writePlatformAudioBytes(
          target,
          scope,
          file.content!,
          file.file.endsWith(".srt") || file.file.endsWith(".vtt") ? 4 * ONE : ONE,
        );
    }
    writePlatformAudioBytes(path.join(directory, "checksums.json"), scope, bytes(expected.packet.files));
    readback(root, directory, expected.packet);
  }
  const current = expectedPacket(root, request, check());
  if (current.packet.id !== expected.packet.id) throw Error("Native current gates/source changed before marker");
  readback(root, directory, old ?? expected.packet);
  if (!old) writePlatformAudioBytes(marker, scope, bytes(expected.packet));
  const final = PlatformAudioPacketSchema.parse(readPlatformAudioJson(marker, scope, ONE).value);
  if (final.id !== expected.packet.id) throw Error("Packet final marker mismatch");
  readback(root, directory, final);
  return {
    marker,
    packetId: final.id,
    sha256: readPlatformAudioPin(marker, scope, ONE).sha256,
    state: "draft-needs-review" as const,
    productionReady: false as const,
    status: "pending-manual" as const,
    recovered: !!recover,
  };
}
