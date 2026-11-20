/**
 * Which playbook owns each film type, template recipe and workflow scenario, and which commands and library categories
 * serve every playbook (GENERAL). playbooks/AGENTS.md's coverage table is generated from here (`pnpm playbook --write-doc`);
 * tests/playbooks-coverage.test.ts holds every production command and library category to an owner.
 */
import type { CommandSection } from "../cli/commands";
import type { FilmType } from "../../types/pipeline";
import type { RecipeIdSchema } from "../../types/recipes";
import type { z } from "zod";
import type { WorkflowKind } from "../workflows/dispatch";

/** `pending`: the playbook is being written and does not exist yet; every owner must exist once the round ends. */
export type CoverageOwner =
  { playbook: string; when?: string; pending?: true } | { modifier: "replica" | "reference-style"; when?: string };

export const FILM_TYPE_COVERAGE: Record<FilmType, CoverageOwner[]> = {
  "motion-graphics": [
    { playbook: "product-promo", when: "selling a product" },
    { playbook: "motion-design", when: "not selling one" },
    { playbook: "teaser-trailer", when: "building anticipation before a reveal" },
  ],
  "ui-demo": [
    { playbook: "product-tutorial", when: "how to use it" },
    { playbook: "product-promo", when: "why to want it" },
    { playbook: "feature-update", when: "what is new in a release" },
    { playbook: "app-store-preview", when: "a store preview" },
  ],
  footage: [
    { playbook: "stock-montage", when: "stock or supplied b-roll" },
    { playbook: "event-recap", when: "an event the user filmed" },
    { playbook: "photo-slideshow", when: "the user's photos" },
  ],
  "ai-video": [{ playbook: "ai-film" }],
  "talking-head": [
    { playbook: "footage-edit", when: "the user recorded it" },
    { playbook: "avatar-presenter", when: "a generated presenter" },
  ],
  explainer: [{ playbook: "explainer" }],
  collage: [{ playbook: "motion-design" }, { playbook: "photo-slideshow", when: "the user's photos" }],
  replica: [{ modifier: "replica" }],
};

export const RECIPE_COVERAGE: Record<z.infer<typeof RecipeIdSchema>, CoverageOwner[]> = {
  "social-hook": [
    { playbook: "product-promo", when: "selling a product" },
    { playbook: "motion-design", when: "not selling one" },
  ],
  "ad-direct": [{ playbook: "product-promo" }],
  "product-demo": [{ playbook: "product-tutorial" }],
  "educational-explainer": [{ playbook: "explainer" }],
  "youtube-chapter": [{ playbook: "explainer" }],
  "documentary-story": [{ playbook: "stock-montage" }],
  "music-motion": [{ playbook: "motion-design" }],
};

export const WORKFLOW_COVERAGE: Record<WorkflowKind, CoverageOwner[]> = {
  "product-ad": [{ playbook: "product-promo" }],
  education: [{ playbook: "explainer" }],
  "recording-edit": [{ playbook: "footage-edit" }],
  "shorts-series": [{ playbook: "shorts-from-long" }],
};

/** Footage goals that pick a playbook for an unbound footage project, most specific first. */
export const FOOTAGE_GOAL_COVERAGE: { goal: string; owner: CoverageOwner }[] = [
  { goal: "shorts", owner: { playbook: "shorts-from-long" } },
  { goal: "*", owner: { playbook: "footage-edit" } },
];

/** Registry sections that are not production: no playbook owns them. */
export const NON_PRODUCTION_SECTIONS: Partial<Record<CommandSection, string>> = {
  dev: "development, tests and repository tools: they build the harness, not a film",
  legacy: "legacy scripts kept for old projects; not for new work",
};

