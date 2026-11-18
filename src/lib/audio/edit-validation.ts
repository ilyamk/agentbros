import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CliErrorObject } from "../cli";
import type { TimelineIR, EditCommand } from "../../types/timeline";
import { readAssetRegistry } from "../assets/registry";
import { numeric } from "../timeline-ir/rational";
/** Fingerprint a regular project original before and after the bounded physical probe. */
function fingerprint(file: string, hash: string) {
  if (realpathSync(file) !== file) throw new Error("Audio original must not use symlinks");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
      throw new Error("Audio loop edit requires a regular original within the 128MiB validation bound");
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0,
      size: number;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += size;
      if (bytes > stat.size) throw new Error("Audio original changed while validating");
      digest.update(buffer.subarray(0, size));
    }
    const after = fstatSync(fd);
    if (bytes !== stat.size || digest.digest("hex") !== hash)
      throw new Error("Immutable audio original checksum mismatch");
    const identity = (s: typeof stat) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    if (identity(stat) !== identity(after)) throw new Error("Audio original changed while validating");
    return identity(after);
  } finally {
    closeSync(fd);
  }
}
function physicalDuration(file: string, hash: string, registered: number) {
  const before = fingerprint(file, hash);
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true },
  );
  if (fingerprint(file, hash) !== before) throw new Error("Audio original changed while probing");
  if (probe.error && "code" in probe.error && probe.error.code === "ENOENT")
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffprobe is required to validate physical audio duration; install ffmpeg before editing loops",
    });
  if (probe.error || probe.status !== 0) throw new Error("Bounded physical audio duration probe failed");
  let result: { streams?: Array<{ duration?: unknown }> };
  try {
    result = JSON.parse(probe.stdout);
  } catch {
    throw new Error("Invalid physical audio duration probe output");
  }
  const raw = result.streams?.[0]?.duration;
  const duration = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Original has no verified finite audio stream duration");
  if (Math.abs(duration - registered) > 0.001)
    throw new Error(
      "Registered audio duration differs from physical original; restore verified import metadata before editing loops",
    );
  return { duration, identity: before };
}
/** Project routes validate impacted music/SFX positioning/trim/loop edits against final batch state and original evidence. */
export function assertProjectAudioEdits(
  timeline: TimelineIR,
  command: EditCommand,
  projectId: string,
  rootDir = process.cwd(),
) {
  const bindings: Array<{ trackId: string; clipId: string }> = [];
  const visit = (cmd: EditCommand): void => {
    if (cmd.type === "batch") cmd.commands.forEach(visit);
    else if (
      cmd.type === "audio-loop" ||
      ((cmd.type === "move" || cmd.type === "trim") &&
        timeline.tracks.some((t) => t.id === cmd.trackId && (t.kind === "music" || t.kind === "sfx")))
    )
      bindings.push(cmd);
  };
  visit(command);
  if (!bindings.length) return;
  if (timeline.projectId !== projectId) throw new Error("Audio edit project binding differs");
  rootDir = realpathSync(rootDir);
  const registry = readAssetRegistry(projectId, rootDir),
    checked = new Map<string, { duration: number; identity: string; file: string; hash: string }>();
  const project = path.resolve(rootDir, "public/projects", projectId);
  for (const binding of bindings) {
    const clip = timeline.tracks.find((t) => t.id === binding.trackId)?.clips.find((c) => c.id === binding.clipId);
    if (!clip) throw new Error("Audio loop clip binding no longer exists");
    if (clip.payload?.loop === true && clip.source.start.num !== 0)
      throw new Error(
        "Loop edits require zero source origin; nonzero trimmed loops differ between playback and the local mixer",
      );
    const asset = registry.assets.find((a) => a.id === clip.assetId),
      registered = asset?.media.durationSec;
    if (
      !asset ||
      asset.kind !== "audio" ||
      typeof registered !== "number" ||
      !Number.isFinite(registered) ||
      registered <= 0
    )
      throw new Error(
        "Loop edits require an imported original with verified duration; import the original before editing",
      );
    let verified = checked.get(asset.id);
    if (!verified) {
      const file = path.resolve(rootDir, "public", asset.files.original);
      if (!file.startsWith(project + path.sep) || realpathSync(project) !== project || realpathSync(file) !== file)
        throw new Error("Audio original must be local to the project without symlinks");
      verified = { ...physicalDuration(file, asset.hash, registered), file, hash: asset.hash };
      checked.set(asset.id, verified);
    }
    if (
      clip.payload?.loop !== true &&
      numeric(clip.source.end) / numeric(clip.source.timebase) > verified.duration + 0.001
    )
      throw new Error(
        "Audio edit would exceed original duration; disabling loop requires explicitly trimming the music/SFX source in the same batch",
      );
  }
  // Recheck every probed source immediately before returning to the locked journal writer.
  for (const original of checked.values())
    if (fingerprint(original.file, original.hash) !== original.identity)
      throw new Error("Audio original changed after probing");
}
