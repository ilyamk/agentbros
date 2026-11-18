import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin } from "../cli";
import { loadMemory } from "../memory";
import { agreedPairs } from "../film/creative-rubric";
import { probeVideo } from "../vision/media";

export const IMPROVEMENT_AXES = ["composition", "light", "material", "motion", "realism"] as const;
const text = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scores = z
  .object({
    composition: z.number().min(1).max(5),
    light: z.number().min(1).max(5),
    material: z.number().min(1).max(5),
    motion: z.number().min(1).max(5),
    realism: z.number().min(1).max(5),
  })
  .strict();
const asset = z
  .object({
    file: z.string().regex(/^[a-f0-9]{64}\.(png|mp4)$/),
    sha256: digest,
    frame: z.number().int().nonnegative(),
  })
  .strict();
export const ImprovementPacketSchema = z
  .object({
    version: z.literal(1),
    id: digest,
    reference: text,
    slop: z.array(text).min(1),
    A: z.array(asset).min(1),
    B: z.array(asset).min(1),
  })
  .strict();
const mapping = z
  .object({
    id: digest,
    A: z.enum(["baseline", "candidate"]),
    B: z.enum(["baseline", "candidate"]),
    packetHash: digest,
  })
  .strict()
  .refine((v) => v.A !== v.B);
export const ImprovementKeySchema = z
  .object({
    version: z.literal(1),
    packets: z.array(mapping).length(2),
    sources: z.object({ baseline: text, candidate: text }).strict(),
  })
  .strict()
  .refine((v) => v.packets[0]!.A !== v.packets[1]!.A && v.packets[0]!.id !== v.packets[1]!.id);
export const BlenderCritiqueSchema = z
  .object({
    packetId: digest,
    winner: z.enum(["A", "B", "tie"]),
    A: scores,
    B: scores,
    evidence: z
      .array(
        z
          .object({ label: z.enum(["A", "B"]), file: text, frame: z.number().int().nonnegative(), observation: text })
          .strict(),
      )
      .min(2),
    motionEvidence: z.enum(["sequence", "sampled-frames", "still-only"]),
    reason: text,
    gaps: z.array(text),
  })
  .strict();
const evidencePath = text.refine(
  (v) => !path.isAbsolute(v) && !/^[A-Za-z]:[\\/]/.test(v) && !v.split(/[\\/]/).includes(".."),
  "Check evidence must use repository-relative paths",
);
const gate = z.object({ pass: z.boolean(), evidence: z.array(evidencePath).min(1) }).strict();
export const ImprovementChecksSchema = z.object({ sensors: gate, tests: gate }).strict();
export const ImprovementScoreSchema = z
  .object({
    version: z.literal(1),
    verdict: z.enum(["keep", "revert"]),
    agreed: z.boolean(),
    winner: z.enum(["baseline", "candidate", "none"]),
    reviews: z.number().int().min(2),
    baseline: scores,
    candidate: scores,
    delta: z
      .object({
        composition: z.number(),
        light: z.number(),
        material: z.number(),
        motion: z.number(),
        realism: z.number(),
      })
      .strict(),
    experimental: z.boolean(),
    checks: ImprovementChecksSchema,
    checkHashes: z.object({ sensors: z.array(digest).min(1), tests: z.array(digest).min(1) }).strict(),
    packetHashes: z.array(digest).length(2),
    critiqueHashes: z.array(digest).min(2),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.reviews !== v.critiqueHashes.length ||
      new Set(v.critiqueHashes).size !== v.reviews ||
      new Set(v.packetHashes).size !== 2
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Score evidence must be unique and complete" });
    if (IMPROVEMENT_AXES.some((axis) => Math.abs(v.delta[axis] - (v.candidate[axis] - v.baseline[axis])) > 1e-9))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Score deltas disagree with means" });
    if (
      v.verdict === "keep" &&
      (!v.agreed || v.winner !== "candidate" || !v.checks.sensors.pass || !v.checks.tests.pass)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Keep requires both-order agreement and passing checks" });
  });
const gap = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    target: text,
    summary: text,
    capability: text,
    severity: z.number().int().min(1).max(5),
    status: z.enum(["open", "resolved"]),
  })
  .strict();
