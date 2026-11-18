import { createHash } from "node:crypto";
import path from "node:path";
import { normaliseWords } from "../leak-scan";
import { descriptionOf, isAgent, isInstruction, isSkill, type RepositoryText } from "./repository";

export type InstructionFinding = {
  fingerprint: string;
  severity: "block" | "warn";
  code: string;
  file: string;
  line: number;
  message: string;
};
export type InstructionBaseline = { version: 1; fingerprints: string[] };
type Paragraph = { file: string; line: number; text: string; shingles: Set<string> };

const BUILT_INS = new Set([
  "add",
  "install",
  "i",
  "exec",
  "dlx",
  "run",
  "test",
  "remove",
  "update",
  "up",
  "audit",
  "outdated",
  "list",
  "ls",
  "why",
  "help",
  "version",
  "publish",
  "pack",
  "store",
  "config",
  "env",
  "setup",
  "doctor",
  "tsx",
]);

function withoutFences(text: string): string[] {
  let fence: string | undefined;
  return text.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return "";
    }
    return fence ? "" : line;
  });
}

function paragraphs(file: string, lines: string[]): Paragraph[] {
  const out: Paragraph[] = [];
  let buffer: string[] = [];
  let start = 0;
  const flush = () => {
    const text = buffer.join(" ");
    const words = normaliseWords(text);
    const pointer =
      buffer.length === 1 &&
      /(?:\[[^\]]+\]\(|`[^`]+\/[^`]+`)/.test(text) &&
      /^(?:[-*]\s*)?(?:see|read|follow|use|guide|details|instructions)\b/i.test(text) &&
      words.length < 30;
    if (words.length >= 8 && !pointer)
      out.push({
        file,
        line: start + 1,
        text,
        shingles: new Set(words.slice(0, -7).map((_, index) => words.slice(index, index + 8).join(" "))),
      });
    buffer = [];
  };
  lines.forEach((line, index) => {
    if (!line.trim() || /^\s*(?:\||#|---)/.test(line)) {
      flush();
      return;
    }
    if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) flush();
    if (!buffer.length) start = index;
    buffer.push(line.trim());
  });
  flush();
  return out;
}

