import { spawnSync } from "node:child_process";
import path from "node:path";
import { NoveltyConfigSchema } from "../../types/contrib";
import { PlaybookSchema, type Playbook } from "../../types/playbook";
import { commitOf, repositoryText, type RepositoryText } from "../context/repository";
import { CATALOGUE_PATH, type Catalogue, type CatalogueItem } from "../library/catalogue";
import { matchAgainst } from "../playbooks/match";
import { parseChangeEntry } from "./changes";
import { changedFiles, gitBytes } from "./git";

const STOP_WORDS = new Set(
  "a an and are as at be been by for from has have in into is it its of on or that the their this to using was were with".split(
    " ",
  ),
);
const tokens = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !STOP_WORDS.has(word));

/** One shared vocabulary and smoothed IDF for the query and all its neighbours. */
export function textSimilarities(query: string, documents: string[]): number[] {
  const rows = [query, ...documents].map(tokens);
  const frequency = new Map<string, number>();
  for (const row of rows) for (const word of new Set(row)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const vectors = rows.map((row) => {
    const vector = new Map<string, number>();
    for (const word of row) vector.set(word, (vector.get(word) ?? 0) + 1);
    for (const [word, count] of vector)
      vector.set(word, count * (1 + Math.log((rows.length + 1) / (frequency.get(word)! + 1))));
    const norm = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0));
    return new Map([...vector].map(([word, value]) => [word, value / (norm || 1)]));
  });
  return vectors.slice(1).map((vector) =>
    Math.min(
      1,
      [...vectors[0]!].reduce((sum, [word, value]) => sum + value * (vector.get(word) ?? 0), 0),
    ),
  );
}

export function differenceHash(pixels: Uint8Array): bigint {
  if (pixels.length !== 72) throw new Error("dHash requires a 9×8 greyscale image.");
  let hash = 0n;
  for (let row = 0; row < 8; row++)
    for (let column = 0; column < 8; column++) {
      hash = (hash << 1n) | (pixels[row * 9 + column]! > pixels[row * 9 + column + 1]! ? 1n : 0n);
    }
  return hash;
}
export function hammingDistance(left: bigint, right: bigint): number {
  let bits = left ^ right,
    distance = 0;
  while (bits) {
    distance++;
    bits &= bits - 1n;
  }
  return distance;
}
export type ImageHash = { hash: bigint; reason?: never } | { hash?: never; reason: string };
export function previewHash(bytes: Buffer): ImageHash {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "pipe",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=9:8,format=gray",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { input: bytes, timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    return { reason: "ffmpeg is unavailable; image comparison skipped." };
  if (result.error || result.status !== 0)
    throw new Error(`Cannot hash preview: ${result.error?.message ?? result.stderr.toString().slice(-500)}`);
  return { hash: differenceHash(result.stdout) };
}

interface Neighbour {
  id: string;
  score: number;
}
interface ImageNeighbour {
  id: string;
  distance: number;
}
export interface NoveltyItem {
  kind: "block" | "playbook";
  id: string;
  nearest: Neighbour[];
  images: ImageNeighbour[];
  skipped: { id: string; reason: string }[];
  outranked: { trigger: string; id: string; score: number; ownScore: number }[];
  overlaps: string[];
  justified: boolean;
}
export interface NoveltyReport {
  base: string;
  head: string;
  items: NoveltyItem[];
  blocking: string[];
  justification?: string;
}

function catalogue(repo: RepositoryText): CatalogueItem[] {
  const source = repo.read(CATALOGUE_PATH);
  if (!source) return [];
  const parsed = JSON.parse(source) as Catalogue;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.items) ||
    parsed.items.some(
      (item) => typeof item.id !== "string" || typeof item.title !== "string" || typeof item.description !== "string",
    )
  )
    throw new Error("Invalid library catalogue for novelty checking.");
  if (new Set(parsed.items.map((item) => item.id)).size !== parsed.items.length)
    throw new Error("Duplicate catalogue ids.");
  return parsed.items;
}
function playbooks(repo: RepositoryText): Playbook[] {
  return repo.files
    .filter((file) => /^playbooks\/[^/]+\/playbook\.json$/.test(file))
    .map((file) => {
      const playbook = PlaybookSchema.parse(JSON.parse(repo.read(file)!));
      if (file !== `playbooks/${playbook.id}/playbook.json`)
        throw new Error(`Playbook id disagrees with its path: ${file}`);
      return playbook;
    });
}
const blockText = (item: CatalogueItem) => `${item.title} ${item.description}`;
const playbookText = (item: Playbook) =>
  `${item.summary} ${[...item.triggers.en, ...item.triggers.ru, ...(item.triggers.zh ?? [])].join(" ")}`;

