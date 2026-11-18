import { COMMAND_REGISTRY } from "../cli/commands";
import { commitOf, gitText, isInstruction, repositoryText, type RepositoryText } from "./repository";

export type AddedLine = { file: string; line: number; text: string };
export type SecurityFinding = AddedLine & { pattern: string; severity: "block" };
export const protectedText = (file: string): boolean =>
  isInstruction(file) ||
  /(^|\/)CLAUDE(?:\.local)?\.md$/.test(file) ||
  /^(?:\.agents\/(?:skills|agents)\/|\.claude\/|\.github\/workflows\/|\.githooks\/|\.husky\/|hooks\/|scripts\/|src\/lib\/(?:providers|budget|jobs)\/)/.test(
    file,
  ) ||
  file === ".mcp.json" ||
  file === "package.json";

/** Parses zero-context unified diffs, retaining added lines' new-file locations. */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = "";
  let line = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      file = "";
    } else if (!inHunk && raw.startsWith("+++ ")) {
      const name = raw.slice(4);
      file = name.startsWith('"') ? (JSON.parse(name) as string).replace(/^b\//, "") : name.replace(/^b\//, "");
    } else if (raw.startsWith("@@")) {
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
      inHunk = true;
    } else if (raw.startsWith("+")) {
      if (file !== "/dev/null" && protectedText(file)) out.push({ file, line, text: raw.slice(1) });
      line++;
    } else if (raw.startsWith(" ")) line++;
  }
  return out;
}

export function repositoryAddedLines(root: string, base: string, head?: string): AddedLine[] {
  const before = commitOf(root, base);
  const after = head === undefined ? [] : [commitOf(root, head)];
  const lines = addedLines(
    gitText(root, [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--unified=0",
      before,
      ...after,
      "--",
    ]),
  );
  if (!lines.some((item) => item.file === "package.json")) return lines;
  const text =
    head === undefined
      ? (repositoryText(root).read("package.json") ?? "")
      : gitText(root, ["show", `${after[0]}:package.json`]);
  const start = /"scripts"\s*:\s*\{/.exec(text);
  if (!start) return lines.filter((item) => item.file !== "package.json");
  const offset = start.index + start[0].length;
  let depth = 1;
  let quoted = false;
  let escaped = false;
  let end = offset;
  for (; end < text.length && depth; end++) {
    const char = text[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  const first = text.slice(0, start.index).split("\n").length;
  const last = text.slice(0, end).split("\n").length;
  return lines.filter((item) => item.file !== "package.json" || (item.line >= first && item.line <= last));
}

export function urlDomains(text: string): string[] {
  const domains = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/gi)) {
    try {
      domains.add(new URL(match[0]).hostname.toLowerCase());
    } catch {
      /* Malformed URLs are reported by the scanner. */
    }
  }
  return [...domains].sort();
}

export function seedUrlAllowlist(repo: RepositoryText): { version: 1; domains: string[]; npxPackages: string[] } {
  return {
    version: 1,
    domains: [...new Set(repo.files.filter(isInstruction).flatMap((file) => urlDomains(repo.read(file) ?? "")))].sort(),
    npxPackages: [],
  };
}

export function scanInstructionSecurity(
  lines: AddedLine[],
  allowlist: { domains: string[]; npxPackages?: string[] },
  paidCommands = COMMAND_REGISTRY.filter((entry) => entry.paid !== "none").flatMap((entry) =>
    entry.alias ? [entry.alias] : [],
  ),
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const domains = new Set(allowlist.domains.map((domain) => domain.toLowerCase()));
  const packages = new Set(allowlist.npxPackages ?? []);
  const checks: [string, RegExp][] = [
    ["network-fetch", /\b(?:curl|wget)\b/i],
    ["shell-pipe", /\|\s*(?:sh|bash|zsh|iex|invoke-expression)\b|\b(?:iex|invoke-expression)\b/i],
    [
      "private-read",
      /(?:^|[^\w])\.env(?:[.\w-]*)?\b|~\/|\$\{?HOME\}?\b|\/(?:Users|home)\/[^\s/]+|\b(?:id_rsa|id_ed25519|credentials\.json|[\w-]+\.(?:pem|key))\b|\b(?:read|cat|open|load|copy|export|print)\b[^\n]{0,40}\b(?:api[_ -]?keys?|private[_ -]?keys?|credentials|secrets)\b/i,
    ],
    [
      "authority-override",
      /\b(?:ignore\s+(?:(?:all|any)\s+)?(?:previous|prior)|do\s+not\s+tell\s+(?:the\s+)?user|without\s+asking\s+(?:the\s+)?user|disable\s+the\s+sandbox|bypass\s+(?:the\s+)?(?:approval|sandbox|security)|disregard\s+(?:all\s+)?(?:instructions|rules)|ignore\s+the\s+rubric)\b/i,
    ],
  ];
  for (const item of lines) {
    const patterns = new Set<string>();
    for (const [name, expression] of checks) if (expression.test(item.text)) patterns.add(name);
    const invocations = [...item.text.matchAll(/\bnpx\s+([^\n;`]+)/g)];
    for (const invocation of invocations) {
      const name = /^(?:(?:--yes|-y|--no-install)\s+)*((?:@[\w.-]+\/)?[\w.-]+)(?:@[^\s]+)?(?:\s|$)/.exec(
        invocation[1]!,
      )?.[1];
      if (!name || !packages.has(name)) patterns.add("unknown-npx-package");
    }
    for (const match of item.text.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/gi)) {
      try {
        if (!domains.has(new URL(match[0]).hostname.toLowerCase())) patterns.add("unapproved-url");
      } catch {
        patterns.add("unapproved-url");
      }
    }
    for (const command of paidCommands)
      if (new RegExp(`(?<![\\w:-])${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:-])`).test(item.text))
        patterns.add("paid-command");
    for (const pattern of patterns) findings.push({ ...item, pattern, severity: "block" });
  }
  return findings;
}
