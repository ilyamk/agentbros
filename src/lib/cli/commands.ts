/**
 * The command registry: every package.json alias and every script in scripts/, once.
 * `pnpm commands` reads it, the docs/commands.md catalogue is generated from it, and
 * src/mcp/catalog.ts takes each tool's script from the entry that names the tool.
 */
import { CliErrorObject } from "./index";

export const SECTIONS = {
  project: "Project and workspace",
  film: "Film chain (bespoke)",
  footage: "Footage editing (the user's own recording)",
  reference: "References",
  audio: "Music, sound and sync",
  library: "Motion library",
  render: "Render, timeline and finishing backends",
  qa: "Vision, QA and delivery",
  template: "Recipes, workflows, campaigns and the pipeline findings check",
  assets: "Assets, resources and rights",
  generation: "Generation and budget (paid)",
  dev: "Development and repository",
  legacy: "Legacy",
} as const;
export type CommandSection = keyof typeof SECTIONS;

/** none: no provider spend; may-spend: can dispatch paid work; paid: its job is a paid provider call (planning modes aside). */
export type CommandSpend = "none" | "may-spend" | "paid";

export interface CommandEntry {
  /** package.json alias, or null for a script without one. */
  alias: string | null;
  /** Repository-relative script, or null for an alias that runs a tool directly (remotion, tsc, test runners). */
  script: string | null;
  section: CommandSection;
  paid: CommandSpend;
  /** MCP tool name (served as avc_<name>), or why the command is not a tool. */
  mcp: string | { excluded: string };
  purpose: string;
  /** Why a script has no alias. */
  unaliased?: "internal" | "legacy" | "project-specific";
  /** Repository-relative guide for the command. */
  guide?: string;
  /** Words a user might search with that the purpose does not contain; searched by --query, ranked first, never printed in the catalogue. */
  keywords?: readonly string[];
  /** Spend-free commands of one family share a single catalogue line (purposes stay searchable with --query). */
  family?: keyof typeof FAMILIES;
}

/** Catalogue lines for command families: label and guide. */
export const FAMILIES = {
  campaign: { label: "Campaigns", guide: "docs/campaign-production.md" },
  vork: { label: "Vork local 3D and VFX", guide: "docs/vork.md" },
  models: { label: "Cross-provider model tools", guide: "docs/higgsfield.md" },
  higgsfield: { label: "Higgsfield tools", guide: "docs/higgsfield.md" },
  "fal-catalogue": { label: "fal catalogue tools", guide: "docs/fal-catalogue.md" },
  icons: { label: "Icon and logo resources", guide: "docs/icon-resources.md" },
  slots: { label: "Task-slot model selection and outcomes", guide: "docs/model-slots-guide.md" },
} as const;

const APPROVAL = { excluded: "approval is the user's, CLI only" };
const DESTRUCTIVE = { excluded: "deletes files; the user confirms --yes on the CLI" };
const SERVER = { excluded: "interactive or long-running server" };
const DEV = { excluded: "development tool" };
const TRUSTED_CODE = { excluded: "runs trusted arbitrary code; trusted CLI only" };
const LOCAL_ENGINE = {
  excluded: "installs or runs local engines and weights outside the repository; trusted CLI only",
};
const REPO_CWD = {
  excluded: "reads or writes repository files relative to the working directory, which is the MCP workspace root",
};
const SUPERSEDED = { excluded: "legacy fetcher; use avc_resources" };
const LEGACY = { excluded: "legacy; not for new work" };
const NOT_YET = { excluded: "not yet exposed" };
const COLOUR_CLI = {
  excluded: "reads and writes media at local paths through the colour worker; trusted CLI, MCP exposure is a follow-up",
};
const COLOUR_KEYWORDS = [
  "colour",
  "color",
  "grading",
  "colourist",
  "цвет",
  "цветокоррекция",
  "грейдинг",
  "колорист",
] as const;

const c = (
  alias: string | null,
  script: string | null,
  section: CommandSection,
  paid: CommandSpend,
  mcp: CommandEntry["mcp"],
  purpose: string,
  unaliased?: CommandEntry["unaliased"],
): CommandEntry => ({
  alias,
  script: script && (script.includes("/") ? script : `scripts/${script}`),
  section,
  paid,
  mcp,
  purpose,
  ...(unaliased ? { unaliased } : {}),
});

const g = (guide: string, entry: CommandEntry): CommandEntry => ({ ...entry, guide });

const k = (keywords: readonly string[], entry: CommandEntry): CommandEntry => ({ ...entry, keywords });

const f = (family: keyof typeof FAMILIES, entry: CommandEntry): CommandEntry => ({ ...entry, family });