function neighbours<T extends { id: string }>(subject: T, peers: T[], text: (item: T) => string): Neighbour[] {
  const scores = textSimilarities(text(subject), peers.map(text));
  return peers
    .map((peer, index) => ({ id: peer.id, score: scores[index]! }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
const emptyItem = (kind: NoveltyItem["kind"], id: string): NoveltyItem => ({
  kind,
  id,
  nearest: [],
  images: [],
  skipped: [],
  outranked: [],
  overlaps: [],
  justified: false,
});
function justifies(justification: string | undefined, ids: string[]): boolean {
  if (!ids.length || !justification) return false;
  let explanation = justification;
  // The gate verifies an id and an explanation are present; maintainers judge the explanation's merit.
  for (const id of ids) {
    const mention = new RegExp(`(^|[^a-zA-Z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-zA-Z0-9-])`, "g");
    if (!mention.test(justification)) return false;
    explanation = explanation.replace(mention, "$1 ");
  }
  return tokens(explanation).length >= 2;
}

export function checkNovelty(
  options: { root: string; base: string; head?: string },
  hashImage: (bytes: Buffer) => ImageHash = previewHash,
): NoveltyReport {
  const { root } = options;
  const base = commitOf(root, options.base),
    head = commitOf(root, options.head ?? "HEAD");
  const before = repositoryText(root, base),
    after = repositoryText(root, head);
  const config = NoveltyConfigSchema.parse(
    JSON.parse(
      before.read("contrib/novelty.json") /* trusted base only: a PR must not relax its own thresholds */ ?? "null",
    ),
  );
  const files = changedFiles(root, base, head);
  const entries = files.filter(
    (file) => file.status === "A" && /^\.changes\/[^/]+\.md$/.test(file.path) && file.path !== ".changes/README.md",
  );
  const justification =
    entries.length === 1 ? parseChangeEntry(entries[0]!.content!, entries[0]!.path).novelty : undefined;
  const report: NoveltyReport = { base, head, items: [], blocking: [], ...(justification ? { justification } : {}) };
  const oldBlocks = catalogue(before),
    newBlocks = catalogue(after);
  const oldById = new Map(oldBlocks.map((item) => [item.id, item]));
  const blockPool = [...new Map([...oldBlocks, ...newBlocks].map((item) => [item.id, item])).values()];
  const hashCache = new Map<string, ImageHash>();
  const image = (item: CatalogueItem, repo: RepositoryText, commit: string): ImageHash => {
    const choices = [
      item.preview?.image,
      ...["jpg", "png", "webp"].map((extension) => `docs/library/previews/${item.id}.${extension}`),
    ].filter((file): file is string => !!file);
    const file = choices.find(
      (candidate) =>
        !path.isAbsolute(candidate) &&
        !candidate.split("/").some((part) => part === ".." || part === ".env" || part.startsWith(".env.")) &&
        repo.exists(candidate),
    );
    if (!file) return { reason: "Preview is missing; image comparison skipped." };
    const key = `${commit}:${file}`;
    if (!hashCache.has(key)) hashCache.set(key, hashImage(gitBytes(root, commit, file)));
    return hashCache.get(key)!;
  };
  for (const subject of newBlocks.filter((item) => JSON.stringify(item) !== JSON.stringify(oldById.get(item.id)))) {
    const result = emptyItem("block", subject.id);
    const peers = blockPool.filter((item) => item.id !== subject.id);
    const nearest = neighbours(subject, peers, blockText);
    result.nearest = nearest.slice(0, 3);
    result.overlaps = nearest.filter((item) => item.score > config.text.block).map((item) => item.id);
    const ownHash = image(subject, after, head);
    if (ownHash.hash === undefined) result.skipped.push({ id: subject.id, reason: ownHash.reason });
    else
      for (const peer of peers) {
        let hash = image(peer, after, head);
        if (hash.hash === undefined && hash.reason.startsWith("Preview is missing") && oldById.has(peer.id))
          hash = image(oldById.get(peer.id)!, before, base);
        if (hash.hash === undefined) result.skipped.push({ id: peer.id, reason: hash.reason });
        else {
          const distance = hammingDistance(ownHash.hash, hash.hash);
          result.images.push({ id: peer.id, distance });
          if (distance <= config.image.maxHammingDistance) result.overlaps.push(peer.id);
        }
      }
    result.images.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    result.images = result.images.slice(0, 3);
    report.items.push(result);
  }
  const oldPlaybooks = playbooks(before),
    newPlaybooks = playbooks(after);
  const oldIds = new Set(oldPlaybooks.map((item) => item.id));
  const playbookPool = [...new Map([...oldPlaybooks, ...newPlaybooks].map((item) => [item.id, item])).values()];
  for (const subject of newPlaybooks.filter((item) => !oldIds.has(item.id))) {
    const result = emptyItem("playbook", subject.id);
    const peers = playbookPool.filter((item) => item.id !== subject.id);
    const nearest = neighbours(subject, peers, playbookText);
    result.nearest = nearest.slice(0, 3);
    result.overlaps = nearest.filter((item) => item.score > config.text.playbook).map((item) => item.id);
    for (const trigger of [
      ...subject.triggers.en,
      ...(subject.variants ?? []).flatMap((variant) => variant.triggers.en),
    ]) {
      const candidates = matchAgainst(trigger, [subject, ...peers]).candidates;
      const ownScore = candidates.find((item) => item.id === subject.id)?.score ?? 0;
      const ownIndex = candidates.findIndex((item) => item.id === subject.id);
      for (const candidate of candidates.slice(0, ownIndex < 0 ? undefined : ownIndex)) {
        result.outranked.push({ trigger, id: candidate.id, score: candidate.score, ownScore });
        result.overlaps.push(candidate.id);
      }
    }
    report.items.push(result);
  }
  for (const item of report.items) {
    item.overlaps = [...new Set(item.overlaps)].sort();
    item.justified = justifies(justification, item.overlaps);
    if (item.overlaps.length && !item.justified) report.blocking.push(`${item.kind}:${item.id}`);
  }
  return report;
}