/** Commands that serve every playbook, each with why no single playbook owns it. */
export const GENERAL_COMMANDS: Record<string, string> = {
  "harness:setup":
    "connects the user's coding agents to the skills and MCP server for every playbook; docs/harnesses.md",
  "step:unlock": "the step lease's escape hatch on any film or footage project; docs/step-lease.md",
  "film:versions": "disk housekeeping of any bespoke film's kept renders; docs/cleanup.md",
  "narration:check":
    "the narration step of any voiced film type (explainer, ui-demo, ai-video); docs/production-chain/narration.md",
  "step:violations": "the step lease's out-of-step report on any film or footage project; docs/step-lease.md",
  "studio:open": "the user's live Remotion Studio of any project, opened from the console; docs/console.md",

  "vork:setup": "optional local 3D/VFX engine chosen per shot across playbooks",
  "vork:scene": "optional local 3D/VFX engine chosen per shot across playbooks",
  "vork:render": "optional local 3D/VFX engine chosen per shot across playbooks",
  "vork:recipe": "optional local 3D/VFX engine chosen per shot across playbooks",
  "vork:bridge": "optional local 3D/VFX engine chosen per shot across playbooks",
  "vork:vfx": "optional local 3D/VFX engine chosen per shot across playbooks",
  "vork:eval": "optional local 3D/VFX engine chosen per shot across playbooks",

  "colour:scopes": "colour grading of any film's footage or generated shots; docs/colour-grading.md",
  "colour:compare": "colour grading of any film's footage or generated shots; docs/colour-grading.md",
  "colour:match": "colour grading of any film's footage or generated shots; docs/colour-grading.md",
  "colour:grade": "colour grading of any film's footage or generated shots; docs/colour-grading.md",
  "colour:shots": "colour grading of any film's footage or generated shots; docs/colour-grading.md",
  "colour:track": "colour grading of any film's footage or generated shots; docs/colour-grading.md",
  "colour:check": "colour grading of any film's footage or generated shots; docs/colour-grading.md",
  "colour:looks": "colour grading of any film's footage or generated shots; docs/colour-grading.md",
  "colour:lut": "colour grading of any film's footage or generated shots; docs/colour-grading.md",
  "colour:target": "colour grading of any film's footage or generated shots; docs/colour-grading.md",

  "viz:list": "Prepared charts and diagrams across playbooks; docs/visualisations.md",
  "viz:prepare": "Prepared charts and diagrams across playbooks; docs/visualisations.md",
  "viz:inspect": "Prepared charts and diagrams across playbooks; docs/visualisations.md",
  "viz:preview": "Prepared charts and diagrams across playbooks; docs/visualisations.md",
  "viz:render": "Prepared charts and diagrams across playbooks; docs/visualisations.md",
  "viz:mount": "Prepared charts and diagrams across playbooks; docs/visualisations.md",
  "viz:check": "Prepared charts and diagrams across playbooks; docs/visualisations.md",

  "vision:pack": "Source-bound visual evidence and readable review pages for every route",
  "vision:inspect": "Read-only verification and frame evidence navigation across all playbooks",
  "vision:evaluate": "Cross-route local harness acceptance, independent of film production",
  preflight: "environment check before any work",
  bootstrap: "first-run setup of the harness before any work",
  keys: "which service keys are set, for any playbook's paid or stock steps",
  studio: "preview of any composition",
  projects: "lists every project",
  next: "the next step of any project, whatever its route",
  playbook: "chooses and binds the playbook itself",
  memory: "the user's local memory, read and written across every playbook",
  "memory:upstream": "exports an applied harness improvement, not a film",
  "project:remove": "removes any project's footprint on the user's word",
  "workspace:clean": "clears generated data across projects",
  "models:prices": "ranks catalogue scenario prices offline for every kind of video",
  "models:capabilities": "lists, profiles and searches model capabilities offline for any generation route",
  "models:refresh": "maintains both provider catalogues and pricing evidence",
  "models:slots": "lists and validates the task-slot table for every kind of video",
  "models:slot": "owner curation of task-slot candidates, not a production step",
  "models:verdict": "records the owner's verdict on a model outcome in any project",
  "models:stats": "reports model outcomes across projects for curation",
  "hf:sync": "refreshes the public Higgsfield catalogue and schema index",
  "fal:sync": "refreshes the fal catalogue index every generation route reads",
  "model:result": "reads existing analysis evidence for any project without generation",
  "fal:doctor": "checks removed or retiring fal endpoints across the harness and any project",
  "assets:sync": "fetches shared media any film may use",
  "review:ui": "local review of any project",
  console:
    "the studio console beside the chat for any project (stub until RFC 0004 WP2); docs/rfcs/0004-studio-console.md",
  "console:wait": "waits for the user's console decision at any gate; docs/rfcs/0004-studio-console.md",
  "console:card":
    "an agent card on any project's console canvas (stub until RFC 0004 WP11); docs/rfcs/0004-studio-console.md",
  "console:control":
    "the user's pause, resume and stop of any project (RFC 0004 D12); docs/rfcs/0004-studio-console.md",
  "job:cancel":
    "the user's per-job cancel of a paid job after a stop, any project (RFC 0004 D12); docs/paid-execution.md",
  "console:snapshot":
    "static, read-only snapshot of any project's console view (RFC 0004 D18); docs/rfcs/0004-studio-console.md",
  "ref:rate":
    "the user's ratings of references, styleframes and renders in any film (RFC 0004 WP9); docs/rfcs/0004-studio-console.md",
  render: "renders any project or timeline",
  delivery: "strict delivery snapshot and check of every film",
  "library:list": "the motion library catalogue every film starts from",
  "library:preview": "maintains the library's contact sheets, not a film",
  "library:catalogue": "regenerates the library catalogue, not a film",
  "film:route": "the film chain's machinery, run by film:next for every film-route playbook",
  "film:brief": "the film chain's machinery, run by film:next for every film-route playbook",
  "film:show": "the film chain's machinery, named in every owner and fixer brief film:brief writes",
  "film:done": "the film chain's machinery, run by film:next for every film-route playbook",
  feedback: "the human step's route for the user's changes, in every film-route playbook",
  "film:policy": "the user's autonomy policy and guard limits, for any film- or footage-route playbook",
  "footage:policy-apply":
    "answers a footage:next question from the user's policy, run by footage:next for any footage-route playbook",
  "film:revert": "revokes a policy decision on the user's words, for any film- or footage-route playbook",
  "creative:stimuli": "the film chain's machinery, run by film:next for every film-route playbook",
  "creative:pool": "the film chain's machinery, run by film:next for every film-route playbook",
  "creative:rank": "the film chain's machinery, run by film:next for every film-route playbook",
  "creative:pick": "the film chain's machinery, run by film:next for every film-route playbook",
  "concept:boards": "the film chain's machinery, run by film:next for every film-route playbook",
  "film:stills": "the film chain's machinery, run by film:next for every film-route playbook",
  "critic:pack": "the film chain's machinery, run by film:next for every film-route playbook",
  "creative:bench": "benchmarks the film chain itself, not a film",
  "ref:degrade": "makes calibration pairs for the harness's sensors and critic, not a film",
  "ref:redact": "keeps the reference library's tracked text structure-only, not a film",
  "ref:contribute": "checks reference analyses before they are contributed to the repository, not a film",
  "judge:calibrate": "scores the harness's sensors and critic on calibration pairs, not a film",
  "video:recipe":
    "previews and materialises recipe drafts for any playbook; the project.json it writes is on the timeline route",
  "pipeline:check":
    "artefact, chart and film findings for every film-route playbook (stateless; the next step comes from next)",
  "film:rights": "the replica modifier's rights gate, over any playbook",
  "ref:validate": "the reference-style and replica modifiers, over any playbook",
  "ref:compare": "the reference-style and replica modifiers, over any playbook",
  "ref:replica-check": "the replica modifier, over any playbook",
  budget: "budget of any project that may spend",
  "hf:pricing": "maintains Higgsfield price observations for generation quotes",
  "hf:quote": "inspects Higgsfield request spend without generation",
  "hf:usage": "reconciles account analytics with project costs",
  "fal:pricing": "refreshes fal list prices for any generation quote",
  "cost:report": "cost report of any project that spent",
  "audio:stems": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "audio:describe": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "audio:analyze": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "audio:master": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "audio:masking": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "audio:syncmap": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "audio:editorial": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "audio:repair": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "sfx:index": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "sfx:find": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "sfx:fetch": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "sfx:audition": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "sfx:map": "the reference step of any film with a reference (reference-analysis skill), not one kind of video",
  "generate:music": "the sound step of any film (sound-director, sound-design-and-mix skill), not one kind of video",
  "media:words": "local media analysis behind footage and material steps of any playbook",
  "media:local": "local media analysis behind footage and material steps of any playbook",
  "media:ocr": "local media analysis behind footage and material steps of any playbook",
  "media:visual": "local media analysis behind footage and material steps of any playbook",
  "media:category": "local media analysis behind footage and material steps of any playbook",
  "media:prepare": "local media analysis behind footage and material steps of any playbook",
  "motion:render": "a render or finishing backend chosen per shot by engine-selection, over any playbook",
  "hyperframes:render": "a render or finishing backend chosen per shot by engine-selection, over any playbook",
  "blender:run": "a render or finishing backend chosen per shot by engine-selection, over any playbook",
  "blender:live": "a render or finishing backend chosen per shot by engine-selection, over any playbook",
  "blender:scene": "a render or finishing backend chosen per shot by engine-selection, over any playbook",
  backend: "a render or finishing backend chosen per shot by engine-selection, over any playbook",
  "resolve:handoff": "a render or finishing backend chosen per shot by engine-selection, over any playbook",
  "qa:screenshots": "render QA and evaluation for any film",
  "qa:evidence": "render QA and evaluation for any film",
  "qa:editorial": "render QA and evaluation for any film",
  "validate:render": "render QA and evaluation for any film",
  "craft:evaluate": "render QA and evaluation for any film",
  "asset:fetch": "dispatches an asset plan's media for any project through the budget layer",
  "asset:fetch-all": "dispatches an asset plan's media for any project through the budget layer",
  "harness:assets": "asset and font acquisition for any film's material",
  "resources:poly-haven": "asset and font acquisition for any film's material",
  "media:fetch": "public media acquisition for any film material step",
  "resources:icons": "shared icon and logo resources for any film material or build step",
  "resources:icons:read": "shared icon and logo resources for any film material or build step",
  "resources:logos": "shared icon and logo resources for any film material or build step",
  "resources:logos:read": "shared icon and logo resources for any film material or build step",
  "resources:icon-profile": "shared icon and logo resources for any film material or build step",
  "resources:icon-profile:read": "shared icon and logo resources for any film material or build step",
  "resources:icons:verify": "shared icon and logo resources for any film material or build step",
  "resources:font": "asset and font acquisition for any film's material",
  "generate:meme": "paid generation any film's material step may use through the budget layer",
  "generate:stream": "paid generation any film's material step may use through the budget layer",
  "generate:realtime": "paid generation any film's material step may use through the budget layer",
  "realtime:editor": "paid generation any film's material step may use through the budget layer",
  upscale: "paid generation any film's material step may use through the budget layer",
};

