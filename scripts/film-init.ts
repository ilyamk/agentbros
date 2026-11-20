import { filmStyleFile, writeFilmStyle } from "../src/lib/film-styles/binding";
import { filmStyleKey, selectFilmStyle } from "../src/lib/film-styles/catalogue";
/** Creates a bespoke project for the film chain. Its state is derived from files and hashes; it writes no pipeline-state.json. */
import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { takeRepeated } from "../src/lib/film/cli";
import { DEFAULT_RUBRIC_VERSION, RUBRIC_VERSIONS, isRubricVersion } from "../src/lib/film/creative-rubric";
import { scaffoldFilmProject } from "../src/lib/film/project";
import {
  FILM_TYPES,
  STANDALONE_TYPES,
  filmTypeOf,
  resolveRoute,
  routeOf,
  typeMenu,
  workflowText,
} from "../src/lib/film/routes";
import { pipelineDir, projectDir } from "../src/lib/pipeline/paths";
import { playbookRouteOf } from "../src/lib/pipeline/route";
import { bindingConflict, loadPlaybook, projectPlaybookFile, writeProjectPlaybook } from "../src/lib/playbooks/project";
import type { Playbook } from "../src/types/playbook";
import { consoleNextFields } from "../src/lib/console/next-block";
import { ProjectTitleSchema } from "../src/types/project-display";
import { writeProjectTitle } from "../src/lib/project-display";

const MEDIA = /\.(mp4|mov|m4v|webm|mkv|wav|mp3|m4a|aac)$/i;