export const ImprovementLogSchema = z
  .object({
    version: z.literal(1),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    recordedAt: z
      .string()
      .datetime()
      .default(() => new Date().toISOString()),
    target: text,
    reference: text,
    weakness: text,
    diagnosis: text,
    cause: z.enum(["system", "shot"]),
    change: z
      .object({
        type: z.enum(["recipe-default", "kit", "material", "sensor", "rule", "new-tool-candidate", "asset-collection"]),
        description: text,
        expectedEffect: text,
      })
      .strict(),
    ab: ImprovementScoreSchema,
    decision: z.enum(["kept", "reverted"]),
    gaps: z.array(gap),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.decision === "kept" &&
      (v.ab.verdict !== "keep" ||
        !v.ab.agreed ||
        v.ab.winner !== "candidate" ||
        !v.ab.checks.tests.pass ||
        !v.ab.checks.sensors.pass)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Kept changes require a blind both-orders win and passing sensors/tests",
      });
  });
export const BlenderAdviceSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            rank: z.number().int().min(1).max(3),
            type: z.enum([
              "recipe-default",
              "kit",
              "material",
              "sensor",
              "rule",
              "new-tool-candidate",
              "asset-collection",
            ]),
            target: text,
            diagnosis: text,
            expectedEffect: text,
            abTest: text,
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const writeNew = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const encodedHash = (value: unknown) => sha256(JSON.stringify(value));

function mediaFiles(input: string) {
  const resolved = realpathSync(input);
  if (statSync(resolved).isFile()) {
    if (!/\.(png|mp4)$/i.test(resolved)) throw new Error("Packet inputs must be PNG, MP4 or a frame directory");
    return [{ source: resolved, frame: 0 }];
  }
  const directory = existsSync(path.join(resolved, "frames")) ? path.join(resolved, "frames") : resolved;
  const files = readdirSync(directory)
    .filter((n) => /^(?:frame[-_]?)?\d+\.png$/i.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) throw new Error(`No numbered PNG frames in ${input}`);
  const indices = [
    ...new Set(
      Array.from({ length: Math.min(5, files.length) }, (_, i) =>
        Math.round((i * (files.length - 1)) / Math.max(1, Math.min(5, files.length) - 1)),
      ),
    ),
  ];
  return indices.map((i) => {
    const source = path.join(directory, files[i]!);
    assertPathWithin(resolved, realpathSync(source));
    return { source, frame: Number(/\d+/.exec(files[i]!)![0]) };
  });
}