export function lintInstructions(repo: RepositoryText): InstructionFinding[] {
  const findings = new Map<string, InstructionFinding>();
  const add = (
    file: string,
    line: number,
    code: string,
    message: string,
    anchor: string,
    severity: "block" | "warn" = "block",
  ) => {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([file, code, anchor]))
      .digest("hex");
    findings.set(fingerprint, { fingerprint, severity, code, file, line, message });
  };
  const scripts = (JSON.parse(repo.read("package.json") ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {};
  const thirdPartySkills = new Set(
    [...(repo.read(".agents/skills/THIRD_PARTY.md") ?? "").matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]!),
  );
  const skills = new Set(repo.files.filter(isSkill).map((file) => file.split("/")[2]!));
  const agents = new Set(repo.files.filter(isAgent).map((file) => path.basename(file, ".md")));
  const filesByBasename = new Map<string, string[]>();
  for (const file of repo.files) {
    const basename = path.posix.basename(file);
    const matches = filesByBasename.get(basename) ?? [];
    matches.push(file);
    filesByBasename.set(basename, matches);
  }
  const allParagraphs: Paragraph[] = [];
  for (const file of repo.files.filter(isInstruction)) {
    const text = repo.read(file);
    if (text === undefined) continue;
    const description = descriptionOf(text);
    if (
      (isAgent(file) || (isSkill(file) && !thirdPartySkills.has(file.split("/")[2]!))) &&
      Buffer.byteLength(description) > 600
    )
      add(
        file,
        3,
        "description-cap",
        `Description is ${Buffer.byteLength(description)} bytes; cap is 600.`,
        description,
      );
    const lines = withoutFences(text);
    allParagraphs.push(...paragraphs(file, lines));
    text.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/\bpnpm\s+(?:run\s+|--\s+)?([a-z][\w:-]*)/g)) {
        const name = match[1]!;
        if (!(name in scripts) && !BUILT_INS.has(name))
          add(file, index + 1, "dead-command", `Unknown pnpm command: ${name}.`, name);
      }
      const checkPath = (raw: string, link: boolean) => {
        if (/^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(raw) || /[{}<>*|$]/.test(raw)) return;
        let target: string;
        try {
          target = decodeURIComponent(raw.split("#")[0]!.split("?")[0]!);
        } catch {
          target = raw;
        }
        if (!target || target.startsWith("/")) return;
        target = target.replace(/:\d+(?::\d+)?$/, "").replace(/\/$/, "");
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
        const exists = (file: string) => repo.exists(file) || repo.ignored?.(file) === true;
        const bareFilenameExists = () => {
          if (link || target.includes("/")) return false;
          const matches = (filesByBasename.get(target) ?? []).filter((name) => repo.exists(name));
          const directory = path.posix.dirname(file);
          if (matches.some((name) => directory === "." || name.startsWith(`${directory}/`))) return true;
          if (!/^\s*\|/.test(line)) return false;
          const directories = [
            ...[...line.matchAll(/`([^`\s]+)`/g)].flatMap((match) => [
              match[1]!,
              path.posix.join(directory, match[1]!),
            ]),
            ...[...line.matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?\)/g)].map((match) =>
              path.posix.join(directory, match[1]!),
            ),
          ].map((name) => path.posix.normalize(name).replace(/\/$/, ""));
          return matches.some((name) => directories.some((dir) => name.startsWith(`${dir}/`)));
        };
        if (!(link ? exists(relative) : exists(target) || exists(relative) || bareFilenameExists()))
          add(file, index + 1, "dead-path", `Missing repository path: ${raw}.`, `${link ? "link" : "code"}:${raw}`);
      };
      for (const match of line.matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) checkPath(match[1]!, true);
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const target = match[1]!;
        if (
          !/\s/.test(target) &&
          /^(?:\.?\.?\/|(?:src|scripts|docs|tests|playbooks|contrib|\.agents)\/)|^[\w.-]+\.(?:md|json|ts|tsx)$/.test(
            target,
          )
        )
          checkPath(target, false);
      }
      for (const kind of ["skill", "agent"] as const) {
        const names = kind === "skill" ? skills : agents;
        const expression = new RegExp(
          "`([a-z][a-z0-9-]+)`\\s+" +
            kind +
            "\\b|\\b" +
            kind +
            "\\s+`([a-z][a-z0-9-]+)`|\\b([a-z][a-z0-9]*-[a-z0-9-]+)\\s+" +
            kind +
            "\\b",
          "g",
        );
        for (const match of line.matchAll(expression)) {
          const name = (match[1] ?? match[2] ?? match[3])!;
          if (!names.has(name)) add(file, index + 1, `dead-${kind}`, `Unknown ${kind}: ${name}.`, name);
        }
      }
    });
    if (file === "AGENTS.md")
      for (const paragraph of paragraphs(file, lines)) {
        const paths = [
          ...paragraph.text.matchAll(/(?:src\/([\w-]+)|((?:scripts|docs|tests|playbooks|contrib)))(?:\/[\w./-]*)/g),
        ].map((match) => (match[1] ? `src/${match[1]}` : match[2]!));
        if (paths.length && new Set(paths).size === 1)
          add(
            file,
            paragraph.line,
            "root-level",
            `Paragraph names only ${paths[0]}; consider the area's guide.`,
            normaliseWords(paragraph.text).join(" "),
            "warn",
          );
      }
  }
  const index = new Map<string, number[]>();
  allParagraphs.forEach((paragraph, number) => {
    const candidates = new Set<number>();
    for (const shingle of paragraph.shingles) for (const previous of index.get(shingle) ?? []) candidates.add(previous);
    for (const previous of candidates) {
      const other = allParagraphs[previous]!;
      let intersection = 0;
      for (const shingle of paragraph.shingles) if (other.shingles.has(shingle)) intersection++;
      const similarity = intersection / (paragraph.shingles.size + other.shingles.size - intersection);
      if (similarity >= 0.6) {
        const anchors = [other, paragraph].map((item) => `${item.file}:${normaliseWords(item.text).join(" ")}`).sort();
        add(
          paragraph.file,
          paragraph.line,
          "duplicate",
          `Paragraph repeats ${other.file}:${other.line} (Jaccard ${similarity.toFixed(2)}).`,
          anchors.join("\n"),
        );
      }
    }
    for (const shingle of paragraph.shingles) {
      const matches = index.get(shingle) ?? [];
      matches.push(number);
      index.set(shingle, matches);
    }
  });
  return [...findings.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code),
  );
}

export function instructionBaseline(findings: InstructionFinding[]): InstructionBaseline {
  return { version: 1, fingerprints: [...new Set(findings.map((finding) => finding.fingerprint))].sort() };
}

export function newInstructionFindings(
  findings: InstructionFinding[],
  baseline: InstructionBaseline,
): InstructionFinding[] {
  const known = new Set(baseline.fingerprints);
  return findings.filter((finding) => !known.has(finding.fingerprint));
}
