/** Prints a film type's route: steps, agents, inputs, outputs and tools. Reads only, unless --write-doc. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import { FILM_TYPES, filmTypeOf, resolveRoute, routeDocs } from "../src/lib/film/routes";
import { baseTokens, filmTypes } from "../src/lib/film/state";

const FILM_TYPES_DOC = "docs/film-types.md";

void runScript(async () => {
  const args = parseArgs([
    { name: "type", description: `One of ${FILM_TYPES.join(", ")}; default the project's brief.filmType` },
    { name: "secondary", description: "A second type for a hybrid" },
    { name: "project", description: "Project ID: reads its brief's filmType and secondaryFilmType" },
    {
      name: "write-doc",
      type: "boolean",
      description: `Regenerate ${FILM_TYPES_DOC} and docs/film-types/<type>.md from the route table`,
    },
  ] as const);
  if (args["write-doc"]) {
    const docs = routeDocs();
    for (const [doc, text] of Object.entries(docs)) {
      mkdirSync(path.dirname(path.resolve(doc)), { recursive: true });
      writeFileSync(path.resolve(doc), text);
    }
    return { outputs: Object.keys(docs), metadata: { written: FILM_TYPES_DOC, pages: Object.keys(docs) } };
  }
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
  let type = typeOf("type");
  let secondary = typeOf("secondary");
  if (args.project) {
    const project = openExistingFilm(args.project);
    const fromBrief = filmTypes(project, baseTokens(project));
    type ??= fromBrief.type;
    secondary ??= fromBrief.secondary;
  }
  if (!type && !args.project)
    return { metadata: { types: FILM_TYPES, routes: FILM_TYPES.map((name) => resolveRoute(name)) } };
  return { metadata: { route: resolveRoute(type, secondary) } };
});
