/**
 * The coding-agent harnesses this checkout wires itself into (`pnpm harness:setup`).
 * Canonical sources: AGENTS.md, `.agents/skills`, `.agents/agents`, the `agentbros` MCP server.
 * A harness gets a link only where it reads neither `.agents/` nor `.claude/`, generated agent files only where
 * its agent format differs, and an MCP entry in the file it reads. Formats were checked against each harness's
 * documentation on `checked`; when one changes, update the entry and tests/harness-setup.test.ts.
 */

export const MCP_SERVER_NAME = "agentbros";

export interface McpTarget {
  /** Where the harness reads servers: inside this checkout, or the user's home. */
  scope: "project" | "user";
  /** Repository-relative (project) or home-relative (user) path. */
  file: string;
  format: "mcpServers" | "vscode" | "opencode" | "kilo" | "amp" | "codex-toml";
  /** `core` where the harness caps or front-loads tool schemas; `all` where tools load on demand. */
  toolsets: "core" | "all";
  /** A tracked file with a portable relative launch; setup only checks it. */
  committed?: true;
  /** Extra settings merged into the same file (dotted key → value). */
  settings?: Record<string, unknown>;
}

/** Agent definitions converted from `.agents/agents/*.md` for a harness that reads another format. */
export interface AgentTarget {
  dir: string;
  format: "codex-toml" | "copilot" | "opencode";
}

export interface HarnessSpec {
  id: string;
  name: string;
  detect: { bins: string[]; homeDirs: string[]; apps?: string[] };
  /** How the harness finds AGENTS.md. */
  instructions: string;
  /** How it finds the skills and the leaf agents. */
  skills: string;
  /** Directory links to the canonical folders (path → target, repository-relative). */
  links: { path: string; target: string }[];
  agents?: AgentTarget;
  mcp: McpTarget[];
  /** Steps only the person can take (approval prompts, an app's own settings UI). */
  manual?: { where: string; detail: string }[];
  docs: string[];
  checked: string;
}

const CHECKED = "2026-11-17";