export const COMMAND_REGISTRY: readonly CommandEntry[] = [
  f(
    "campaign",
    g(
      "docs/campaign-production.md",
      c(
        "campaign:production",
        "campaign-production.ts",
        "project",
        "none",
        "campaign_production",
        "Plan and run campaigns; bind variants, checks, repairs, decisions and reviews",
      ),
    ),
  ),
  f(
    "campaign",
    g(
      "docs/campaign-production.md",
      c(
        "campaign:next",
        "campaign-next.ts",
        "project",
        "none",
        "campaign_next",
        "Resolve the next campaign action and bounded agent handoff",
      ),
    ),
  ),
  f(
    "campaign",
    g(
      "docs/campaign-production.md",
      c(
        "campaign:brief",
        "campaign-brief.ts",
        "project",
        "none",
        "campaign_brief",
        "Build an input-bound specialist brief for one campaign task",
      ),
    ),
  ),
  f(
    "campaign",
    g(
      "docs/campaign-production.md",
      c(
        "campaign:approve",
        "campaign-approve.ts",
        "project",
        "none",
        APPROVAL,
        "Record the user’s approval of an exact campaign package and its child gates",
      ),
    ),
  ),
  g(
    "docs/campaign-production.md",
    c(
      "campaign:execute",
      "campaign-execute.ts",
      "generation",
      "may-spend",
      { excluded: "campaign-wide paid execution requires explicit CLI authority and existing budget admission" },
      "Run authorised campaign jobs",
    ),
  ),
  k(
    ["e2e", "orchestrator", "subagent", "handoff", "сквозные"],
    g(
      "docs/agent-workflow-e2e.md",
      c(
        "bench:workflow",
        "bench-workflow.ts",
        "dev",
        "may-spend",
        { excluded: "bounded local evaluation; real harness mode requires explicit authority" },
        "Evaluate observable agent workflow outcomes, handoffs and installed local tools",
      ),
    ),
  ),
  c(
    "test:agent-workflow",
    null,
    "dev",
    "none",
    { excluded: "local test runner" },
    "Run deterministic workflow observer and producer-consumer contract tests",
  ),
  g(
    "docs/colour-grading.md",
    k(
      [...COLOUR_KEYWORDS, "waveform", "vectorscope", "parade", "histogram", "false colour", "скопы"],
      c(
        "colour:scopes",
        "colour-scopes.ts",
        "render",
        "none",
        COLOUR_CLI,
        "Scopes of a video or still: waveform, RGB parade, vectorscope, histogram, CIE xy, false colour, a contact sheet and exposure, cast, saturation and skin numbers",
      ),
    ),
  ),
  g(
    "docs/colour-grading.md",
    k(
      [...COLOUR_KEYWORDS, "delta e", "deltae", "ciede2000", "match check", "сравнить цвет"],
      c(
        "colour:compare",
        "colour-compare.ts",
        "render",
        "none",
        COLOUR_CLI,
        "Compare a clip with a reference: side-by-side scopes, zone and paired CIEDE2000, and a diagnosis such as shadows cooler, saturation +12%",
      ),
    ),
  ),
  g(
    "docs/colour-grading.md",
    k(
      [...COLOUR_KEYWORDS, "reference match", "shot match", "look match", "подогнать цвет"],
      c(
        "colour:match",
        "colour-match.ts",
        "render",
        "none",
        COLOUR_CLI,
        "Solve an editable grade.json (lift, gamma, gain, saturation, curve) that matches a clip to a reference, with before/after evidence",
      ),
    ),
  ),
  g(
    "docs/colour-grading.md",
    k(
      [...COLOUR_KEYWORDS, "lut", "cube", "lift gamma gain", "white balance", "resolve", "лут"],
      c(
        "colour:grade",
        "colour-grade.ts",
        "render",
        "none",
        COLOUR_CLI,
        "Apply a declarative grade.json or a per-shot timeline to a video or still through a baked 3D LUT, and export the .cube for Resolve",
      ),
    ),
  ),
  g(
    "docs/colour-grading.md",
    k(
      [...COLOUR_KEYWORDS, "validation", "gate", "skin", "кожа", "проверка", "валидация"],
      c(
        "colour:check",
        "colour-check.ts",
        "render",
        "none",
        COLOUR_CLI,
        "Validate a rendered grade against its source (and a reference): skin chroma, hue and yellow drift, clipping, crushed blacks, saturation, legal range",
      ),
    ),
  ),
  g(
    "docs/colour-grading.md",
    k(
      [...COLOUR_KEYWORDS, "look", "preset", "lut", "variants", "пресет", "лук", "варианты"],
      c(
        "colour:looks",
        "colour-looks.ts",
        "render",
        "none",
        COLOUR_CLI,
        "Try genre looks (film, commercial, music video) on a clip with skin held, as a labelled grid with a gate verdict per look and an editable grade each",
      ),
    ),
  ),
  g(
    "docs/colour-grading.md",
    k(
      [...COLOUR_KEYWORDS, "power window", "tracking", "mask", "маска", "трекинг"],
      c(
        "colour:track",
        "colour-track.ts",
        "render",
        "none",
        COLOUR_CLI,
        "Track a power window over a moving subject so a grade's shape window follows it, with a preview of every lost frame",
      ),
    ),
  ),
  g(
    "docs/colour-grading.md",
    k(
      [...COLOUR_KEYWORDS, "continuity", "consistency", "shot matching", "непрерывность"],
      c(
        "colour:shots",
        "colour-shots.ts",
        "render",
        "none",
        COLOUR_CLI,
        "Measure every shot of an edit (or several clips) against a hero shot, flag colour drift and optionally solve per-shot match grades",
      ),
    ),
  ),
  f(
    "vork",
    g(
      "docs/vork.md",
      k(
        ["vork", "vfx", "3d", "геометрия", "эффекты"],
        c(
          "vork:setup",
          "vork-setup.ts",
          "render",
          "none",
          LOCAL_ENGINE,
          "Inspect, install or verify the pinned local Vork runtime",
        ),
      ),
    ),
  ),
  f(
    "vork",
    g(
      "docs/vork.md",
      k(
        ["vork", "vfx", "3d", "геометрия", "эффекты"],
        c(
          "vork:scene",
          "vork-scene.ts",
          "render",
          "none",
          TRUSTED_CODE,
          "Create, brief, check and export authored Vork scenes",
        ),
      ),
    ),
  ),
  f(
    "vork",
    g(
      "docs/vork.md",
      k(
        ["vork", "vfx", "3d", "геометрия", "эффекты"],
        c(
          "vork:render",
          "vork-render.ts",
          "render",
          "none",
          TRUSTED_CODE,
          "Render bounded Vork scenes and import hash-bound outputs",
        ),
      ),
    ),
  ),
  f(
    "vork",
    g(
      "docs/vork.md",
      k(
        ["vork", "vfx", "3d", "геометрия", "эффекты"],
        c(
          "vork:recipe",
          "vork-recipe.ts",
          "render",
          "none",
          TRUSTED_CODE,
          "Discover, build, render and prove procedural Vork recipes",
        ),
      ),
    ),
  ),
  f(
    "vork",
    g(
      "docs/vork.md",
      k(
        ["vork", "vfx", "3d", "геометрия", "эффекты"],
        c(
          "vork:bridge",
          "vork-bridge.ts",
          "render",
          "none",
          TRUSTED_CODE,
          "Exchange supported Blender scenes, geometry and render passes with Vork",
        ),
      ),
    ),
  ),
  f(
    "vork",
    g(
      "docs/vork.md",
      k(
        ["vork", "vfx", "3d", "геометрия", "эффекты"],
        c(
          "vork:vfx",
          "vork-vfx.ts",
          "render",
          "none",
          TRUSTED_CODE,
          "Prepare footage, solve constrained cameras and render explicit Vork or Cycles inserts",
        ),
      ),
    ),
  ),
  f(
    "vork",
    g(
      "docs/vork.md",
      k(
        ["vork", "vfx", "3d", "геометрия", "эффекты"],
        c(
          "vork:eval",
          "vork-eval.ts",
          "render",
          "none",
          TRUSTED_CODE,
          "Prove recipes, qualify complete Vork clips and prepare blind comparison packets",
        ),
      ),
    ),
  ),

  f(
    "slots",
    g(
      "docs/model-slots-guide.md",
      k(
        ["slots", "task slots"],
        c(
          "models:pick",
          "models-pick.ts",
          "generation",
          "none",
          "models_pick",
          "Pick models offline by use case, slot, class, constraints and reference prices; flags candidates needing a quote",
        ),
      ),
    ),
  ),
  f(
    "slots",
    g(
      "docs/model-slots-guide.md",
      k(
        ["slots", "task slots"],
        c(
          "models:slots",
          "models-slots.ts",
          "generation",
          "none",
          "models_slots",
          "List, show or validate task slots; generate or check docs/model-slots.md",
        ),
      ),
    ),
  ),
  f(
    "slots",
    g(
      "docs/model-slots-guide.md",
      k(
        ["slots", "task slots"],
        c(
          "models:slot",
          "models-slot.ts",
          "generation",
          "none",
          { excluded: "owner curation writes repository files; CLI only" },
          "Atomically curate task-slot candidates, reviews and local acceptance evidence",
        ),
      ),
    ),
  ),
  f(
    "slots",
    g(
      "docs/model-slots-guide.md",
      k(
        ["slots", "task slots"],
        c(
          "models:verdict",
          "models-verdict.ts",
          "generation",
          "none",
          { excluded: "records the owner's verdict; CLI only" },
          "Append a project model verdict for an existing operation",
        ),
      ),
    ),
  ),
  f(
    "slots",
    g(
      "docs/model-slots-guide.md",
      k(
        ["slots", "task slots"],
        c(
          "models:stats",
          "models-stats.ts",
          "generation",
          "none",
          { excluded: "cross-project outcome reporting; CLI only" },
          "Model outcomes and proposed first-pass acceptance evidence from local verdicts",
        ),
      ),
    ),
  ),
  g(
    "docs/higgsfield-prompting.md",
    k(
      ["genjutsu", "remix", "character", "reference", "markers"],
      c(
        "model:prepare",
        "model-prepare.ts",
        "generation",
        "none",
        APPROVAL,
        "Prepare immutable Genjutsu inputs, record visual approval, review exact results or write one as a reference pack",
      ),
    ),
  ),
  g(
    "docs/reference-packs.md",
    k(
      ["reference", "derivative", "trim", "crop", "snap", "loudness", "contact sheet", "cutout", "extract frame"],
      c(
        "refs:derive",
        "refs-derive.ts",
        "reference",
        "may-spend",
        "refs_derive",
        "Plan, run and show immutable reference derivatives: ffmpeg steps, Blender passes, paid fal depth/pose/mask/audio-clean jobs (--confirm-spend)",
      ),
    ),
  ),
  g(
    "docs/reference-packs.md",
    k(
      ["reference pack", "markers", "compiled prompt", "board", "approval", "reference images", "result review"],
      c(
        "refs:pack",
        "refs-pack.ts",
        "reference",
        "none",
        "refs_pack",
        "Prepare, check and approve immutable reference packs: measured attachments, compiled prompt and markers, exact request, board and result review",
      ),
    ),
  ),
  g(
    "docs/reference-packs.md",
    k(
      ["reference requirements", "references.json", "shot references", "character views", "chaining", "real faces"],
      c(
        "refs:plan",
        "refs-plan.ts",
        "reference",
        "none",
        "refs_plan",
        "Draft, check and track each generated shot's reference requirements in references.json, with the command that resolves each",
      ),
    ),
  ),
  g(
    "docs/reference-packs.md",
    k(
      ["reference images", "reference slots", "markers", "@image", "elements", "limits", "real faces"],
      c(
        "refs:profiles",
        "refs-profiles.ts",
        "generation",
        "none",
        "refs_profiles",
        "Model reference profiles: slots, limits, marker dialect and policies per family; check them against catalogue, schemas and guards",
      ),
    ),
  ),
  g(
    "docs/higgsfield-prompting.md",
    k(
      ["trending", "viral", "higgsfield", "source", "clips"],
      c(
        "motion:library",
        "motion-library.ts",
        "assets",
        "none",
        NOT_YET,
        "Keep and search dated local motion candidates with original acquisition steps and rights status",
      ),
    ),
  ),
  c("test:viz:blender", null, "dev", "none", DEV, "Verify prepared Blender projections, frames and sequence resume"),
  c("test:viz:render", null, "dev", "none", DEV, "Render all prepared visualisation recipes and formats locally"),
  c("test:viz", null, "dev", "none", DEV, "Run visualisation unit and contract checks"),
  c("viz:list", "viz-list.ts", "render", "none", "viz_list", "Discover visualisation recipes and strict JSON requests"),
  c("viz:prepare", "viz-prepare.ts", "render", "none", "viz_prepare", "Prepare immutable data visualisation revisions"),
  c("viz:inspect", "viz-inspect.ts", "render", "none", "viz_inspect", "Inspect pinned visualisation plans and sources"),
  c("viz:preview", "viz-preview.ts", "render", "none", "viz_preview", "Render prepared visualisation stills"),
  c("viz:render", "viz-render.ts", "render", "none", "viz_render", "Render immutable visualisation video"),
  c(
    "viz:mount",
    "viz-mount.ts",
    "render",
    "none",
    "viz_mount",
    "Place prepared 2D visualisation over a revision-checked timeline",
  ),
  c("viz:check", "viz-check.ts", "qa", "none", "viz_check", "Validate pinned visualisation revision integrity"),
  g(
    "docs/python-runtime.md",
    c(
      "python:check",
      "python-check.ts",
      "dev",
      "none",
      { excluded: "trusted local Python quality and native compatibility checks" },
      "Check Python lint, formatting, types, contracts and dependency profiles",
    ),
  ),
  g(
    "docs/python-runtime.md",
    c(
      "python:audit",
      "python-check.ts",
      "dev",
      "none",
      { excluded: "network dependency security audit" },
      "Audit every locked Python dependency group for published vulnerabilities",
    ),
  ),
  g(
    "docs/node-runtime.md",
    c(
      "runtime:check",
      "runtime-check.ts",
      "dev",
      "none",
      { excluded: "trusted local runtime diagnostics" },
      "Verify the exact Node policy, executable and child-process runtime",
    ),
  ),
  g(
    "docs/local-macos.md",
    c(
      "local:verify",
      "local-verify.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Exercise native tasks and retain expiring smoke or pinned quality evidence",
    ),
  ),
  c("test:apple", null, "footage", "none", DEV, "Gated actual Apple framework verification"),
  g(
    "docs/local-macos.md",
    c(
      "local:capabilities",
      "local-capabilities.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Task-aware local capability diagnostics; --all includes unavailable backends",
    ),
  ),
  g(
    "docs/local-macos.md",
    c(
      "local:policy",
      "local-policy.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Read or set local interaction and model download policy",
    ),
  ),
  g(
    "docs/local-macos.md",
    c(
      "text:analyse",
      "local-task.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Native language, token, sentence, lemma and entity observations",
    ),
  ),
  g(
    "docs/local-macos.md",
    c(
      "text:translate",
      "local-task.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Local scene or caption-cue translation candidates; no invented word timings",
    ),
  ),
  g(
    "docs/local-macos.md",
    c(
      "voiceover:local",
      "local-task.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Apple or portable local voice draft takes with provenance and portable word timing",
    ),
  ),
  g(
    "docs/local-macos.md",
    c(
      "audio:events",
      "local-task.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Native timed sound classification observations",
    ),
  ),
  g(
    "docs/local-macos.md",
    c(
      "media:vision",
      "local-task.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Native face, person, pose, saliency, quality, tracking and optical flow observations",
    ),
  ),
  g(
    "docs/local-macos.md",
    c(
      "text:assist",
      "local-task.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Structured local Foundation Models draft notes with source IDs",
    ),
  ),
  g(
    "docs/local-macos.md",
    c(
      "image:describe",
      "local-task.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Local Foundation Models image descriptions when supported",
    ),
  ),

  f(
    "icons",
    g(
      "docs/icon-resources.md",
      k(
        ["icons", "logos", "svg", "иконки", "логотипы"],
        c(
          "resources:icons",
          "icons.ts",
          "assets",
          "none",
          "icon_resources",
          "Acquire, export and inspect local icons with project provenance",
        ),
      ),
    ),
  ),
  f(
    "icons",
    g(
      "docs/icon-resources.md",
      k(
        ["icons", "logos", "svg", "иконки", "логотипы"],
        c(
          "resources:icons:read",
          "icons.ts",
          "assets",
          "none",
          "icon_resources_read",
          "Search and inspect icons and local resources; read-only",
        ),
      ),
    ),
  ),
  f(
    "icons",
    g(
      "docs/icon-resources.md",
      k(
        ["icons", "logos", "svg", "иконки", "логотипы"],
        c(
          "resources:logos",
          "logos.ts",
          "assets",
          "none",
          "logo_resources",
          "Acquire and export brand logos from Simple Icons and SVGL",
        ),
      ),
    ),
  ),
  f(
    "icons",
    g(
      "docs/icon-resources.md",
      k(
        ["icons", "logos", "svg", "иконки", "логотипы"],
        c(
          "resources:logos:read",
          "logos.ts",
          "assets",
          "none",
          "logo_resources_read",
          "Search and inspect brand logos without writes",
        ),
      ),
    ),
  ),
  f(
    "icons",
    g(
      "docs/icon-resources.md",
      k(
        ["icons", "logos", "svg", "иконки", "логотипы"],
        c(
          "resources:icon-profile",
          "icon-profile.ts",
          "assets",
          "none",
          "icon_profile",
          "Set a project's versioned icon style profile",
        ),
      ),
    ),
  ),
  f(
    "icons",
    g(
      "docs/icon-resources.md",
      k(
        ["icons", "logos", "svg", "иконки", "логотипы"],
        c(
          "resources:icon-profile:read",
          "icon-profile.ts",
          "assets",
          "none",
          "icon_profile_read",
          "Read a project's icon profile and style presets",
        ),
      ),
    ),
  ),
  g(
    "docs/icon-resources.md",
    c(
      "resources:icons:verify",
      "icons-verify.ts",
      "dev",
      "none",
      { excluded: "opt-in live integration verification; trusted CLI only" },
      "Verify installed icon collections and opt-in public Iconify/SVGL services",
    ),
  ),
  g(
    "docs/contributing-gates.md",
    c(
      "deps:check",
      "deps-check.ts",
      "dev",
      "none",
      { excluded: "dependency audit runs in unprivileged CI" },
      "Audit production dependencies, enforce new package licences and list install scripts",
    ),
  ),
  g(
    "docs/dependency-licences.md",
    k(
      ["license", "licensing", "dependencies", "notices", "spdx"],
      c(
        "deps:licences",
        "licences.ts",
        "dev",
        "none",
        { excluded: "local licence inventory and review evidence; never grants approval" },
        "Collect or verify dependency licence texts, locked packages and declared integration evidence",
      ),
    ),
  ),
  g(
    "docs/benchmark.md",
    c(
      "bench:export",
      "bench-export.ts",
      "dev",
      "none",
      { excluded: "publication export uses a submitter SSH signing key; CLI only" },
      "Export a leak-checked public benchmark summary with a new signed manifest",
    ),
  ),
  g(
    "docs/showcases.md",
    c(
      "showcase:fetch-media",
      "showcase-fetch-media.ts",
      "dev",
      "none",
      { excluded: "trusted showcase attachment processing; CLI only" },
      "Download, re-encode and validate bounded showcase media artefacts",
    ),
  ),
  g(
    "docs/benchmark.md",
    c(
      "bench:fetch-bundle",
      "bench-fetch-bundle.ts",
      "dev",
      "none",
      { excluded: "untrusted benchmark attachment intake; CLI only" },
      "Download and safely extract a benchmark issue bundle and signature",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:bench-report",
      "scripts/github/gh-bench-report.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub reporting only" },
      "Prepare or publish schema-validated benchmark verification summaries",
    ),
  ),
  g(
    "docs/showcases.md",
    c(
      "showcase:add",
      "showcase-add.ts",
      "dev",
      "none",
      { excluded: "local publication preparation; trusted CLI only" },
      "Build a leak-scanned showcase entry, local media and a draft PR body",
    ),
  ),
  g(
    "docs/showcases.md",
    c(
      "showcase:media",
      "showcase-media.ts",
      "dev",
      "none",
      { excluded: "local publication preparation; trusted CLI only" },
      "Attach reviewed release-asset URLs to a showcase entry",
    ),
  ),
  g(
    "docs/showcases.md",
    c(
      "showcase:readme",
      "showcase-readme.ts",
      "dev",
      "none",
      { excluded: "local publication preparation; trusted CLI only" },
      "Generate the README Now Showing block from verified showcases",
    ),
  ),
  g(
    "docs/showcases.md",
    c(
      "site:build",
      "site-build.ts",
      "dev",
      "none",
      { excluded: "local publication preparation; trusted CLI only" },
      "Build the static gallery, contributors, metrics, benchmarks, needs and releases site",
    ),
  ),
  g(
    "docs/showcases.md",
    c(
      "field:report",
      "field-report.ts",
      "dev",
      "none",
      { excluded: "local publication preparation; trusted CLI only" },
      "Produce an anonymous local field report as Markdown and JSON; sends nothing",
    ),
  ),

  g(
    "docs/contributing-gates.md",
    c(
      "contrib:scout",
      "contrib-scout.ts",
      "dev",
      "none",
      { excluded: "repository contribution discovery; online mode needs trusted gh authentication" },
      "Rank contribution opportunities offline; optionally check open GitHub issues, claims and PRs",
    ),
  ),
  g(
    "docs/contributing-gates.md",
    c(
      "contrib:check",
      "contrib-check.ts",
      "dev",
      "none",
      { excluded: "executes repository gates and writes local evidence; trusted CLI only" },
      "Run shared contribution gates and write .contrib/evidence.json",
    ),
  ),
  g(
    "docs/contributing-gates.md",
    c(
      "contrib:fails-on-base",
      "contrib-fails-on-base.ts",
      "dev",
      "none",
      { excluded: "executes contribution tests in local Git worktrees; trusted CLI only" },
      "Prove changed regression tests fail on the base revision and pass at head",
    ),
  ),
  g(
    "docs/contributing-gates.md",
    c(
      "contrib:novelty",
      "contrib-novelty.ts",
      "dev",
      "none",
      { excluded: "compares committed repository catalogue and playbook content; CLI only" },
      "Report block and playbook neighbours and require justification for novelty overlaps",
    ),
  ),
  g(
    "docs/contributing-gates.md",
    c(
      "contrib:pr",
      "contrib-pr.ts",
      "dev",
      "none",
      { excluded: "drafts an accountable PR body in the local repository; CLI only" },
      "Draft a PR body from the change entry and local gate evidence; never sends it",
    ),
  ),
  g(
    "docs/contributing-gates.md",
    c(
      "regen",
      "regen.ts",
      "dev",
      "none",
      { excluded: "runs repository generators and rewrites generated documents; trusted CLI only" },
      "Regenerate catalogues and documents in fixed order and report changed files",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:category-gates",
      "scripts/github/gh-category-gates.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub automation only" },
      "Run the shared contribution category gate plan",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:triage-budget",
      "scripts/github/gh-triage-budget.ts",
      "dev",
      "may-spend",
      { excluded: "trusted GitHub automation with environment secrets" },
      "Reserve a durable triage bound before invoking paid judges",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:triage",
      "scripts/github/gh-apply-triage.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub automation only" },
      "Apply validated advisory triage labels without closing or merging",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:facts",
      "scripts/github/gh-pr-facts.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub automation only" },
      "Fetch authoritative GitHub PR facts and bounded triage data",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:intake",
      "scripts/github/gh-apply-intake.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub automation only" },
      "Apply API-verified intake labels and one status comment",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:autoclose",
      "scripts/github/gh-autoclose.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub automation only" },
      "Apply deterministic PR closing rules, reminders and claim expiry",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:commands",
      "scripts/github/gh-commands.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub automation only" },
      "Apply tier-checked GitHub issue comment commands",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:cla",
      "scripts/github/gh-cla.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub automation only" },
      "Verify and append human CLA acceptances on cla-signatures",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:labels",
      "scripts/github/gh-labels.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub automation only" },
      "Synchronise the repository label definitions",
    ),
  ),
  g(
    "docs/github.md",
    c(
      "github:codeowners",
      "scripts/github/codeowners.ts",
      "dev",
      "none",
      { excluded: "trusted GitHub automation only" },
      "Generate or check CODEOWNERS from protected paths",
    ),
  ),

  g(
    "docs/triage.md",
    c(
      "triage:local",
      "triage-local.ts",
      "dev",
      "none",
      { excluded: "runs an external subscription agent and may post advisory results to GitHub" },
      "Review a PR with isolated local subscription judges and optionally post advisory labels",
    ),
  ),
  g(
    "docs/triage.md",
    c(
      "triage:pr",
      "triage-pr.ts",
      "dev",
      "paid",
      { excluded: "privileged advisory pull-request judging with dedicated vendor keys; CLI only" },
      "Judge untrusted PR artefacts with two model families through OpenRouter; output labels and one comment, never close or merge",
    ),
  ),
  g(
    "docs/triage.md",
    c(
      "instructions:audit",
      "instructions-audit.ts",
      "dev",
      "paid",
      { excluded: "paid instruction audit with dedicated vendor keys; reports only, CLI only" },
      "Audit instruction sections against step-context tasks with two model families; ranked JSON and Markdown findings",
    ),
  ),
  g(
    "docs/releases.md",
    c(
      "release:plan",
      "release-plan.ts",
      "dev",
      "none",
      { excluded: "repository release maintenance; CLI only" },
      "Plan the release bump, compatibility declarations and readiness from change entries",
    ),
  ),
  g(
    "docs/releases.md",
    c(
      "release:notes",
      "release-notes.ts",
      "dev",
      "none",
      { excluded: "repository release maintenance; CLI only" },
      "Generate release Markdown with category credits, migrations and snapshot deltas",
    ),
  ),
  g(
    "docs/releases.md",
    c(
      "release:apply",
      "release-apply.ts",
      "dev",
      "none",
      { excluded: "repository release maintenance; CLI only" },
      "Apply a release version and changelog, consume entries and report the tag without git writes",
    ),
  ),
  g(
    "docs/releases.md",
    c(
      "credits:write-doc",
      "credits-write-doc.ts",
      "dev",
      "none",
      { excluded: "repository release maintenance; CLI only" },
      "Regenerate or check CREDITS.md from one JSON file per source",
    ),
  ),
  g(
    "docs/releases.md",
    c(
      "regen:post-merge",
      "regen-post-merge.ts",
      "dev",
      "none",
      { excluded: "repository release maintenance; CLI only" },
      "Regenerate merged catalogues, instruction dates and change entry PR numbers",
    ),
  ),
  g(
    "docs/contributing-gates.md",
    c(
      "change:add",
      "change-add.ts",
      "dev",
      "none",
      { excluded: "writes contribution entries in the local repository; CLI only" },
      "Create a validated contribution change entry without overwriting",
    ),
  ),
  g(
    "docs/contributing-gates.md",
    c(
      "contrib:intake",
      "contrib-intake.ts",
      "dev",
      "none",
      { excluded: "offline contribution intake for a local Git repository; CLI only" },
      "Check contribution accountability and structure against two Git revisions",
    ),
  ),
  g(
    "docs/context-loading.md",
    c(
      "context:probe",
      "context-probe.ts",
      "dev",
      "may-spend",
      { excluded: "starts a local harness using its subscription or API account; maintainer CLI only" },
      "Probe observed harness instruction loading with seeded canaries in a temporary worktree",
    ),
  ),
  g(
    "docs/context-budget.md",
    c(
      "context:budget",
      "context-budget.ts",
      "dev",
      "none",
      DEV,
      "Offline boot, playbook-step, subagent and contributor context sizes, git-ref deltas and --simulate whole-run estimates",
    ),
  ),
  k(
    ["markdown", "cleanup", "legacy", "folders", "документация", "мусор"],
    g(
      "docs/cleanup.md",
      c(
        "docs:audit",
        "docs-audit.ts",
        "dev",
        "none",
        DEV,
        "Audit Markdown contents, folder roles and code/agent references; write JSON and TSV review inventories",
      ),
    ),
  ),
  k(
    ["cleanup", "logs", "paths", "мусор", "пути"],
    g(
      "docs/cleanup.md",
      c(
        "repo:hygiene",
        "repo-hygiene.ts",
        "dev",
        "none",
        { excluded: "repository audit and explicit ignored-QA cleanup; trusted CLI only" },
        "Check source portability and maintenance artefacts; plan or clear ignored QA outputs",
      ),
    ),
  ),
  g(
    "docs/context-budget.md",
    c(
      "instructions:lint",
      "instructions-lint.ts",
      "dev",
      "none",
      DEV,
      "Instruction duplicates, references, descriptions and placement against a fingerprint baseline",
    ),
  ),
  g(
    "docs/context-budget.md",
    c(
      "instructions:security",
      "instructions-security.ts",
      "dev",
      "none",
      DEV,
      "Added-line instruction security findings against a trusted base ref",
    ),
  ),
  g(
    "docs/media-fetch.md",
    c(
      "media:fetch",
      "media-fetch.ts",
      "assets",
      "may-spend",
      "media_fetch",
      "Acquire public video, audio and images: resumable provider routing, bounded batches",
    ),
  ),
  c(
    "preflight",
    "doctor.ts",
    "project",
    "none",
    NOT_YET,
    "Environment check: Node, pnpm, ffmpeg, Chromium, uv, Blender, .env keys. Not `doctor` (pnpm shadows it)",
  ),
  g(
    "SETUP.md",
    c(
      "bootstrap",
      "bootstrap.ts",
      "project",
      "none",
      { excluded: "installs packages, Chromium and Python on the host; first-run CLI only" },
      "First-run setup: plan by scope, --apply repo steps, report for the user with machine limits and keys by goal",
    ),
  ),
  k(
    [
      "claude code",
      "codex",
      "cursor",
      "gemini",
      "copilot",
      "opencode",
      "windsurf",
      "cline",
      "roo",
      "amp",
      "mcp",
      "skills",
    ],
    g(
      "docs/harnesses.md",
      c(
        "harness:setup",
        "harness-setup.ts",
        "project",
        "none",
        { excluded: "writes harness configs and links in the checkout and the user's home; setup CLI only" },
        "Wire this checkout into installed coding-agent harnesses: skill and agent links and the agentbros MCP server config",
      ),
    ),
  ),
  k(
    ["secrets", "api keys", "credentials", "env"],
    g(
      "SETUP.md",
      c(
        "keys",
        "keys.ts",
        "project",
        "none",
        { excluded: "reads the host .env; setup-time CLI only" },
        "Which service keys are set (never values), what each unlocks, free or paid, and which goals they serve",
      ),
    ),
  ),
  c("studio", null, "project", "none", SERVER, "Remotion Studio preview"),
  c("projects", "list-projects.ts", "project", "none", "project_list", "List projects under public/projects/"),
  c(
    "next",
    "next.ts",
    "project",
    "none",
    "next",
    "Any project's next step: detects its route (film, footage, campaign, timeline, playbook); playbook first in read",
  ),
  k(
    [
      "playbook",
      "video type",
      "kind of video",
      "task",
      "route",
      "choose",
      "what to make",
      "which video",
      "start a film",
      "tutorial",
      "promo",
      "explainer",
      "uses",
      "who uses",
      "which playbook",
      "reverse lookup",
      "owner",
      "coverage",
    ],
    g(
      "playbooks/AGENTS.md",
      c(
        "playbook",
        "playbook.ts",
        "project",
        "none",
        "playbook",
        "Choose (--match), show, bind (--use) a task playbook; --uses: which playbooks name a tool",
      ),
    ),
  ),
  k(
    ["remember", "memory", "decisions", "preferences", "lessons", "память", "решения"],
    g(
      "memory/AGENTS.md",
      c(
        "memory",
        "memory.ts",
        "project",
        "none",
        "memory",
        "The user's local memory (decisions, preferences, lessons, observations, episodes, gaps) and proposals",
      ),
    ),
  ),
  g(
    "memory/AGENTS.md",
    c(
      "memory:upstream",
      "memory-upstream.ts",
      "project",
      "none",
      { excluded: "writes local patch files for the user to send; CLI only" },
      "Applied proposal as local patches and PR.md, leak-scanned; never pushes",
    ),
  ),
  c(
    "project:new",
    "create-project.ts",
    "project",
    "none",
    "project_create",
    "Create a project directory and project.json",
  ),
  c(
    "project:remove",
    "project-remove.ts",
    "project",
    "none",
    DESTRUCTIVE,
    "Plan removal of one project's whole footprint; --yes deletes",
  ),
  c(
    "workspace:clean",
    "workspace-clean.ts",
    "project",
    "none",
    DESTRUCTIVE,
    "Plan clearing generated data by scope; --yes deletes",
  ),
  g(
    "docs/assets.md",
    c(
      "assets:sync",
      "assets-sync.ts",
      "project",
      "none",
      NOT_YET,
      "Fetch or rebuild shared media from committed manifests, sha256-verified; --check reports only",
    ),
  ),
  g(
    "docs/local-review-ui.md",
    c(
      "review:ui",
      "review-ui.ts",
      "project",
      "none",
      SERVER,
      "Open a project's review (Timeline page) in the local studio console; starts or reuses it",
    ),
  ),
  k(
    ["dashboard", "ui", "browser", "localhost", "approve", "pause"],
    g(
      "docs/console.md",
      c(
        "console",
        "console.ts",
        "project",
        "none",
        SERVER,
        "Studio console: start or reuse the local server (detached, one for all projects), print its token URL; --stop stops it",
      ),
    ),
  ),
  g(
    "docs/console.md",
    c(
      "console:wait",
      "console-wait.ts",
      "project",
      "none",
      { excluded: "blocks until the user decides in the console; CLI only" },
      "Wait for the user's console decision, control change or card answer, then print it (run in the background at a gate)",
    ),
  ),
  g(
    "docs/console.md",
    c(
      "console:card",
      "console-card.ts",
      "project",
      "none",
      "console_card",
      "Post a typed agent card (compare, grid, rating, choice, question, markdown, media) to the console",
    ),
  ),
  g(
    "docs/console.md",
    c(
      "console:control",
      "console-control.ts",
      "project",
      "none",
      { excluded: "pause, resume and stop are the user's, CLI only" },
      "Pause, resume or stop a project with the user's words; paused or stopped refuses other commands with PAUSED",
    ),
  ),
  g(
    "docs/console.md",
    k(
      ["preview", "live", "remotion", "composition"],
      c(
        "studio:open",
        "studio-open.ts",
        "project",
        "none",
        { excluded: "starts a long-lived local Studio server; the user opens it from the console or the CLI" },
        "Open a project in Remotion Studio in its current state (render props, live updates), bound to 127.0.0.1; --status, --stop",
      ),
    ),
  ),
  g(
    "docs/console.md",
    c(
      "console:snapshot",
      "console-snapshot.ts",
      "project",
      "none",
      { excluded: "writes a shareable page; the user decides when it is made and whether it leaves the machine (D18)" },
      "Write a self-contained, read-only HTML snapshot of a project's console view to out/<id>/console-snapshot.html",
    ),
  ),
  c("narration:check", "narration-check.ts", "film", "none", NOT_YET, "Check a film's narration takes"),

  g(
    "docs/film-types.md",
    c(
      "film:route",
      "film-route.ts",
      "film",
      "none",
      "film_route",
      "A film type's steps, agents, inputs, outputs and tools; --write-doc regenerates its doc",
    ),
  ),
  c(
    "film:init",
    "film-init.ts",
    "film",
    "none",
    "film_init",
    "Create a bespoke project and spine, never overwriting; --playbook binds and defaults --type; own footage: footage:next",
  ),
  c(
    "film:status",
    "film-status.ts",
    "film",
    "none",
    "film_status",
    "Each step's state from validated files and input hashes; what is stale",
  ),
  g(
    "docs/production-chain.md",
    c(
      "film:next",
      "film-next.ts",
      "film",
      "none",
      "film_next",
      "What the orchestrator does now: dispatch, run, ask the user or stop",
    ),
  ),
  c(
    "film:brief",
    "film-brief.ts",
    "film",
    "none",
    "film_brief",
    "Writes a step's deterministic subagent prompt to pipeline/briefs/; returns its path and the one-line dispatch (--print: full text)",
  ),
  c(
    "film:show",
    "film-show.ts",
    "film",
    "none",
    "film_show",
    "Read-only digest of a step's inputs and outputs or one artefact: shape, counts, schema validity, chosen fields",
  ),
  c(
    "film:done",
    "film-done.ts",
    "film",
    "none",
    "film_done",
    "Check a step's done rule and record its inputs; --skip <reason> for a skippable step",
  ),
  c(
    "film:approve",
    "film-approve.ts",
    "film",
    "none",
    APPROVAL,
    "Record the user's own words against an artefact's hash; a --proxy benchmark never counts as the user's",
  ),
  c("film:rights", "film-rights.ts", "film", "none", APPROVAL, "A replica's rights gate from the user's own words"),
  k(
    ["autonomy", "autonomous", "do it yourself", "limits", "guard", "raise limit", "pre-answer", "auto-pass"],
    g(
      "docs/production-chain/autonomy.md",
      c(
        "film:policy",
        "film-policy.ts",
        "film",
        "none",
        { excluded: "grants autonomy, budget and limits on the user's own words; CLI only" },
        "A project's autonomy policy (pipeline/policy.json): grant, revise or show it, raise a guard limit; widening needs --answer",
      ),
    ),
  ),
  g(
    "docs/production-chain/autonomy.md",
    c(
      "film:revert",
      "film-revert.ts",
      "film",
      "none",
      { excluded: "revokes a decision on the user's own words; CLI only" },
      "Revoke a decision taken under the user's policy (pipeline/decisions.jsonl) and reopen its step",
    ),
  ),
  k(
    ["step lease", "step guard", "out of step", "unlock", "escape hatch"],
    g(
      "docs/step-lease.md",
      c(
        "step:unlock",
        "step-unlock.ts",
        "project",
        "none",
        { excluded: "the step lease's escape hatch; recorded and reported, CLI only" },
        "Time-limited, reasoned step-lease unlock (unlocks.jsonl); spend still needs approval",
      ),
    ),
  ),
  k(
    ["step lease", "step guard", "out of step", "violations", "enforce", "clean run"],
    g(
      "docs/step-lease.md",
      c(
        "step:violations",
        "step-violations.ts",
        "project",
        "none",
        "step_violations",
        "Step-lease violations by step and command; clean or not",
      ),
    ),
  ),
  k(
    ["rejection", "revise", "change request", "what should change", "notes"],
    g(
      "docs/production-chain/feedback.md",
      c(
        "feedback",
        "feedback.ts",
        "film",
        "none",
        { excluded: "carries the user's own words and reopens steps; CLI only" },
        "The user's feedback on a film, recording edit or campaign variant: routes each quote to its step and reopens it; preview until --confirm",
      ),
    ),
  ),
  c(
    "creative:stimuli",
    "creative-stimuli.ts",
    "film",
    "none",
    "creative_stimuli",
    "Seeded creativity stimuli for a method (zwicky, scamper, triz, synectics, random-entry, kill-first-10)",
  ),
  c(
    "creative:pool",
    "creative-pool.ts",
    "film",
    "none",
    "creative_pool",
    "Pool concept ideas or script variants blind, shuffled with a seed; seals the review step",
  ),
  c(
    "creative:rank",
    "creative-rank.ts",
    "film",
    "none",
    "creative_rank",
    "Rank the creative director's review on the frozen rubric and compute the verdict",
  ),
  c(
    "creative:pick",
    "creative-pick.ts",
    "film",
    "none",
    "creative_pick",
    "Write concept.json or script.json from the ranked review",
  ),
  g(
    "docs/creative-benchmark.md",
    c(
      "creative:bench",
      "creative-bench.ts",
      "film",
      "none",
      "creative_bench",
      "Benchmark two runs outside the chain: blind merged pools, judges' briefs, analysis",
    ),
  ),
  c(
    "concept:boards",
    "concept-boards.ts",
    "film",
    "none",
    "concept_boards",
    "Hook, turn and last frames of each idea from library blocks, plus a contact sheet",
  ),
  c(
    "film:targets",
    "film-targets.ts",
    "film",
    "none",
    "film_targets",
    "Pace, stillness, loudness and sync targets from a reference or video (--manual on the CLI)",
  ),
  c(
    "plan:check",
    "plan-check.ts",
    "film",
    "none",
    "plan_check",
    "Block a slideshow plan before building: pace, carry, entrances, layers, holds, reading time",
  ),
  c(
    "film:stills",
    "film-stills.ts",
    "film",
    "none",
    "film_stills",
    "Stills and a contact sheet at every cue, before rendering",
  ),
  k(
    ["export", "mp4", "output"],
    c(
      "film:render",
      "film-render.ts",
      "film",
      "none",
      "film_render",
      "Render a bespoke film, mux, measure, write its and delivery's receipts; refuses silence unless decided",
    ),
  ),
  k(
    ["prune", "cleanup", "disk", "old renders"],
    c("film:versions", "film-versions.ts", "film", "none", DESTRUCTIVE, "List or prune a film's kept renders"),
  ),
  c(
    "film:measure",
    "film-measure.ts",
    "film",
    "none",
    "film_measure",
    "Measure a render against targets, audio map and cue sheet; each leg states its fix",
  ),
  c(
    "shot:tournament",
    "shot-tournament.ts",
    "film",
    "none",
    NOT_YET,
    "Hero shot variants: sensors, corpus, blind pairs",
  ),
  c(
    "critic:pack",
    "critic-pack.ts",
    "film",
    "none",
    "critic_pack",
    "Sheets, strips at cuts, curves, loudness and phone sheet for a fresh critic",
  ),

  k(
    [
      "captions",
      "subtitles",
      "titles",
      "burned captions",
      "caption style",
      "cut my video",
      "silences",
      "fillers",
      "shorts",
      "vertical",
    ],
    g(
      "docs/footage-editing.md",
      c(
        "footage:next",
        "footage-next.ts",
        "footage",
        "none",
        "footage_next",
        "A user's recording's next step from files only, with filled-in commands; --playbook binds it",
      ),
    ),
  ),
  c(
    "footage:policy-apply",
    "footage-policy-apply.ts",
    "footage",
    "none",
    { excluded: "answers a user question from the user's autonomous policy; CLI only" },
    "Answer a footage:next question from the policy; logged",
  ),
  k(
    ["transcribe", "transcript", "speech-to-text", "subtitles", "asr", "scribe"],
    g(
      "docs/speech.md",
      c(
        "transcribe",
        "transcribe.ts",
        "footage",
        "paid",
        "transcribe",
        "Scribe or fal to TranscriptSchema; --from-raw replays saved JSON free",
      ),
    ),
  ),
  k(
    ["transcribe", "transcript", "speech-to-text", "subtitles", "asr", "whisper"],
    g(
      "docs/speech.md",
      c(
        "speech:local",
        "speech-local.ts",
        "footage",
        "none",
        LOCAL_ENGINE,
        "Free local TranscriptSchema file and Silero VAD speech-mask.json",
      ),
    ),
  ),
  g(
    "docs/footage-shots.md",
    c(
      "footage:shots",
      "footage-shots.ts",
      "footage",
      "none",
      "footage_shots",
      "Frame-exact cuts, dissolves and fades in a video: shots.json and a storyboard",
    ),
  ),
  g(
    "docs/workflows/recording-edit.md",
    c(
      "recut:plan",
      "recut-plan.ts",
      "footage",
      "none",
      "recut_plan",
      "Unapproved recut request and recut-plan.md (fillers, retakes, pauses) from a transcript, with the hash to approve",
    ),
  ),
  c(
    "shorts:prepare",
    "shorts-prepare.ts",
    "footage",
    "none",
    "shorts_prepare",
    "Shorts step 1: numbered sentences in chunks and the candidate brief",
  ),
  g(
    ".agents/skills/recording-recut/references/shorts-selection.md",
    c(
      "shorts:rank",
      "shorts-rank.ts",
      "footage",
      "none",
      "shorts_rank",
      "Shorts step 2: validate, score and snap candidates into unapproved ShortSelection drafts",
    ),
  ),
  c(
    "shorts:calibrate",
    "shorts-calibrate.ts",
    "footage",
    "none",
    "shorts_calibrate",
    "Shorts threshold from human 1-5 ratings of ranked clips",
  ),
  c(
    "shorts:request",
    "shorts-request.ts",
    "footage",
    "none",
    "shorts_request",
    "Shorts step 3: chapters and, from the user's approved selections, the shorts-series request",
  ),
  g(
    "docs/multicam-reframe.md",
    c(
      "multicam:sync",
      "multicam-sync.ts",
      "footage",
      "none",
      "multicam_sync",
      "Put several recordings on one clock by their sound, with a drift check",
    ),
  ),
  g(
    "docs/multicam-reframe.md",
    c(
      "multicam:angles",
      "multicam-angles.ts",
      "footage",
      "none",
      "multicam_angles",
      "Propose which camera to show when; optional timeline add-track command",
    ),
  ),
  g(
    "docs/multicam-reframe.md",
    c(
      "reframe:track",
      "reframe-track.ts",
      "footage",
      "none",
      "reframe_track",
      "Landscape-to-vertical or square crop path from face and person tracking",
    ),
  ),
  k(
    ["ken burns", "photo", "photos", "slideshow", "still", "faces", "crop", "blur fill"],
    c(
      "photo:focus",
      "photo-focus.ts",
      "footage",
      "none",
      LOCAL_ENGINE,
      "Faces (local YuNet) and start and end crops per format for stills, ready for the photo-move block",
    ),
  ),
  k(
    [
      "cut-out",
      "cutout",
      "remove background",
      "background removal",
      "rmbg",
      "alpha",
      "mask",
      "segmentation",
      "text behind subject",
      "rotoscope",
    ],
    g(
      "docs/matte.md",
      c(
        "matte",
        "matte.ts",
        "footage",
        "none",
        LOCAL_ENGINE,
        "Free local cut-outs (Vision/BiRefNet): PNGs, alpha, ProRes",
      ),
    ),
  ),
  c(
    "media:ingest",
    "media-ingest.ts",
    "footage",
    "none",
    "media_ingest",
    "Import a recording and build its source index",
  ),
  c(
    "media:selects",
    "media-selects.ts",
    "footage",
    "none",
    "media_selects",
    "Lexical or vector selects; explicit --apply to a track",
  ),
  c("media:broll", "media-broll.ts", "footage", "none", "media_broll", "Plan or apply a reviewed muted B-roll track"),
  c("media:words", "media-words.ts", "footage", "none", NOT_YET, "Word-timing proposals from a source index"),
  c("media:local", "media-local.ts", "footage", "none", LOCAL_ENGINE, "Installed offline ASR and embedding engines"),
  c("media:ocr", "media-ocr.ts", "footage", "none", LOCAL_ENGINE, "Local OCR with a trusted prepared config"),
  c("media:visual", "media-visual.ts", "footage", "none", LOCAL_ENGINE, "Local native image-distance search"),
  c(
    "media:category",
    "media-category.ts",
    "footage",
    "none",
    LOCAL_ENGINE,
    "Local native image-category classify and search",
  ),
  c(
    "media:prepare",
    "media-prepare.ts",
    "footage",
    "none",
    LOCAL_ENGINE,
    "Prepare free local speech and screen-text engines outside the repository",
  ),
  c("media:corpus", "media-corpus.ts", "footage", "none", DEV, "Fixed AI/TTS corpus diagnostics"),
  k(
    ["srt", "vtt", "sidecar"],
    c(
      "captions:export",
      "export-captions.ts",
      "footage",
      "none",
      "captions_export",
      "Sidecar SRT/VTT subtitles from exact caption timings, no ASR; burned-in captions: timeline:edit caption-style",
    ),
  ),
  k(
    ["placement", "position", "safe area", "safe zone", "legibility", "contrast"],
    c(
      "captions:place",
      "caption-place.ts",
      "footage",
      "none",
      NOT_YET,
      "Place captions clear of faces, screen text and platform UI; measure legibility; write the caption-style command",
    ),
  ),
  c(
    "video:longform",
    "longform.ts",
    "footage",
    "none",
    "longform",
    "Chapters, approved shorts and exact assembly; plans unless --apply",
  ),

  c(
    "ref:add",
    "ref-add.ts",
    "reference",
    "none",
    "ref_add",
    "Add a reference from a file or link, with rights and crop detection",
  ),
  c(
    "ref:analyze",
    "ref-analyze.ts",
    "reference",
    "none",
    "ref_analyze",
    "Measure a reference's shots, speech, text, audio, motion and sync; contact sheets",
  ),
  c(
    "ref:validate",
    "ref-validate.ts",
    "reference",
    "none",
    "ref_validate",
    "Validate a reference's layers and list missing measured and judged layers",
  ),
  k(
    ["transcript", "verbatim", "copyright", "privacy", "speech text"],
    c(
      "ref:redact",
      "ref-redact.ts",
      "reference",
      "none",
      REPO_CWD,
      "Keep a film's words local; tracked speech-text is structure",
    ),
  ),
  k(
    ["contribute", "pull request", "share analyses", "private reference", "provenance", "credits", "verbatim"],
    g(
      "docs/contributing-references.md",
      c("ref:contribute", "ref-contribute.ts", "reference", "none", REPO_CWD, "Check references before contributing"),
    ),
  ),
  k(
    ["corpus", "norms", "benchmark", "distribution", "percentile", "all references", "техники"],
    g(
      "docs/reference-analysis.md",
      c(
        "ref:corpus",
        "ref-corpus.ts",
        "reference",
        "none",
        "ref_corpus",
        "All analysed references at once: metric spreads, techniques by function, gaps",
      ),
    ),
  ),
  k(
    ["calibration", "degrade", "degraded copy", "labelled pairs", "sensor accuracy"],
    c("ref:degrade", "ref-degrade.ts", "reference", "none", REPO_CWD, "Labelled degraded copies of a reference clip"),
  ),
  g(
    "docs/console.md",
    c(
      "ref:rate",
      "ref-rate.ts",
      "reference",
      "none",
      APPROVAL,
      "Record the user's 1-5 rating of a styleframe, reference or render in pipeline/ratings.json; a note becomes a memory preference",
    ),
  ),
  c(
    "ref:compare",
    "ref-compare.ts",
    "reference",
    "none",
    "ref_compare",
    "Compare a recreation with its reference: aligned shot pairs, colour, camera, findings",
  ),
  c(
    "ref:replica-check",
    "ref-replica-check.ts",
    "reference",
    "none",
    "ref_replica_check",
    "Validate a replica spec against its reference shot by shot",
  ),

  k(
    ["soundtrack", "song", "track", "background music"],
    g(
      "design-reference/music-sources.md",
      c(
        "music",
        "music.ts",
        "audio",
        "none",
        "music",
        "Music route question, stock and chart search, shortlist, acquire, record, rights check",
      ),
    ),
  ),
  c(
    "music:backtime",
    "music-backtime.ts",
    "audio",
    "none",
    NOT_YET,
    "Rank track offsets that land a strong moment on the end card",
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "elevenlabs:capabilities",
      "elevenlabs-capabilities.ts",
      "audio",
      "none",
      "elevenlabs_capabilities",
      "Offline ElevenLabs capabilities; optional explicit metadata refresh",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "voices",
      "voices.ts",
      "audio",
      "none",
      "voices",
      "Search voices or inspect readiness; never creates or selects one",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "voices:manage",
      "voices-manage.ts",
      "audio",
      "may-spend",
      "voices_manage",
      "Plan or resume voice design, creation, cloning, training and pronunciation dictionaries",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "generate:dialogue",
      "generate-dialogue.ts",
      "audio",
      "paid",
      "generate_dialogue",
      "Plan or resume multi-speaker dialogue with source-bound character timing",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "audio:transform",
      "audio-transform.ts",
      "audio",
      "paid",
      "audio_transform",
      "Plan or resume isolation and voice conversion as immutable derived audio",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "speech:replace",
      "speech-replace.ts",
      "footage",
      "may-spend",
      APPROVAL,
      "Plan, prepare and apply a reversible, reviewed phrase replacement",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "dubbing:conform",
      "dubbing-conform.ts",
      "audio",
      "none",
      "dubbing_conform",
      "Conform selected dub spans to immutable scene MP3s with source receipts",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "dubbing",
      "dubbing.ts",
      "audio",
      "may-spend",
      "dubbing",
      "Plan, resume and sync versioned dubbing projects and language outputs",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "sfx:find-segment",
      "sfx-find-segment.ts",
      "audio",
      "none",
      "sfx_find_segment",
      "Find sound events in a recording with prepared Earshot; no automatic trimming",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "sfx:map",
      "sfx-map.ts",
      "audio",
      "none",
      NOT_YET,
      "A recording's or reference's candidate sound events by cue family, with densities and gaps (prepared Earshot)",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "sfx:audition",
      "sfx-audition.ts",
      "audio",
      "none",
      NOT_YET,
      "Choose each hero cue's sound from measured candidates, with Earshot's advisory audit when prepared",
    ),
  ),
  g(
    "docs/audio-integrations.md",
    c(
      "audio:review",
      "audio-review.ts",
      "audio",
      "none",
      "audio_review",
      "Advisory Earshot checks plus independent local loudness measurement",
    ),
  ),
  c(
    "audio:map",
    "audio-map.ts",
    "audio",
    "none",
    "audio_map",
    "A track's tempo, grid, drums, phrases, sections and key moments as a map and PNG",
  ),
  c(
    "audio:curves",
    "audio-curves.ts",
    "audio",
    "none",
    NOT_YET,
    "Per-frame curves from an audio map for audio-reactive motion",
  ),
  c(
    "audio:stems",
    "audio-stems.ts",
    "audio",
    "none",
    LOCAL_ENGINE,
    "Split a track into drums, bass, other and vocals with Demucs (downloads weights)",
  ),
  c(
    "audio:describe",
    "audio-describe.ts",
    "audio",
    "none",
    NOT_YET,
    "CLAP moods, genres, SFX kinds and descriptors for any audio",
  ),
  c(
    "audio:analyze",
    "analyze-audio.ts",
    "audio",
    "none",
    "audio_analyze",
    "Measure loudness, peak and silence of a local file",
  ),
  k(
    ["ducking", "levels", "loudness", "soundtrack"],
    c(
      "audio:mix",
      "mix-audio.ts",
      "audio",
      "none",
      "audio_mix",
      "Measured local mix to a master from a plan or edited project",
    ),
  ),
  c(
    "audio:master",
    "master-audio.ts",
    "audio",
    "none",
    "audio_master",
    "Master one rendered file to a loudness preset without a timeline",
  ),
  c(
    "audio:masking",
    "audio-masking.ts",
    "audio",
    "none",
    NOT_YET,
    "Predicted audibility of placed SFX under music and voice, with fixes",
  ),
  c(
    "audio:syncmap",
    "audio-syncmap.ts",
    "audio",
    "none",
    NOT_YET,
    "PNG and JSON of cuts against beats, SFX and masking over the final mix",
  ),
  c(
    "audio:editorial",
    "editorial-audio.ts",
    "audio",
    "none",
    "editorial_audio",
    "Offline rhythm, SFX, cues and cost-to-finish forecast",
  ),
  c("audio:repair", "repair-render-audio.ts", "audio", "none", NOT_YET, "Repaired MP4 from a preserved original"),
  c(
    "edit:snap",
    "edit-snap.ts",
    "audio",
    "none",
    "edit_snap",
    "Snap cue drafts to an audio map, frame-exact, or suggest cuts",
  ),
  c(
    "edit:plan",
    "edit-plan.ts",
    "audio",
    "none",
    NOT_YET,
    "Edit skeleton from the map's structure (calm, punchy, flurry)",
  ),
  c(
    "sfx:synth",
    "sfx-synth.ts",
    "audio",
    "none",
    "sfx_synth",
    "Procedural seeded SFX pack in the film's key, frame-exact risers",
  ),
  c(
    "sfx:generate",
    "sfx-generate.ts",
    "audio",
    "paid",
    "sfx_generate",
    "Project SFX or video foley take; --dry-run first",
  ),
  c(
    "sfx:cues",
    "sfx-cues.ts",
    "audio",
    "none",
    NOT_YET,
    "Block cues to placed sounds and an audio:mix plan; --fix-masking applies safe fixes",
  ),
  c("sfx:index", "sfx-index.ts", "audio", "none", NOT_YET, "Measured SFX index; --clap adds embeddings and tags"),
  k(
    ["sound effects", "whoosh", "foley"],
    c("sfx:find", "sfx-find.ts", "audio", "none", NOT_YET, "SFX search by text (CLAP) and measured shape"),
  ),
  c("sfx:fetch", "sfx-fetch.ts", "audio", "none", NOT_YET, "Fetch or rebuild the SFX collection from its manifests"),
  c(
    "sfx:library",
    "sfx-library.ts",
    "audio",
    "none",
    NOT_YET,
    "CC0 SFX cache, search by material and length, whoosh and riser synthesis",
  ),

  c("library:usage", "library-usage.ts", "library", "none", REPO_CWD, "Blocks each film used (repetition)"),
  c(
    "library:list",
    "library-list.ts",
    "library",
    "none",
    REPO_CWD,
    "Motion library catalogue: filter by category, query or format; --id for props and previews",
  ),
  c(
    "library:preview",
    "library-preview.ts",
    "library",
    "none",
    REPO_CWD,
    "Render contact sheets of library items into docs/library/previews/",
  ),
  c(
    "library:catalogue",
    "library-catalogue.ts",
    "library",
    "none",
    REPO_CWD,
    "Regenerate docs/library/catalogue.json from the registry; run after changing a block",
  ),

  k(
    ["export", "mp4", "video", "output"],
    c(
      "render",
      "render-project.ts",
      "render",
      "none",
      "render_project",
      "Render a project or timeline; --frames renders a partial excerpt",
    ),
  ),
  k(
    ["captions", "subtitles", "titles", "burned captions", "caption style", "cut", "trim", "undo"],
    c(
      "timeline:edit",
      "timeline-edit.ts",
      "render",
      "none",
      "timeline_edit",
      "Reversible, revision-checked timeline edits incl. burned-in caption-style (--init, --undo, --redo)",
    ),
  ),
  c(
    "motion:render",
    "motion-render.ts",
    "render",
    "none",
    "motion_render",
    "Render a composition or range, optionally import it and return the next timeline:edit",
  ),
  g(
    "docs/agent-vision.md",
    c(
      "motion:still",
      "motion-still.ts",
      "render",
      "none",
      "motion_still",
      "Render exact frames of a composition to PNGs",
    ),
  ),
  c("test:render", "smoke-render.ts", "render", "none", DEV, "Synthetic local render; never loads .env or calls APIs"),
  c(
    "hyperframes:render",
    "hyperframes-render.ts",
    "render",
    "none",
    TRUSTED_CODE,
    "Render a Hyperframes composition with the external CLI, plus provenance",
  ),
  k(
    ["blender", "city", "osm", "buildings"],
    c("blender:city", "blender-city.ts", "render", "none", TRUSTED_CODE, "Cache OSM buildings and credits"),
  ),
  k(
    ["blender", "improve", "critic", "advisor", "gaps", "history"],
    c(
      "blender:improve",
      "blender-improve.ts",
      "render",
      "none",
      { excluded: "Local blind evaluation and fresh read-only harness execution; CLI only" },
      "Blender blind A/B and history",
    ),
  ),
  k(
    ["blender", "arsenal", "audit", "candidates", "eval"],
    c(
      "blender:arsenal",
      "blender-arsenal.ts",
      "render",
      "none",
      { excluded: "Local audit and agent harness execution; CLI only" },
      "Arsenal audit, capability candidates, eval",
    ),
  ),
  k(
    ["blender", "extension", "addon", "plugin"],
    c("blender:ext", "blender-ext.ts", "render", "none", TRUSTED_CODE, "Blender extensions, pinned"),
  ),
  k(
    ["blender", "assets", "materials", "hdri", "models", "library"],
    c("blender:assets", "blender-assets.ts", "assets", "none", TRUSTED_CODE, "Blender asset library"),
  ),
  c("blender:run", "blender-run.ts", "render", "none", TRUSTED_CODE, "Trusted Python/.blend; frames and contact sheet"),
  k(
    ["3d", "live", "interactive", "scene", "look", "iterate", "blender mcp"],
    g(
      ".agents/skills/blender-3d/references/live-session.md",
      c("blender:live", "blender-live.ts", "render", "none", "blender_live", "Live Blender: arsenal, stills, replay"),
    ),
  ),
  k(
    ["blender", "vfx", "recipe", "bake", "proof"],
    c("blender:recipe", "blender-recipe.ts", "render", "none", TRUSTED_CODE, "Blender VFX/nature recipes"),
  ),
  c("blender:scene", "blender-scene.ts", "render", "none", NOT_YET, "Declarative Blender scene to frames"),
  c(
    "backend",
    "backend.ts",
    "render",
    "none",
    "backend",
    "Probe optional backends and export finishing handoffs (Blender, Resolve, Hyperframes)",
  ),
  g(
    "docs/html-capture.md",
    c(
      "capture:html",
      "capture-html.ts",
      "render",
      "none",
      "capture_html",
      "Capture trusted offline HTML as deterministic PNGs or MP4",
    ),
  ),
  g(
    "docs/capture-app.md",
    c(
      "capture:app",
      "capture-app.ts",
      "render",
      "none",
      NOT_YET,
      "Frame-exact capture of a real web app with scripted steps on an injected clock",
    ),
  ),
  g(
    "docs/resolve-worker.md",
    c(
      "resolve:handoff",
      "resolve-handoff.ts",
      "render",
      "none",
      "resolve_handoff",
      "Probe or apply a prepared Resolve handoff to an isolated clone",
    ),
  ),

  g(
    "docs/agent-vision.md",
    c(
      "motion:strip",
      "motion-strip.ts",
      "qa",
      "none",
      "motion_strip",
      "Consecutive frames, difference maps or a per-shot contact sheet; --vs a reference",
    ),
  ),
  k(
    ["photosensitive", "epilepsy", "strobe", "flashing", "wcag", "seizure"],
    c(
      "flash:check",
      "flash-check.ts",
      "qa",
      "none",
      "flash_check",
      "WCAG 2.3.1 flash sensor over every frame of any video: FLASH_RISK ranges of general or saturated-red flashes",
    ),
  ),
  k(
    ["calibration", "sensor accuracy", "gate eligibility", "blind pairs", "critic accuracy"],
    c(
      "judge:calibrate",
      "judge-calibrate.ts",
      "qa",
      "none",
      REPO_CWD,
      "Sensor and blind-critic accuracy on degraded pairs",
    ),
  ),
  c(
    "motion:check",
    "motion-check.ts",
    "qa",
    "none",
    "motion_check",
    "Computational sensors over a composition: counters that must read zero, each with its fix",
  ),
  g(
    "docs/agent-vision.md",
    c(
      "vision:evaluate",
      "vision-evaluate.ts",
      "qa",
      "none",
      { excluded: "Trusted local harness execution and frozen visual evaluation; CLI only" },
      "Prepare and run blind visual agent acceptance with observed image delivery",
    ),
  ),
  g(
    "docs/agent-vision.md",
    c(
      "vision:pack",
      "vision-pack.ts",
      "qa",
      "none",
      "vision_pack",
      "Paginated review frames, crops, evidence and source-bound manifest",
    ),
  ),
  g(
    "docs/agent-vision.md",
    c(
      "vision:inspect",
      "vision-inspect.ts",
      "qa",
      "none",
      "vision_inspect",
      "Verify and read bounded review evidence without writes",
    ),
  ),
  c(
    "review:sheet",
    "review-sheet.ts",
    "qa",
    "none",
    "review_sheet",
    "One storyboard image with timecodes, captions, waveform and cut marks",
  ),
  c("qa:screenshots", "qa-screenshots.ts", "qa", "none", "qa_screenshots", "Extract render screenshots for human QA"),
  c(
    "qa:evidence",
    "qa-evidence.ts",
    "qa",
    "none",
    "qa_evidence",
    "Measured render evidence: frame events and browser layout",
  ),
  c("qa:editorial", "editorial-qa.ts", "qa", "none", "editorial_qa", "Editorial QA report of a timeline or render"),
  c(
    "validate:render",
    "validate-render.ts",
    "qa",
    "none",
    NOT_YET,
    "ffprobe, audio levels and screenshots of a render; findings",
  ),
  c(
    "chart:inspect",
    "chart-inspect.ts",
    "qa",
    "none",
    "chart_inspect",
    "Read-only chart declaration and source correspondence",
  ),
  c(
    "craft:evaluate",
    "craft-evaluation.ts",
    "qa",
    "none",
    "craft_evaluation",
    "Offline craft rubrics and evaluation of supplied evidence",
  ),
  k(
    ["export", "final", "publish"],
    g(
      "docs/delivery.md",
      c(
        "delivery",
        "delivery.ts",
        "qa",
        "none",
        "delivery",
        "Strict delivery snapshot and check, or a native-audio handoff packet; never uploads",
      ),
    ),
  ),
  k(
    ["app store", "google play", "app preview", "conform", "silent track", "aac", "886x1920", "1200x1600"],
    c("store:conform", "store-conform.ts", "qa", "none", NOT_YET, "App store preview conform"),
  ),

  c(
    "pipeline:check",
    "pipeline-check.ts",
    "template",
    "none",
    "pipeline_status",
    "Stateless findings probe: artefact schemas, file references, charts, creative and film findings",
  ),
  c(
    "align:captions",
    "align-captions.ts",
    "template",
    "paid",
    "align_captions",
    "ElevenLabs forced alignment of voiceover to per-scene .words.json",
  ),
  c(
    "edit:captions",
    "edit-captions.ts",
    "legacy",
    "none",
    "edit_captions",
    "Legacy template mode: voiceover captions, filler removal and emphasis; not for a user's recording",
  ),
  c(
    "measure:durations",
    "measure-audio-durations.ts",
    "legacy",
    "none",
    NOT_YET,
    "Legacy template mode: per-scene voiceover durations via ffprobe",
  ),
  c(
    "slice:talking-head",
    "slice-talking-head.ts",
    "legacy",
    "none",
    NOT_YET,
    "Legacy template mode: slice full.mp4 into per-scene presenter clips",
  ),
  c(
    "asset:fetch",
    "asset-fetch.ts",
    "template",
    "may-spend",
    "asset_fetch",
    "Dispatch one asset from asset-plan.json (may generate paid media)",
  ),
  c(
    "asset:fetch-all",
    "asset-fetch-all.ts",
    "template",
    "may-spend",
    "asset_fetch_all",
    "Dispatch every pending asset in asset-plan.json (may generate paid media)",
  ),
  c(
    "video:recipe",
    "video-recipe.ts",
    "template",
    "none",
    "video_recipe",
    "List, preview and materialise recipe animatics and templates",
  ),
  c(
    "video:workflow",
    "video-workflow.ts",
    "template",
    "none",
    "video_workflow",
    "product-ad, education, recording-edit and shorts-series workflows from supplied originals",
  ),
  c(
    "campaign",
    "campaign.ts",
    "template",
    "none",
    "campaign",
    "Campaign variants, localisation and outcomes; never generates or publishes",
  ),

  c(
    "asset:import",
    "import-asset.ts",
    "assets",
    "none",
    "asset_import",
    "Import an immutable original with provenance and rights",
  ),
  c(
    "harness:assets",
    "harness-assets.ts",
    "assets",
    "none",
    "harness_assets",
    "Offline request and import of Codex or Claude harness outputs",
  ),
  c("asset:board", "asset-board.ts", "assets", "none", "asset_board", "Local entity and asset review board"),
  k(
    ["coverage", "turnaround", "view roles", "character sheet"],
    c(
      "entity:card",
      "entity-card.ts",
      "assets",
      "none",
      "entity_card",
      "Versioned character, object, location, style and scene cards; advisory view coverage",
    ),
  ),
  c(
    "resources",
    "resources.ts",
    "assets",
    "none",
    "resources",
    "Stock and SFX providers, routes, search, rights and acquisition",
  ),
  c("resources:poly-haven", "poly-haven.ts", "assets", "none", NOT_YET, "Poly Haven search and exact-file acquisition"),
  c(
    "resources:font",
    "import-font-resource.ts",
    "assets",
    "none",
    "font_resource",
    "Import a licensed font or icon original and build font contexts",
  ),
  c(
    "fetch:sfx",
    "fetch-sound-effects.ts",
    "assets",
    "none",
    SUPERSEDED,
    "Freesound CC0 SFX (use sfx:find and sfx:fetch)",
  ),
  c("fetch:lottie", "fetch-lottie.ts", "assets", "none", SUPERSEDED, "LottieFiles animations"),

  c(
    "fal:batch",
    "fal-batch.ts",
    "generation",
    "paid",
    "fal_batch",
    "N fal operations: summed quotes, budget forecast; dry-run default",
  ),
  f(
    "fal-catalogue",
    c(
      "model:result",
      "model-result.ts",
      "generation",
      "none",
      "model_result",
      "Read an analysis result manifest summary without generation or downloads",
    ),
  ),
  f(
    "fal-catalogue",
    c(
      "fal:quote",
      "fal-quote.ts",
      "generation",
      "none",
      "fal_quote",
      "Quote one fal request or a batch against project policy; provider estimate opt-in on CLI",
    ),
  ),
  c(
    "generate:model",
    "generate-model.ts",
    "generation",
    "paid",
    "generate_model",
    "Schema-validated modern fal operation; --dry-run first",
  ),
  c(
    "generate:image",
    "generate-image.ts",
    "generation",
    "paid",
    "generate_image",
    "Legacy-compatible image generation with budget guards",
  ),
  c(
    "generate:meme",
    "generate-image.ts",
    "generation",
    "paid",
    { excluded: "same script as generate:image (avc_generate_image with model gpt-image-2)" },
    "generate:image with gpt-image-2",
  ),
  c(
    "generate:video",
    "generate-video.ts",
    "generation",
    "paid",
    "generate_video",
    "Legacy-compatible video generation with budget guards",
  ),
  k(
    ["narration", "narrator", "voice", "tts", "text-to-speech", "speech"],
    c(
      "generate:voiceover",
      "generate-voiceover.ts",
      "generation",
      "paid",
      "generate_voiceover",
      "ElevenLabs or fal voiceover for every scene or one --scene",
    ),
  ),
  k(
    ["soundtrack", "song", "compose"],
    c(
      "generate:music",
      "generate-music.ts",
      "generation",
      "paid",
      "generate_music",
      "ElevenLabs Music, or a fal music model as a durable job",
    ),
  ),
  c(
    "generate:stream",
    "generate-stream.ts",
    "generation",
    "paid",
    "generate_stream",
    "One bounded HTTP image stream; offline plan unless --execute",
  ),
  c(
    "generate:realtime",
    "realtime-session.ts",
    "generation",
    "paid",
    "generate_realtime",
    "One bounded realtime session; offline plan by default",
  ),
  c(
    "realtime:editor",
    "realtime-editor.ts",
    "generation",
    "none",
    "realtime_editor",
    "Offline realtime editor drafts and queue; no generation",
  ),
  c("rmbg", "rmbg.ts", "generation", "paid", "rmbg", "Background removal (fal birefnet), durable job; free: matte"),
  c("upscale", "upscale.ts", "generation", "paid", "upscale", "Image upscale (fal aura-sr) as a durable job"),
  f(
    "fal-catalogue",
    c(
      "fal:find",
      "fal-find.ts",
      "generation",
      "none",
      "fal_find",
      "Rank fal and Higgsfield endpoints offline by provider, task, constraints, trust and price",
    ),
  ),
  f(
    "fal-catalogue",
    k(
      ["capabilities", "capability", "end frame", "lip sync", "limits", "input length"],
      c(
        "models:capabilities",
        "models-capabilities.ts",
        "generation",
        "none",
        "models_capabilities",
        "Capability vocabulary, one endpoint's capabilities, limits and scenario price, or a capability search table",
      ),
    ),
  ),
  f(
    "fal-catalogue",
    c(
      "fal:scaffold",
      "fal-scaffold.ts",
      "generation",
      "none",
      "fal_scaffold",
      "Draft and validate an exact provider endpoint request offline",
    ),
  ),
  f(
    "fal-catalogue",
    c(
      "fal:models",
      "fal-models.ts",
      "generation",
      "none",
      NOT_YET,
      "Discover fal models and input schemas (--local offline)",
    ),
  ),
  f(
    "models",
    c(
      "models:prices",
      "models-prices.ts",
      "generation",
      "none",
      "models_prices",
      "Rank catalogue scenario prices offline with evidence, kinds and budget filters",
    ),
  ),
  f(
    "models",
    c(
      "models:compare",
      "models-compare.ts",
      "generation",
      "none",
      "models_compare",
      "Compare exact provider equivalents and savings offline; floors excluded",
    ),
  ),
  f(
    "models",
    c(
      "models:refresh",
      "models-refresh.ts",
      "generation",
      "none",
      { excluded: "network maintenance; CLI only" },
      "Refresh both catalogues and prices; report partial failures, changes, sales and savings",
    ),
  ),
  f(
    "higgsfield",
    c(
      "hf:sync",
      "hf-sync.ts",
      "generation",
      "none",
      { excluded: "network sync; orchestrator only" },
      "Sync the Higgsfield catalogue and schemas; supports offline fixtures",
    ),
  ),
  f(
    "fal-catalogue",
    c(
      "fal:sync",
      "fal-sync.ts",
      "generation",
      "none",
      { excluded: "network (free read-only fal API); CLI only" },
      "Sync the fal catalogue index, schema cache and drift report",
    ),
  ),
  f(
    "fal-catalogue",
    c(
      "fal:doctor",
      "fal-doctor.ts",
      "generation",
      "none",
      "fal_doctor",
      "Removed or retiring fal endpoints in the harness or a project",
    ),
  ),
  f(
    "higgsfield",
    c(
      "hf:pricing",
      "hf-pricing.ts",
      "generation",
      "none",
      { excluded: "network sync; orchestrator only" },
      "Higgsfield pricing: offline reparse/fixtures, free estimate sync and resume",
    ),
  ),
  f(
    "higgsfield",
    c(
      "hf:media",
      "hf-media.ts",
      "generation",
      "none",
      { excluded: "public acquisition and immutable remote request writes; trusted CLI only" },
      "Resolve public media links, import checked originals and bind external URLs without reuploading",
    ),
  ),
  f(
    "higgsfield",
    c(
      "hf:quote",
      "hf-quote.ts",
      "generation",
      "none",
      "hf_quote",
      "Offline Higgsfield request quote; --provider-estimate is CLI-only",
    ),
  ),
  f(
    "higgsfield",
    c(
      "hf:usage",
      "hf-usage.ts",
      "generation",
      "none",
      { excluded: "network analytics; orchestrator only" },
      "Compare Higgsfield usage analytics with a project ledger; not billing",
    ),
  ),
  f(
    "fal-catalogue",
    c(
      "fal:pricing",
      "fal-pricing.ts",
      "generation",
      "none",
      { excluded: "reads the fal pricing API over the network and writes a tracked file; trusted CLI only" },
      "fal list prices and historical per-call averages: --sync, --historical (free), --show, drift",
    ),
  ),
  c(
    "budget",
    "budget.ts",
    "generation",
    "none",
    "budget",
    "Project ceilings, status, receipts and reconciliation; no provider request",
  ),
  g(
    "docs/console.md",
    c(
      "job:cancel",
      "job-cancel.ts",
      "generation",
      "none",
      { excluded: "cancelling a paid job is the user's per-job decision; CLI and console only" },
      "Cancel one paid job on the user's words where the provider supports it; otherwise marks it unavailable",
    ),
  ),
  c(
    "cost:report",
    "cost-report.ts",
    "generation",
    "none",
    "cost_report",
    "Aggregate the cost ledger into pipeline/cost-report.md, with paid jobs reserved and awaiting a receipt",
  ),

  c(
    "commands",
    "commands.ts",
    "dev",
    "none",
    "commands",
    "This registry: find a command by word, section or spend; --write-doc regenerates the docs/commands.md catalogue",
  ),
  c("check", null, "dev", "none", DEV, "lint, typecheck, console unit tests and the full test suite"),
  c("format", null, "dev", "none", DEV, "Prettier: format first-party TypeScript and JavaScript in place"),
  c(
    "format:check",
    null,
    "dev",
    "none",
    DEV,
    "Prettier: fail when first-party TypeScript or JavaScript is not formatted",
  ),
  c("lint", "lint-project.ts", "dev", "none", DEV, "Project AST rules for animation, media and CLI code"),
  c("typecheck", null, "dev", "none", DEV, "tsc --noEmit for the repository and apps/console"),
  c(
    "console:build",
    "console-build.ts",
    "dev",
    "none",
    DEV,
    "Build the studio console bundle into out/console/dist, stamped with the UI source hash (the server also builds on demand)",
  ),
  c("console:test", null, "dev", "none", DEV, "Studio console UI unit tests (Vitest, jsdom)"),
  c(
    "console:e2e",
    null,
    "dev",
    "none",
    DEV,
    "Studio console end-to-end and accessibility tests (Playwright, axe); runs only with RUN_CONSOLE_E2E=1",
  ),
  c("test", null, "dev", "none", DEV, "Every test file"),
  c("test:fast", "test-fast.ts", "dev", "none", DEV, "Quick unit subset; CI runs it"),
  c("test:browser", null, "dev", "none", DEV, "Browser render, review UI, QA evidence and long-form render suites"),
  c(
    "test:integrations",
    null,
    "dev",
    "none",
    DEV,
    "HTTP stream, realtime, Resolve, HTML capture and backend handoff suites",
  ),
  c("test:workflows", null, "dev", "none", DEV, "Workflow render, long-form and chapter-font suites"),
  c("test:recording:timing", null, "dev", "none", DEV, "Recording workflow timing suites"),
  c("test:longform:fullhd", null, "dev", "none", DEV, "Full-HD long-form browser suite"),
  c("test:longform:fullhd:qa", null, "dev", "none", DEV, "Full-HD long-form QA suite"),
  c("test:longform:dense", null, "dev", "none", DEV, "Dense full-HD long-form suites"),
  c("upgrade", null, "dev", "none", DEV, "remotion upgrade"),
  g(
    "docs/mcp.md",
    c(
      "mcp:stdio",
      "src/mcp/stdio.ts",
      "dev",
      "none",
      { excluded: "the MCP server itself" },
      "Trusted local MCP server over stdio (docs/mcp.md)",
    ),
  ),
  c(
    "export:public",
    "export-public.ts",
    "dev",
    "none",
    DEV,
    "Build a clean, leak-scanned public tree; never touches this repository's git",
  ),
  g(
    "docs/publishing.md",
    c(
      "leak:check",
      "leak-check.ts",
      "dev",
      "none",
      { excluded: "repository leak checks and local maintainer patterns; CLI only" },
      "Scan the working tree or added diff lines and paths for private text and provider keys",
    ),
  ),

  c(
    null,
    "generate-lipsync.ts",
    "legacy",
    "paid",
    LEGACY,
    "Opt-in lipsync override (fal sync-lipsync, latentsync)",
    "legacy",
  ),
  c(null, "generate-ai-image.ts", "legacy", "paid", LEGACY, "FLUX or Pollinations image prototype", "legacy"),
  g(
    "docs/metrics.md",
    c(
      "metrics",
      "metrics.ts",
      "dev",
      "none",
      { excluded: "repository inventory and README generation; CLI only" },
      "Offline raw and verified inventory, health, snapshot deltas and README stats",
    ),
  ),
  g(
    "docs/metrics.md",
    c(
      "api:surface",
      "api-surface.ts",
      "dev",
      "none",
      { excluded: "repository API snapshot and compatibility check; CLI only" },
      "Generate or check the stable API surface; compare compatibility with an older snapshot",
    ),
  ),
  g(
    "docs/benchmark.md",
    c(
      "bench:run",
      "bench-run.ts",
      "dev",
      "may-spend",
      { excluded: "starts trusted harness sessions in isolated worktrees; CLI only" },
      "Run pinned benchmark tasks in Claude Code or Codex and collect hashed result bundles",
    ),
  ),
  g(
    "docs/benchmark.md",
    c(
      "bench:sign",
      "bench-sign.ts",
      "dev",
      "none",
      { excluded: "uses a submitter SSH private key; CLI only" },
      "Sign a benchmark bundle manifest in the agentbros-bench SSH namespace",
    ),
  ),
  g(
    "docs/benchmark.md",
    c(
      "bench:verify",
      "bench-verify.ts",
      "dev",
      "none",
      { excluded: "verifies community bundles against trusted signer and suite policy; CLI only" },
      "Verify bundle signatures, hashes and offline deterministic claims without changing the bundle",
    ),
  ),
  g(
    "docs/benchmark.md",
    c(
      "bench:judge",
      "bench-judge.ts",
      "dev",
      "paid",
      { excluded: "maintainer-controlled calibrated picture judges and budget; CLI only" },
      "Prepare blind picture pairs and judge with two calibrated vendors under durable spend admission",
    ),
  ),
  g(
    "docs/benchmark.md",
    c(
      "bench:rate",
      "bench-rate.ts",
      "dev",
      "none",
      { excluded: "maintainer benchmark analysis with private anonymisation keys; CLI only" },
      "Fit Bradley–Terry ratings with bootstrap intervals, measured noise and cost/time normalisation",
    ),
  ),
];