function mediaShape(file: string) {
  if (file.toLowerCase().endsWith(".mp4")) {
    const v = probeVideo(file);
    return [v.width, v.height, v.fps, v.frameCount, v.durationSec];
  }
  const bytes = readFileSync(file);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("Invalid PNG input");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/** Re-encode payloads, excluding source paths, PNG metadata, MP4 metadata and sidecars. The key never enters a packet. */
export function buildImprovementPackets(options: {
  baseline: string;
  candidate: string;
  output: string;
  reference: string;
  seed?: string;
}) {
  const sources = { baseline: mediaFiles(options.baseline), candidate: mediaFiles(options.candidate) };
  if (
    sources.baseline.length !== sources.candidate.length ||
    sources.baseline.some(
      (v, i) =>
        v.frame !== sources.candidate[i]!.frame ||
        path.extname(v.source) !== path.extname(sources.candidate[i]!.source),
    )
  )
    throw new Error("A/B inputs need matching frame coverage and formats");
  for (let i = 0; i < sources.baseline.length; i++)
    if (
      JSON.stringify(mediaShape(sources.baseline[i]!.source)) !==
      JSON.stringify(mediaShape(sources.candidate[i]!.source))
    )
      throw new Error("A/B dimensions, duration, fps and frame count must match");
  const output = path.resolve(options.output),
    salt = options.seed ?? randomBytes(32).toString("hex");
  mkdirSync(output, { recursive: false });
  const packets: z.infer<typeof ImprovementKeySchema>["packets"] = [];
  for (const order of [0, 1]) {
    const id = sha256(`${salt}:${order}`),
      directory = path.join(output, id);
    mkdirSync(directory);
    const labels =
      order === 0 ? ({ A: "baseline", B: "candidate" } as const) : ({ A: "candidate", B: "baseline" } as const);
    const payload: Record<"A" | "B", z.infer<typeof asset>[]> = { A: [], B: [] };
    for (const label of ["A", "B"] as const)
      for (const item of sources[labels[label]]) {
        const extension = path.extname(item.source).toLowerCase(),
          file = `${sha256(`${salt}:${order}:${label}:${sha256(readFileSync(item.source))}`)}${extension}`;
        const args = [
          "-v",
          "error",
          "-nostdin",
          "-i",
          item.source,
          "-map",
          "0:v:0",
          "-map_metadata",
          "-1",
          "-an",
          "-sn",
          "-threads",
          "1",
        ];
        if (extension === ".mp4") args.push("-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p");
        else args.push("-frames:v", "1");
        const result = spawnSync("ffmpeg", [...args, path.join(directory, file)], {
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        });
        if (result.error || result.status !== 0)
          throw new Error(
            `Cannot sanitise packet media: ${result.error?.message ?? result.stderr.toString().slice(-500)}`,
          );
        payload[label].push({ file, frame: item.frame, sha256: sha256(readFileSync(path.join(directory, file))) });
      }
    const packet = ImprovementPacketSchema.parse({
      version: 1,
      id,
      reference: options.reference,
      slop: [
        "Unmotivated camera drift or constant-speed turntable",
        "Floating objects or absent contact shadows",
        "Uniform plastic materials, over-lit colours or generic teal-on-grey staging",
        "Motion without anticipation, weight or a readable settle",
        "Clipped light, unreadable subject or arbitrary decoration",
      ],
      ...payload,
    });
    writeNew(path.join(directory, "packet.json"), packet);
    packets.push({ id, ...labels, packetHash: encodedHash(packet) });
  }
  const key = ImprovementKeySchema.parse({
    version: 1,
    packets,
    sources: { baseline: path.resolve(options.baseline), candidate: path.resolve(options.candidate) },
  });
  writeNew(path.join(output, "key.json"), key);
  return { key: path.join(output, "key.json"), packets: packets.map((p) => path.join(output, p.id, "packet.json")) };
}

export function validatePacket(file: string) {
  const packet = ImprovementPacketSchema.parse(read(file));
  for (const item of [...packet.A, ...packet.B]) {
    const target = path.join(path.dirname(file), item.file);
    assertPathWithin(realpathSync(path.dirname(file)), realpathSync(target));
    if (sha256(readFileSync(target)) !== item.sha256) throw new Error("Packet media hash mismatch");
  }
  return packet;
}

export function scoreImprovement(
  keyFile: string,
  resultFiles: string[],
  checksInput: unknown,
  evidenceRoot = process.cwd(),
) {
  const key = ImprovementKeySchema.parse(read(keyFile)),
    checks = ImprovementChecksSchema.parse(checksInput);
  const checkHashes = { sensors: [] as string[], tests: [] as string[] };
  for (const kind of ["sensors", "tests"] as const)
    for (const evidence of checks[kind].evidence) {
      const file = realpathSync(path.resolve(evidenceRoot, evidence));
      assertPathWithin(realpathSync(evidenceRoot), file);
      const bytes = readFileSync(file),
        report = z.object({ pass: z.boolean() }).passthrough().parse(JSON.parse(bytes.toString()));
      if (checks[kind].pass && !report.pass) throw new Error(`Claimed passing ${kind} evidence failed: ${evidence}`);
      checkHashes[kind].push(sha256(bytes));
    }
  const packets = key.packets.map((p) => {
    const packet = validatePacket(path.join(path.dirname(keyFile), p.id, "packet.json"));
    if (encodedHash(packet) !== p.packetHash) throw new Error("Packet changed since blinding");
    return packet;
  });
  const files = resultFiles.map((f) => realpathSync(f));
  if (new Set(files).size !== files.length) throw new Error("Duplicate critic result");
  const critiqueHashes = files.map((f) => sha256(readFileSync(f)));
  if (new Set(critiqueHashes).size !== files.length) throw new Error("Duplicate critic response bytes");
  const critiques = files.map((f) => BlenderCritiqueSchema.parse(read(f)));
  if (packets[0]!.A.every((a, i) => a.sha256 === packets[0]!.B[i]?.sha256))
    throw new Error("Identical A/B media cannot prove an improvement");
  if (critiques.length < 2 || key.packets.some((p) => !critiques.some((c) => c.packetId === p.id)))
    throw new Error("Need fresh critics covering both orders");
  const mapped = critiques.map((c) => {
    const m = key.packets.find((p) => p.id === c.packetId),
      packet = packets.find((p) => p.id === c.packetId);
    if (!m || !packet) throw new Error("Unknown critic packet");
    for (const label of ["A", "B"] as const)
      if (!c.evidence.some((e) => e.label === label)) throw new Error("Critic must cite both labels");
    for (const e of c.evidence)
      if (!packet[e.label].some((a) => a.file === e.file && (a.file.endsWith(".mp4") || a.frame === e.frame)))
        throw new Error("Critic cites an unknown frame");
    return { c, m, winner: c.winner === "tie" ? "tie" : m[c.winner] };
  });
  // Reject conflicting duplicates rather than letting the last judgement replace the first.
  const unanimous = new Set(mapped.map((v) => v.winner)).size === 1;
  const pairs = agreedPairs(mapped.map((v) => ({ first: v.m.A, second: v.m.B, winner: v.winner })));
  const agreed = unanimous && pairs[0]!.agreed;
  const winner = agreed ? (mapped[0]!.winner as "baseline" | "candidate") : "none";
  const average = (kind: "baseline" | "candidate") =>
    Object.fromEntries(
      IMPROVEMENT_AXES.map((axis) => [
        axis,
        mapped.reduce((sum, v) => sum + v.c[v.m.A === kind ? "A" : "B"][axis], 0) / mapped.length,
      ]),
    ) as z.infer<typeof scores>;
  const baseline = average("baseline"),
    candidate = average("candidate");
  const experimental = mapped.some(
    (v) =>
      IMPROVEMENT_AXES.some((axis) => v.c[v.m.A === "candidate" ? "A" : "B"][axis] < 3) ||
      v.c.motionEvidence === "still-only",
  );
  return ImprovementScoreSchema.parse({
    version: 1,
    verdict: agreed && winner === "candidate" && checks.sensors.pass && checks.tests.pass ? "keep" : "revert",
    agreed,
    winner,
    reviews: critiques.length,
    baseline,
    candidate,
    delta: Object.fromEntries(IMPROVEMENT_AXES.map((axis) => [axis, candidate[axis] - baseline[axis]])),
    experimental,
    checks,
    checkHashes,
    packetHashes: key.packets.map((p) => p.packetHash),
    critiqueHashes,
  });
}

export function appendImprovement(input: unknown, root = process.cwd()) {
  const entry = ImprovementLogSchema.parse(input),
    directory = path.join(root, "blender-arsenal/improvements");
  assertPathWithin(root, directory);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${entry.date}-${entry.slug}.json`);
  writeNew(file, entry);
  return file;
}
export function improvementHistory(root = process.cwd(), target?: string) {
  const directory = path.join(root, "blender-arsenal/improvements");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = path.join(directory, name);
      assertPathWithin(realpathSync(directory), realpathSync(file));
      const entry = ImprovementLogSchema.parse(read(file));
      if (name !== `${entry.date}-${entry.slug}.json`) throw new Error("Improvement log filename mismatch");
      return { file: path.relative(root, file), ...entry };
    })
    .filter((v) => !target || v.target === target)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.recordedAt.localeCompare(b.recordedAt) || a.file.localeCompare(b.file),
    );
}

/** Latest explicit status wins for a stable target/id; local memory never enters tracked logs automatically. */
export function improvementGaps(root = process.cwd(), memoryRoot?: string) {
  const grouped = new Map<
    string,
    {
      id: string;
      target: string;
      summary: string;
      capability: string;
      severity: number;
      occurrences: number;
      sources: string[];
      status: string;
    }
  >();
  for (const entry of improvementHistory(root))
    for (const g of entry.gaps) {
      const id = `${g.target}:${g.id}`,
        before = grouped.get(id);
      grouped.set(id, {
        ...g,
        occurrences: (before?.occurrences ?? 0) + 1,
        sources: [...(before?.sources ?? []), entry.file],
        status: g.status,
      });
    }
  for (const m of loadMemory(memoryRoot ?? root).entries.filter(
    (m) => m.type === "gap" && m.status === "active" && /blender/i.test(`${m.summary} ${m.body ?? ""}`),
  )) {
    const matched = [...grouped.values()].find((g) => `${m.summary} ${m.body ?? ""}`.includes(g.id));
    if (matched) {
      matched.occurrences += m.occurrences;
      matched.sources.push(`memory:${m.id}`);
    } else
      grouped.set(`memory:${m.id}`, {
        id: m.id,
        target: "blender",
        summary: m.summary,
        capability: "unclassified",
        severity: 3,
        occurrences: m.occurrences,
        sources: [`memory:${m.id}`],
        status: "open",
      });
  }
  return [...grouped.values()]
    .filter((g) => g.status === "open")
    .sort((a, b) => b.severity - a.severity || b.occurrences - a.occurrences || a.id.localeCompare(b.id));
}

/** One fresh process per call. Never resume a critic or give it the key, source, diagnosis or another critic's answer. */
export function runImprovementHarness(options: { role: "critic" | "advisor"; input: string; timeoutSec?: number }) {
  const input = path.resolve(options.input),
    directory = path.dirname(input);
  const data = options.role === "critic" ? validatePacket(input) : read(input);
  const instruction =
    options.role === "critic"
      ? `Judge only this blind packet against its reference and slop list. Open every supplied image. Score each label on composition/light/material/motion/realism, 1–5. Cite file and frame for both. Do not infer which is newer. Prefer the label visibly closer to the reference, or tie. Sampled frames cannot prove full motion. Return JSON only: {packetId,winner:"A"|"B"|"tie",A:{composition,light,material,motion,realism},B:{composition,light,material,motion,realism},evidence:[{label,file,frame,observation}],motionEvidence:"sequence"|"sampled-frames"|"still-only",reason,gaps:[string]}. Do not inspect any files outside this packet directory. Never spawn agents.`
      : `Read supplied critiques, gap log, arsenal status/candidates and history only. Propose at most 3 ranked SYSTEM changes. Return JSON only: {changes:[{rank,type:"recipe-default"|"kit"|"material"|"sensor"|"rule"|"new-tool-candidate"|"asset-collection",target,diagnosis,expectedEffect,abTest}]}. Separate shot causes from repeatable system causes. Never spawn agents.`;
  const images =
    options.role === "critic"
      ? [...(data as z.infer<typeof ImprovementPacketSchema>).A, ...(data as z.infer<typeof ImprovementPacketSchema>).B]
          .filter((v) => v.file.endsWith(".png"))
          .flatMap((v) => ["-i", path.join(directory, v.file)])
      : [];
  const prompt = `${instruction}\n${JSON.stringify(data)}`;
  const result = spawnSync(
    process.env.BLENDER_IMPROVE_HARNESS_BIN ?? "codex",
    [
      "exec",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-6.1-sol",
      "--skip-git-repo-check",
      "-c",
      "project_doc_max_bytes=0",
      "-C",
      directory,
      ...images,
      "-",
    ],
    { input: prompt, encoding: "utf8", timeout: (options.timeoutSec ?? 360) * 1000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Fresh ${options.role} failed: ${result.error?.message ?? result.stderr.slice(-500)}`);
  const response = JSON.parse(result.stdout.trim());
  return options.role === "critic" ? BlenderCritiqueSchema.parse(response) : BlenderAdviceSchema.parse(response);
}