/** Library categories that serve every playbook, each with why. */
export const GENERAL_CATEGORIES: Record<string, string> = {};

export const ownerPlaybooks = (owners: CoverageOwner[], options: { includePending?: boolean } = {}): string[] =>
  owners.flatMap((owner) =>
    "playbook" in owner && (options.includePending || !owner.pending) ? [owner.playbook] : [],
  );

const ownerText = (owner: CoverageOwner): string => {
  const name = "playbook" in owner ? `\`${owner.playbook}\`` : `${owner.modifier} modifier`;
  const notes = [owner.when, "playbook" in owner && owner.pending ? "pending" : undefined].filter(Boolean);
  return notes.length ? `${name} (${notes.join("; ")})` : name;
};

/** The coverage table of playbooks/AGENTS.md: entries with the same owners share a row. */
export function coverageTable(): string {
  const rows = new Map<string, string[]>();
  const add = (label: string, owners: CoverageOwner[]) => {
    const key = owners.map(ownerText).join(" or ");
    rows.set(key, [...(rows.get(key) ?? []), label]);
  };
  for (const [type, owners] of Object.entries(FILM_TYPE_COVERAGE)) add(`film type \`${type}\``, owners);
  for (const [recipe, owners] of Object.entries(RECIPE_COVERAGE)) add(`recipe \`${recipe}\``, owners);
  for (const [workflow, owners] of Object.entries(WORKFLOW_COVERAGE)) add(`workflow \`${workflow}\``, owners);
  return [
    "| Registry entry | Owner |",
    "|---|---|",
    ...[...rows].map(([owners, labels]) => `| ${labels.join(", ")} | ${owners} |`),
  ].join("\n");
}