void runScript(async () => {
  const { values: products, rest } = takeRepeated(process.argv.slice(2), "product");
  const args = parseArgs(
    [
      { name: "project", required: true, description: "Project slug" },
      { name: "title", description: "Short display name for Studio Console" },
      { name: "style", description: "Optional film style ID or exact ID@revision" },
      { name: "product", description: "Product material: one or more paths after the flag, or the flag repeated" },
      {
        name: "profile",
        description: "full (default) or promo: a film of 45 s or less whose reference numbers are advisory",
      },
      {
        name: "type",
        description: `The film's type, the first decision: ${FILM_TYPES.join(", ")}. Without it, intake asks`,
      },
      { name: "secondary", description: "A second type for a hybrid: its material and tools join the route" },
      {
        name: "playbook",
        description:
          "Bind the project to a film playbook (pipeline/playbook.json); its film type and secondary type are the defaults when --type is absent",
      },
      {
        name: "by",
        choices: ["agent", "user"] as const,
        description: "Who chose the playbook: agent (default) or user",
      },
      {
        name: "rubric",
        description: `Creative rubric version, ${RUBRIC_VERSIONS.join(" or ")} (default ${DEFAULT_RUBRIC_VERSION}); 1 keeps a benchmark comparable with runs scored on v1`,
      },
    ] as const,
    rest,
  );
  const id = args.project!;
  validateProjectId(id);
  const title = ProjectTitleSchema.optional().parse(args.title);
  const style = args.style ? selectFilmStyle(args.style) : undefined;
  const directory = projectDir(id);
  // A brief means a started project; pipeline-state.json marks an old one (legacy template mode or an earlier film:init).
  const existing = ["brief.json", "pipeline-state.json"]
    .map((file) => path.join(pipelineDir(id), file))
    .find((file) => existsSync(file));
  if (existing)
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `Pipeline exists: ${existing}. film:init does not overwrite a project.`,
    });
  for (const product of products)
    if (!existsSync(product))
      throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No product material at ${product}` });
  const profile = args.profile ?? "full";
  if (profile !== "full" && profile !== "promo")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--profile must be full or promo, not ${profile}.` });
  const typeOf = (flag: "type" | "secondary") => {
    if (args[flag] === undefined) return undefined;
    const type = filmTypeOf(args[flag]);
    if (!type)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--${flag} must be one of ${FILM_TYPES.join(", ")}, not ${args[flag]}.`,
      });
    return type;
  };
  const rubricVersion = args.rubric === undefined ? DEFAULT_RUBRIC_VERSION : Number(args.rubric);
  if (!isRubricVersion(rubricVersion))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--rubric must be ${RUBRIC_VERSIONS.join(" or ")}, not ${args.rubric}.`,
    });
  let playbook: Playbook | undefined;
  if (args.playbook !== undefined) {
    try {
      playbook = loadPlaybook(args.playbook);
    } catch (error) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--playbook: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (!playbookRouteOf(playbook, "film"))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Playbook ${playbook.id} is a ${playbook.route.kind} route with no film alternative. Start it with: ${playbook.route.start}`,
      });
  }
  const playbookRoute = playbook ? playbookRouteOf(playbook, "film") : undefined;
  const typeFromPlaybook = args.type === undefined && playbookRoute !== undefined;
  const filmType = typeOf("type") ?? playbookRoute?.filmType;
  const secondaryFilmType = typeOf("secondary") ?? (typeFromPlaybook ? playbookRoute?.secondaryFilmType : undefined);
  const standalone = [filmType, secondaryFilmType].find((type) => type && STANDALONE_TYPES.includes(type));
  if (secondaryFilmType && standalone)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `A ${standalone} film is a route of its own: drop --secondary.`,
    });
  const conflict = playbook && bindingConflict(path.resolve(directory), playbook.id);
  if (conflict)
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `${conflict} Rebind with pnpm playbook --use ${playbook!.id} --project ${id} --force.`,
    });
  const written = scaffoldFilmProject(path.resolve(directory), id, products, {
    profile,
    rubricVersion,
    ...(filmType ? { filmType } : {}),
    ...(secondaryFilmType ? { secondaryFilmType } : {}),
  });
  if (style) {
    writeFilmStyle(path.resolve(directory), style);
    written.push(filmStyleFile(path.resolve(directory)));
  }
  if (title) written.push(writeProjectTitle(path.resolve(directory), title));
  if (playbook) writeProjectPlaybook(path.resolve(directory), playbook.id, args.by === "user" ? "user" : "agent");
  const route = resolveRoute(filmType, secondaryFilmType);
  const media = products.filter((product) => MEDIA.test(product));
  const workflow =
    filmType && STANDALONE_TYPES.includes(filmType)
      ? undefined
      : filmType && routeOf(filmType).workflow
        ? routeOf(filmType).workflow
        : media.length
          ? routeOf("footage").workflow
          : undefined;
  const warnings = [
    ...(filmType ? [] : [`No --type: intake asks the user first. Types:\n${typeMenu().join("\n")}`]),
    ...(playbookRoute && !typeFromPlaybook && filmType !== playbookRoute.filmType
      ? [
          `--type ${filmType} differs from playbook ${playbook!.id}'s ${playbookRoute.filmType}: the explicit type wins.`,
        ]
      : []),
    ...(workflow
      ? [
          `${media.length ? `Supplied media (${media.join(", ")}). ` : ""}If the job is to cut what was supplied (${workflow.when}), another route fits better: ${workflowText(workflow)}. Keep this bespoke project when the film is designed, not cut.`,
        ]
      : []),
  ];
  return {
    outputs: [
      ...written.map((file) => path.relative(process.cwd(), file)),
      ...(playbook ? [path.relative(process.cwd(), projectPlaybookFile(path.resolve(directory)))] : []),
    ],
    metadata: {
      projectId: id,
      renderMode: "bespoke",
      profile,
      rubricVersion,
      filmType: route.type,
      typeChosen: filmType !== undefined,
      ...(style ? { style: filmStyleKey(style) } : {}),
      ...(playbook
        ? {
            playbook: { id: playbook.id, title: playbook.title },
            ...(typeFromPlaybook ? { typeFrom: "playbook" } : {}),
          }
        : {}),
      ...(secondaryFilmType ? { secondaryFilmType } : {}),
      steps: route.steps.map((step) => step.id),
      skipped: route.skipped,
      ...(workflow ? { workflow } : {}),
      ...(warnings.length ? { warnings } : {}),
      next: `pnpm film:next --project ${id}`,
      ...(await consoleNextFields({ rootDir: process.cwd(), project: id })),
    },
  };
});
