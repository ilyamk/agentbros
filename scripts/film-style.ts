import { existsSync } from "node:fs";
import path from "node:path";
import { runScript, parseArgs, CliErrorObject } from "../src/lib/cli";
import { projectDirectory } from "../src/lib/campaigns/production/files";
import { bindFilmStyle, filmStyleFile, readFilmStyle } from "../src/lib/film-styles/binding";
import { filmStyleKey, readFilmStyles, selectFilmStyle } from "../src/lib/film-styles/catalogue";
import { readProjectPlaybook } from "../src/lib/playbooks/project";

void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      choices: ["list", "show", "use", "status"],
      default: "list",
      description: "Discover or pin a film style",
    },
    { name: "style", description: "Style ID or exact ID@revision" },
    { name: "project", description: "Existing bespoke film project ID" },
    { name: "playbook", description: "Filter suggestions for this playbook" },
  ] as const);
  const directory = args.project ? projectDirectory(process.cwd(), args.project) : undefined;
  const playbook = args.playbook ?? (directory ? readProjectPlaybook(directory)?.id : undefined);
  const invalid = (message: string): never => {
    throw new CliErrorObject({ code: "INVALID_INPUT", message });
  };
  if (args.action === "list") {
    const cards = readFilmStyles();
    return {
      metadata: {
        styles: cards
          .filter((card) => !playbook || card.playbooks.includes(playbook))
          .map(({ id, revision, title, summary, playbooks }) => ({
            key: filmStyleKey({ id, revision }),
            title,
            summary,
            playbooks,
          })),
      },
    };
  }
  if (args.action === "show") return { metadata: { style: selectFilmStyle(args.style ?? invalid("Pass --style")) } };
  const project = directory ?? invalid("Pass --project");
  if (!existsSync(project)) invalid("The project does not exist");
  if (args.action === "status") return { metadata: { selection: readFilmStyle(project) ?? null } };
  if (!existsSync(path.join(project, "pipeline/brief.json")) || existsSync(path.join(project, "project.json")))
    invalid("Use this command for a bespoke film, or choose styleCard in the recipe request.");
  const selection = bindFilmStyle(project, selectFilmStyle(args.style ?? invalid("Pass --style")));
  return { outputs: [filmStyleFile(project)], metadata: { selection: filmStyleKey(selection.style) } };
});
