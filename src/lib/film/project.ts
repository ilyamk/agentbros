import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spineFromTemplate } from "./spine";
import { REPO_ROOT, writeJsonAtomic } from "./state";
import { DEFAULT_RUBRIC_VERSION, type RubricVersion } from "./creative-rubric";
import type { FilmType } from "../../types/pipeline";

const SPINE_TEMPLATE = ".agents/skills/creative-studio/references/spine-template.md";

/** Schema-valid and deliberately empty: the intake step's done rule refuses it until the brief is filled. */
export type FilmProfile = "full" | "promo";
export type ScaffoldOptions = {
  repoRoot?: string;
  profile?: FilmProfile;
  filmType?: FilmType;
  secondaryFilmType?: FilmType;
  rubricVersion?: RubricVersion;
};
const briefStub = ({ profile = "full", filmType, secondaryFilmType }: ScaffoldOptions) => ({
  topic: "",
  audience: "",
  tone: "",
  format: "vertical",
  durationSec: 30,
  productName: "",
  references: [],
  renderMode: "bespoke",
  profile,
  ...(filmType ? { filmType } : {}),
  ...(secondaryFilmType ? { secondaryFilmType } : {}),
});

/** Files of a new bespoke project. Pipeline state is written by the caller through src/lib/pipeline/state.ts. */
export function scaffoldFilmProject(
  projectDir: string,
  projectId: string,
  products: readonly string[],
  options: ScaffoldOptions = {},
): string[] {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const pipeline = path.join(projectDir, "pipeline");
  mkdirSync(pipeline, { recursive: true });
  for (const directory of ["assets", "audio", "music"])
    mkdirSync(path.join(projectDir, directory), { recursive: true });
  const written: string[] = [];
  const write = (file: string, content: string) => {
    if (existsSync(file)) return;
    writeFileSync(file, content);
    written.push(file);
  };
  write(path.join(pipeline, "brief.json"), `${JSON.stringify(briefStub(options), null, 2)}\n`);
  write(
    path.join(pipeline, "rubric.json"),
    `${JSON.stringify({ schemaVersion: 1, rubricVersion: options.rubricVersion ?? DEFAULT_RUBRIC_VERSION }, null, 2)}\n`,
  );
  write(
    path.join(pipeline, "spine.md"),
    spineFromTemplate(readFileSync(path.join(repoRoot, SPINE_TEMPLATE), "utf8"), projectId),
  );
  if (products.length) {
    const sources = path.join(pipeline, "product-sources.json");
    writeJsonAtomic(sources, { schemaVersion: 1, paths: [...products] });
    written.push(sources);
  }
  return written;
}
