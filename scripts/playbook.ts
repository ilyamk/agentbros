/** Playbooks: list, show, match a request, find who uses a name, bind a project, regenerate the index, check every reference. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { detectRoute, playbookRouteOf } from "../src/lib/pipeline/route";
import { evaluateMatching, loadMatchCorpus, MATCH_CORPUS } from "../src/lib/playbooks/eval";
import {
  findUses,
  INDEX_DOC,
  lessonsFor,
  listPlaybookIds,
  loadPlaybook,
  loadPlaybooks,
  matchPlaybooks,
  optionalSkills,
  playbooksRoot,
  playbookWarnings,
  projectPlaybookFile,
  resolvePlaybook,
  reviewAgeWarning,
  routeText,
  validatePlaybookRefs,
  withIndexTable,
  writeProjectPlaybook,
  type PlaybookMatch,
} from "../src/lib/playbooks";

/** Playbooks are read from the checkout that holds the code; projects from the working directory (the MCP workspace root). */
const root = playbooksRoot();

const known = (id: string) => {
  if (!listPlaybookIds(root).includes(id))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Unknown playbook "${id}". Known: ${listPlaybookIds(root).join(", ")}.`,
    });
};

const MODIFIER_SKILL = { "reference-style": "reference-to-video", replica: "reference-replica" } as const;

function matchHint(result: PlaybookMatch): string {
  const parts: string[] = [];
  if (result.existingProject) {
    parts.push(
      `The request names the existing project ${result.existingProject}: continue it with pnpm next --project ${result.existingProject}; the candidates below matter only if the user wants a new film.`,
    );
  }
  if (result.strength === "none")
    parts.push(`No playbook fits. Read ${INDEX_DOC} and ask the user what they want made.`);
  else if (result.tie)
    parts.push(`Several playbooks fit equally (weak). Read ${INDEX_DOC} and ask the user: ${result.question}`);
  else if (result.strength === "weak")
    parts.push(
      `Weak match (a low score or a small lead). Read the top candidates with pnpm playbook --id <id> and confirm with the user before binding.`,
    );
  else
    parts.push(
      `Clear match. Read it with pnpm playbook --id ${result.candidates[0]!.id}, then start a new project with its Start command (it binds), or bind an existing one with pnpm playbook --use ${result.candidates[0]!.id} --project <id>.`,
    );
  const top = result.candidates[0];
  if (top?.variant)
    parts.push(
      `It matched the ${top.variant.id} variant (${top.variant.title}): read what it changes under variants in pnpm playbook --id ${top.id}.`,
    );
  if (top?.status === "draft")
    parts.push(`${top.id} is a draft: tell the user what it lacks (its Done when section) before relying on it.`);
  for (const modifier of result.modifiers)
    parts.push(
      `Modifier ${modifier}: also follow the ${MODIFIER_SKILL[modifier]} skill${modifier === "replica" ? " (only because the user asked for an exact copy)" : ""}.`,
    );
  return parts.join(" ");
}

void runScript(async () => {
  const args = parseArgs([
    { name: "list", type: "boolean", description: "Every playbook: id, title, status, summary, route" },
    {
      name: "id",
      description:
        "One playbook resolved: route guide, merged QA, read lists, intake, profiles, starter, variants, tagged lessons",
    },
    {
      name: "full",
      type: "boolean",
      description: "With --id: also the matching triggers and every step's film-type tools",
    },
    {
      name: "match",
      description: "The user's request, quoted: ranked candidates, strength, modifiers, an existing project",
    },
    {
      name: "uses",
      description:
        "Which playbooks name a command, block, category, skill, agent, caption profile, style or template, and where",
    },
    { name: "use", description: "Bind --project to this playbook (pipeline/playbook.json)" },
    { name: "project", description: "Project ID for --use" },
    { name: "by", description: "Who chose the playbook for --use: agent (default) or user" },
    {
      name: "force",
      type: "boolean",
      description: "With --use: replace a different or unreadable binding deliberately",
    },
    { name: "write-doc", type: "boolean", description: `Regenerate the index and coverage tables in ${INDEX_DOC}` },
    { name: "check", type: "boolean", description: "Validate every playbook's references" },
    {
      name: "eval",
      type: "boolean",
      description: `Score --match on the labelled requests in ${MATCH_CORPUS} (or --corpus): top-1, clear and every miss`,
    },
    { name: "corpus", description: "With --eval: another labelled corpus file" },
    {
      name: "strict-benchmarks",
      type: "boolean",
      description: "With --check: require benchmark tasks for ready playbooks",
    },
  ] as const);

  if (args["strict-benchmarks"] && !args.check)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--strict-benchmarks needs --check." });
  if (args["write-doc"]) {
    const file = path.join(root, INDEX_DOC);
    writeFileSync(file, withIndexTable(readFileSync(file, "utf8"), root));
    return { outputs: [INDEX_DOC], metadata: { written: INDEX_DOC, playbooks: listPlaybookIds(root) } };
  }
  if (args.check) {
    const problems = validatePlaybookRefs(root, { strictBenchmarks: args["strict-benchmarks"] });
    if (problems.length)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `${problems.length} playbook problem(s): ${problems.join("; ")}`,
        details: { problems },
      });
    return {
      metadata: { playbooks: listPlaybookIds(root), problems: [], warnings: playbookWarnings(loadPlaybooks(root)) },
    };
  }
  if (args.uses !== undefined) {
    if (!args.uses.trim())
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message:
          "--uses needs a name: a command alias, library block or category, skill, agent, caption profile, style or template.",
      });
    const answer = findUses(args.uses.trim(), root);
    return {
      metadata: {
        ...answer,
        ...(answer.kinds.length
          ? {}
          : {
              warning: `${answer.name} is not a known command, library block or category, skill, agent, caption profile, style or template.`,
            }),
      },
    };
  }
  if (args.use !== undefined) {
    if (!args.project) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--use needs --project <id>." });
    validateProjectId(args.project);
    known(args.use);
    const by = args.by ?? "agent";
    if (by !== "agent" && by !== "user")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `--by must be agent or user, not ${by}.` });
    const dir = path.join("public", "projects", args.project);
    if (!existsSync(dir))
      throw new CliErrorObject({
        code: "PROJECT_NOT_FOUND",
        message: `Project "${args.project}" not found under public/projects/.`,
      });
    const detected = detectRoute(dir);
    const kind = detected.route && !detected.detectedBy.startsWith("pipeline/playbook.json") ? detected.route : null;
    const playbook = loadPlaybook(args.use, root);
    // A project.json project (timeline route) renders as it stands: any playbook may bind it for its reads and memory.
    if (kind && kind !== "timeline" && !playbookRouteOf(playbook, kind)) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Project "${args.project}" is on the ${kind} route (${detected.detectedBy}); playbook ${args.use} has no ${kind} route or alternative. Choose another playbook, or start a new project with: ${playbook.route.start}`,
      });
    }
    const binding = writeProjectPlaybook(dir, args.use, by, root, { force: args.force === true });
    const resolved = resolvePlaybook(args.use, root);
    return {
      outputs: [projectPlaybookFile(dir)],
      metadata: {
        binding,
        ...(kind ? { route: kind } : {}),
        start: resolved.start,
        read: resolved.read,
        next: `pnpm next --project ${args.project}`,
      },
    };
  }
  if (args.id !== undefined) {
    known(args.id);
    const resolved = resolvePlaybook(args.id, root);
    const { playbook } = resolved;
    const review = reviewAgeWarning(playbook);
    const optional = optionalSkills(playbook, root);
    const missing = optional.filter((skill) => !skill.installed);
    const variants = playbook.variants ?? [];
    let shown: Record<string, unknown> = resolved;
    if (!args.full) {
      // Each field once: route as start and route, read and stepRead, qa merged, intake, profiles, starter and variants below, not again inside `playbook`; matching triggers and each step's tools (film:next hands a step its tools) only with --full.
      const {
        triggers: _triggers,
        intake: _intake,
        profiles: _profiles,
        starter: _starter,
        variants: _variants,
        route: _route,
        read: _read,
        stepRead: _stepRead,
        qa: _qa,
        optionalSkills: _optionalSkills,
        ...core
      } = playbook;
      const route =
        resolved.route.kind === "film"
          ? (({ tools, ...rest }) => ({
              ...rest,
              toolSteps: Object.keys(tools),
              tools: `each step's tools come with its film:next answer; all of them: pnpm film:route --type ${rest.type}${rest.secondary ? ` --secondary ${rest.secondary}` : ""}`,
            }))(resolved.route)
          : resolved.route;
      shown = { ...resolved, playbook: core, route };
    }
    return {
      metadata: {
        ...shown,
        reviewedAt: playbook.reviewedAt ?? null,
        ...(review ? { reviewWarning: review } : {}),
        intake: playbook.intake ?? [],
        profiles: playbook.profiles ?? [],
        starter: playbook.starter ?? null,
        variants: args.full ? variants : variants.map(({ triggers: _triggers, ...variant }) => variant),
        lessons: lessonsFor(args.id, root),
        optionalSkills: optional,
        ...(missing.length
          ? {
              optionalSkillsNote: `Optional, not required: ${missing.map((skill) => `${skill.id}${skill.install ? ` (install from upstream: ${skill.install})` : ""}`).join("; ")}. The method works without ${missing.length === 1 ? "it" : "them"}; never block on a missing optional skill.`,
            }
          : {}),
      },
    };
  }
  if (args.eval) {
    const file = args.corpus ?? path.join(root, MATCH_CORPUS);
    const report = evaluateMatching(loadMatchCorpus(file), loadPlaybooks(root));
    return { metadata: { corpus: path.relative(root, file) || file, ...report } };
  }
  if (args.match !== undefined) {
    if (!args.match.trim())
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: '--match needs the user\'s request, quoted: --match "<request>".',
      });
    const result = matchPlaybooks(args.match, root);
    return { metadata: { ...result, index: INDEX_DOC, hint: matchHint(result) } };
  }
  if (args.list) {
    return {
      metadata: {
        index: INDEX_DOC,
        playbooks: loadPlaybooks(root).map((playbook) => ({
          id: playbook.id,
          title: playbook.title,
          status: playbook.status,
          summary: playbook.summary,
          route: routeText(playbook.route).replaceAll("`", ""),
        })),
      },
    };
  }
  throw new CliErrorObject({
    code: "INVALID_INPUT",
    message:
      'Pass one of --list, --id <id>, --match "<request>", --uses <name>, --use <id> --project <id> [--force], --write-doc, --check or --eval.',
  });
});