export const commandByMcpTool = (name: string): CommandEntry | undefined =>
  COMMAND_REGISTRY.find((entry) => typeof entry.mcp === "string" && entry.mcp === name);

/** Commands matching every query word in a keyword, the alias, script, purpose, section or MCP tool; keyword matches rank first, then alias and purpose, then registry order. */
export function findCommands(filter: { query?: string; section?: string; paid?: boolean } = {}): CommandEntry[] {
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { entry: CommandEntry; score: number; index: number }[] = [];
  COMMAND_REGISTRY.forEach((entry, index) => {
    if (filter.section && entry.section !== filter.section) return;
    if (filter.paid && entry.paid === "none") return;
    const fields: [string, number][] = [
      [(entry.keywords ?? []).join(" "), 3],
      [`${entry.alias ?? ""} ${entry.purpose}`, 2],
      [
        `${entry.script ?? ""} ${SECTIONS[entry.section]} ${typeof entry.mcp === "string" ? `avc_${entry.mcp}` : ""}`,
        1,
      ],
    ];
    let score = 0;
    for (const word of words) {
      const best = Math.max(
        0,
        ...fields.filter(([text]) => text.toLowerCase().includes(word)).map(([, weight]) => weight),
      );
      if (!best) return;
      score += best;
    }
    scored.push({ entry, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(({ entry }) => entry);
}

/** The MCP tool name as served (avc_<name>), or null when the command is not a tool. */
export const mcpToolName = (entry: CommandEntry): string | null =>
  typeof entry.mcp === "string" ? `avc_${entry.mcp}` : null;

const defaultTool = (entry: CommandEntry) => `avc_${(entry.alias ?? "").replace(/[:-]/g, "_")}`;

const mcpCell = (entry: CommandEntry) =>
  mcpToolName(entry) === defaultTool(entry) ? "MCP" : `\`${mcpToolName(entry)}\``;
const spendCell = (entry: CommandEntry) => (entry.paid === "none" ? "" : ` **${entry.paid}**`);
const nameCell = (entry: CommandEntry) =>
  entry.alias ? `\`${entry.alias}\`` : `\`${entry.script}\` (${entry.unaliased})`;

export const CATALOGUE_DOC = "docs/commands.md";
export const CATALOGUE_BEGIN = "<!-- commands:begin (generated by pnpm commands --write-doc; do not edit) -->";
export const CATALOGUE_END = "<!-- commands:end -->";

/** The generated catalogue section of docs/commands.md: one line per command, grouped by section; development tools share one line. */
export function catalogueMarkdown(): string {
  const lines = [
    CATALOGUE_BEGIN,
    "",
    "Line: alias or script - purpose; spend unless none; exposed MCP tool (`MCP` means `avc_` plus alias with `:`/`-` replaced by `_`). Exclusions: `pnpm commands --query <word>`.",
    "",
  ];
  for (const [section, title] of Object.entries(SECTIONS)) {
    const entries = COMMAND_REGISTRY.filter((entry) => entry.section === section);
    if (!entries.length) continue;
    lines.push(`### ${title}`, "");
    if (section === "dev") {
      lines.push(
        `- ${entries.map(nameCell).join(", ")}: development tools; purposes: \`pnpm commands --section dev\``,
        "",
      );
      continue;
    }
    const printed = new Set<string>();
    for (const entry of entries) {
      if (entry.family && entry.paid === "none") {
        if (printed.has(entry.family)) continue;
        printed.add(entry.family);
        const family = FAMILIES[entry.family];
        const members = entries.filter((member) => member.family === entry.family && member.paid === "none");
        lines.push(
          `- ${members.map(nameCell).join(", ")} - ${family.label} ([guide](../${family.guide})); purposes: \`pnpm commands --query ${entry.family.split("-")[0]}\``,
        );
        continue;
      }
      lines.push(
        `- ${nameCell(entry)} - ${entry.purpose}${entry.guide ? ` ([guide](../${entry.guide}))` : ""}${spendCell(entry)}${typeof entry.mcp === "string" ? `; ${mcpCell(entry)}` : ""}`,
      );
    }
    lines.push("");
  }
  lines.push(CATALOGUE_END);
  return lines.join("\n");
}

/** The document with its generated catalogue section replaced. */
export function withCatalogue(doc: string): string {
  const start = doc.indexOf(CATALOGUE_BEGIN);
  const end = doc.indexOf(CATALOGUE_END);
  if (start < 0 || end < start)
    throw new CliErrorObject({ code: "VALIDATION", message: `${CATALOGUE_DOC} has no generated catalogue markers.` });
  return doc.slice(0, start) + catalogueMarkdown() + doc.slice(end + CATALOGUE_END.length);
}
