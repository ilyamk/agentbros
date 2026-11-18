import type { enableTailwind } from "@remotion/tailwind-v4";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from "node:fs";
import path from "node:path";
import { assertPathWithin } from "../cli";
import { generateFontRoleModule, planFontRoleContext, fontRoleModuleSource } from "./manifest";
import { readWorkflowEvidence } from "../workflows/local-evidence";
import type { ProjectVideoProps } from "../project-props";
/** Text that can actually be displayed: no paths, provider prompts or project metadata. */
type DisplayProps = Pick<ProjectVideoProps, "scenes" | "timeline"> &
  Partial<Pick<ProjectVideoProps, "projectId" | "productName" | "tagline">>;
export function displayedFontText(props: DisplayProps, rootDir = process.cwd(), projectId = props.projectId): string {
  const visible = new Set([
    "text",
    "headline",
    "subtext",
    "title",
    "label",
    "caption",
    "author",
    "handle",
    "yUnit",
    "yAxisLabel",
    "xAxisLabel",
    "value",
    "suffix",
    "prefix",
    "lines",
    "bullets",
    "quote",
    "labels",
    "name",
    "category",
    "xLabel",
    "productName",
    "tagline",
    // Additive style-pack copy and supplied bilingual translations are visible glyphs.
    "detail",
    "result",
    "action",
    "outcome",
    "statement",
    "sourceLabel",
    "interpretation",
    "translation",
  ]);
  const collect = (value: unknown, key = ""): string[] => {
    if (typeof value === "string") return visible.has(key) ? [value] : [];
    if (Array.isArray(value)) return value.flatMap((item) => collect(item, key));
    if (value && typeof value === "object") return Object.entries(value).flatMap(([name, item]) => collect(item, name));
    return [];
  };
  const text = collect({
    scenes: props.scenes,
    timeline: props.timeline,
    productName: props.productName,
    tagline: props.tagline,
  });
  for (const scene of props.scenes) {
    if (scene.template?.id === "scene.worked-example")
      text.push(scene.template.props.steps.map((_, index) => `${index + 1}.`).join(" "));
  }
  if (projectId) {
    const project = path.join(rootDir, "public/projects", projectId);
    for (const scene of props.scenes) {
      const prefix = path.join(project, "voiceover", scene.id);
      const edited = prefix + ".words.edited.json",
        raw = prefix + ".words.json";
      const file = existsSync(edited) ? edited : existsSync(raw) ? raw : undefined;
      if (file) {
        assertPathWithin(project, file);
        text.push(...collect(JSON.parse(readFileSync(file, "utf8"))));
      }
    }
  }
  return [...new Set(text)].join("\n");
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function cacheFile(directory: string, text: string, extension: string) {
  const file = path.join(directory, `${digest(text)}.${extension}`);
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") !== text) throw new Error("Font context cache collision or changed module");
  } else {
    const temporary = file + "." + randomUUID();
    writeFileSync(temporary, text, { flag: "wx" });
    try {
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return file;
}
/** Workspace-contained immutable context and generated code; no arbitrary JS input. */
export function prepareRenderFontContext(
  projectId: string,
  contextFile: string,
  props: DisplayProps,
  rootDir = process.cwd(),
) {
  const directory = path.join(rootDir, ".cache/font-contexts");
  assertPathWithin(rootDir, directory);
  mkdirSync(directory, { recursive: true });
  const temporaryModule = path.join(directory, randomUUID() + ".ts");
  try {
    const checked = generateFontRoleModule(projectId, contextFile, temporaryModule, {
      rootDir,
      requiredText: displayedFontText(props, rootDir, projectId),
    });
    const frozenContext = cacheFile(directory, JSON.stringify(checked.manifest, null, 2) + "\n", "json");
    const modulePath = cacheFile(directory, readFileSync(temporaryModule, "utf8"), "ts");
    return {
      contextFile: frozenContext,
      modulePath,
      manifest: checked.manifest,
      captureFiles: [
        ...new Set([
          frozenContext,
          modulePath,
          ...checked.captureFiles.filter((file) => file !== path.resolve(contextFile) && file !== temporaryModule),
        ]),
      ],
    };
  } finally {
    rmSync(temporaryModule, { force: true });
  }
}

/** Trusted recovery observation: requires exact already prepared cache, never writes. */
export function readRenderFontContext(
  projectId: string,
  contextFile: string,
  props: DisplayProps,
  rootDir = process.cwd(),
) {
  const root = path.resolve(rootDir),
    input = readWorkflowEvidence(path.resolve(root, contextFile), root, 8 * 1024 * 1024);
  const checked = planFontRoleContext(projectId, JSON.parse(input.text), {
    rootDir: root,
    requiredText: displayedFontText(props, root, projectId),
  });
  const contextText = JSON.stringify(checked.manifest, null, 2) + "\n",
    moduleText = fontRoleModuleSource(checked.manifest);
  const directory = path.join(root, ".cache/font-contexts");
  const frozenContext = path.join(directory, digest(contextText) + ".json"),
    modulePath = path.join(directory, digest(moduleText) + ".ts");
  const context = readWorkflowEvidence(frozenContext, root, 8 * 1024 * 1024),
    module = readWorkflowEvidence(modulePath, root, 8 * 1024 * 1024);
  if (context.text !== contextText || module.text !== moduleText)
    throw new Error("Existing font context cache changed");
  for (const consumed of [input, context, module]) {
    if (readWorkflowEvidence(consumed.path, root, 8 * 1024 * 1024).sha256 !== consumed.sha256)
      throw new Error("Existing font context changed during observation");
  }
  return {
    contextFile: frozenContext,
    modulePath,
    manifest: checked.manifest,
    captureFiles: [...new Set([frozenContext, modulePath, ...checked.captureFiles])],
  };
}
/** Controlled bundler alias targets only the production font-role module. */
export function fontContextWebpackAlias<T extends Parameters<typeof enableTailwind>[0]>(
  config: T,
  modulePath: string,
): T {
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...((config.resolve?.alias as Record<string, string>) ?? {}),
        [path.resolve("src/lib/fonts.ts")]: modulePath,
      },
    },
  } as T;
}