export const HARNESSES: readonly HarnessSpec[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    detect: { bins: ["claude"], homeDirs: [".claude"] },
    instructions: "CLAUDE.md, a one-line import of AGENTS.md",
    skills: ".claude/skills and .claude/agents link to .agents/",
    links: [
      { path: ".claude/skills", target: ".agents/skills" },
      { path: ".claude/agents", target: ".agents/agents" },
    ],
    mcp: [{ scope: "project", file: ".mcp.json", format: "mcpServers", toolsets: "all", committed: true }],
    manual: [{ where: "claude", detail: "approve the project server agentbros when Claude Code asks (or /mcp)" }],
    docs: ["https://code.claude.com/docs/en/mcp", "https://code.claude.com/docs/en/skills"],
    checked: CHECKED,
  },
  {
    id: "codex",
    name: "OpenAI Codex (CLI, IDE, app)",
    detect: { bins: ["codex"], homeDirs: [".codex"] },
    instructions: "AGENTS.md natively (32 KiB project_doc_max_bytes)",
    skills: ".agents/skills natively; agents generated as .codex/agents/*.toml",
    links: [],
    agents: { dir: ".codex/agents", format: "codex-toml" },
    mcp: [{ scope: "project", file: ".codex/config.toml", format: "codex-toml", toolsets: "core" }],
    manual: [
      {
        where: "codex",
        detail: "trust this project when Codex asks: project .codex/ config loads only in trusted projects",
      },
    ],
    docs: [
      "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
      "https://learn.chatgpt.com/docs/build-skills",
      "https://learn.chatgpt.com/docs/agent-configuration/subagents",
    ],
    checked: CHECKED,
  },
  {
    id: "cursor",
    name: "Cursor",
    detect: { bins: ["cursor", "cursor-agent"], homeDirs: [".cursor"], apps: ["/Applications/Cursor.app"] },
    instructions: "AGENTS.md natively",
    skills: ".agents/skills natively; agents from .claude/agents",
    links: [],
    mcp: [{ scope: "project", file: ".cursor/mcp.json", format: "mcpServers", toolsets: "core" }],
    docs: [
      "https://cursor.com/docs/context/mcp",
      "https://cursor.com/docs/context/skills",
      "https://cursor.com/docs/context/subagents",
    ],
    checked: CHECKED,
  },
  {
    id: "copilot",
    name: "GitHub Copilot (VS Code and Copilot CLI)",
    detect: {
      bins: ["copilot", "code"],
      homeDirs: [".copilot"],
      apps: ["/Applications/Visual Studio Code.app"],
    },
    instructions: "AGENTS.md natively",
    skills:
      "CLI: .agents/skills; VS Code: .github/skills links to .agents/skills; agents generated as .github/agents/*.agent.md",
    links: [{ path: ".github/skills", target: ".agents/skills" }],
    agents: { dir: ".github/agents", format: "copilot" },
    // The CLI reads the tracked .mcp.json; VS Code reads .vscode/mcp.json.
    mcp: [{ scope: "project", file: ".vscode/mcp.json", format: "vscode", toolsets: "core" }],
    manual: [
      {
        where: "copilot",
        detail: "trust this folder when the Copilot CLI asks: untrusted folders skip project servers",
      },
    ],
    docs: [
      "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills",
    ],
    checked: CHECKED,
  },
  {
    id: "antigravity",
    name: "Google Antigravity CLI",
    detect: {
      bins: ["antigravity", "agy"],
      homeDirs: [".gemini/antigravity"],
      apps: ["/Applications/Antigravity.app"],
    },
    instructions: "AGENTS.md natively",
    skills: ".agents/skills and .agents/agents natively",
    links: [],
    mcp: [{ scope: "project", file: ".agents/mcp_config.json", format: "mcpServers", toolsets: "core" }],
    docs: ["https://antigravity.google/docs/customization-discovery/"],
    checked: CHECKED,
  },
  {
    id: "gemini",
    name: "Gemini CLI (retired 2026-06-18; for existing installs)",
    detect: { bins: ["gemini"], homeDirs: [] },
    instructions: ".gemini/settings.json context.fileName = AGENTS.md",
    skills: ".agents/skills natively; Claude-format agents are not read",
    links: [],
    mcp: [
      {
        scope: "project",
        file: ".gemini/settings.json",
        format: "mcpServers",
        toolsets: "core",
        settings: { "context.fileName": ["AGENTS.md"] },
      },
    ],
    docs: ["https://geminicli.com/docs/reference/configuration/", "https://geminicli.com/docs/cli/skills/"],
    checked: CHECKED,
  },
  {
    id: "opencode",
    name: "OpenCode",
    detect: { bins: ["opencode"], homeDirs: [".config/opencode"] },
    instructions: "AGENTS.md natively",
    skills: ".agents/skills natively; agents generated as .opencode/agents/*.md",
    links: [],
    agents: { dir: ".opencode/agents", format: "opencode" },
    mcp: [{ scope: "project", file: ".opencode/opencode.json", format: "opencode", toolsets: "core" }],
    docs: [
      "https://opencode.ai/docs/mcp-servers/",
      "https://opencode.ai/docs/skills/",
      "https://opencode.ai/docs/agents/",
    ],
    checked: CHECKED,
  },
  {
    id: "devin",
    name: "Devin Desktop (formerly Windsurf) and Devin CLI",
    detect: {
      bins: ["devin", "windsurf"],
      homeDirs: [".config/devin", ".codeium/windsurf"],
      apps: ["/Applications/Windsurf.app", "/Applications/Devin.app"],
    },
    instructions: "AGENTS.md natively",
    skills: ".agents/skills and .agents/agents natively",
    links: [],
    mcp: [{ scope: "project", file: ".devin/mcp_config.json", format: "mcpServers", toolsets: "core" }],
    docs: [
      "https://docs.devin.ai/desktop/cascade/mcp",
      "https://docs.devin.ai/cli/subagents",
      "https://docs.devin.ai/desktop/cascade/skills",
    ],
    checked: CHECKED,
  },
  {
    id: "cline",
    name: "Cline",
    detect: { bins: ["cline"], homeDirs: [".cline"] },
    instructions: "AGENTS.md natively",
    skills: ".claude/skills (a link to .agents/skills); no file-based agents",
    links: [],
    mcp: [
      { scope: "user", file: ".cline/data/settings/cline_mcp_settings.json", format: "mcpServers", toolsets: "core" },
    ],
    manual: [
      {
        where: "Cline (VS Code/JetBrains)",
        detail:
          "the IDE extension keeps servers in its own settings: MCP Servers → Configure, paste `pnpm harness:setup --snippet cline`",
      },
    ],
    docs: ["https://docs.cline.bot/mcp/configuring-mcp-servers", "https://docs.cline.bot/customization/skills"],
    checked: CHECKED,
  },
  {
    id: "amp",
    name: "Amp",
    detect: { bins: ["amp"], homeDirs: [".config/amp"] },
    instructions: "AGENTS.md natively",
    skills: ".agents/skills natively; no file-based agents",
    links: [],
    mcp: [{ scope: "project", file: ".amp/settings.json", format: "amp", toolsets: "core" }],
    manual: [{ where: "amp", detail: "approve the workspace server once: amp mcp approve agentbros" }],
    docs: ["https://ampcode.com/docs/customize/mcp", "https://ampcode.com/docs/customize/skills"],
    checked: CHECKED,
  },
  {
    id: "kilo",
    name: "Kilo Code",
    detect: { bins: ["kilo", "kilocode"], homeDirs: [".config/kilo", ".kilocode"] },
    instructions: "AGENTS.md natively",
    skills: ".agents/skills (OpenCode-compatible discovery)",
    links: [],
    mcp: [{ scope: "project", file: ".kilo/kilo.jsonc", format: "kilo", toolsets: "core" }],
    docs: ["https://kilo.ai/docs/automate/mcp/using-in-kilo-code"],
    checked: CHECKED,
  },
  {
    id: "goose",
    name: "Goose",
    detect: { bins: ["goose"], homeDirs: [".config/goose"] },
    instructions: "AGENTS.md natively",
    skills: ".agents/skills natively",
    links: [],
    mcp: [],
    manual: [
      {
        where: "goose configure",
        detail:
          "Add Extension → Command-line Extension named agentbros, command from `pnpm harness:setup --snippet cursor` (command and args joined)",
      },
    ],
    docs: ["https://goose-docs.ai/docs/guides/context-engineering/using-skills"],
    checked: CHECKED,
  },
];

export const harnessById = (id: string) => HARNESSES.find((spec) => spec.id === id);
