import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import { SyntaxKind as K, type Node, type SourceFile } from "typescript/unstable/ast";
import { CliErrorObject } from "../cli";
import { hasEmoji, isSlopGradient } from "../sensors/slop-signatures";

export interface LintFinding {
  code: string;
  file: string;
  line: number;
  column: number;
  message: string;
}
const banned = /^(?:gsap|framer-motion|motion(?:\/|$)|animejs|anime\.js|(?:@react-spring\/|react-spring))/;
/** Bare `gsap` is allowed only in this wrapper; everything else imports GSAP from it or from `@remotion/gsap`. */
export const GSAP_WRAPPER = "src/motion/gsap.ts";
const gsapModule = /^gsap(?:\/|$)/;
/** Plugins that need scroll, pointer or the wall clock; banned everywhere, the wrapper included. */
const gsapInteractive =
  /^gsap\/(?:all|ScrollTrigger|ScrollSmoother|ScrollToPlugin|Observer|Draggable|InertiaPlugin|ScrambleTextPlugin|Physics2DPlugin|PhysicsPropsPlugin|GSDevTools)(?:\.js)?$/;
function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
/** Remotion media components (and the native tags) whose src must come from staticFile() for public/ files. */
const MEDIA_TAGS =
  /^(?:Img|Video|Audio|OffthreadVideo|Html5Video|Html5Audio|AnimatedImage|Gif|IFrame|img|video|audio|iframe)$/;
/** A public/ file named as a bare path: "projects/...", "/shared/...", "public/...". */
const STATIC_PATH = /^\/?(?:public|projects|shared)\//;
const CLASS_LITERAL_KINDS = new Set([
  K.StringLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.TemplateHead,
  K.TemplateMiddle,
  K.TemplateTail,
]);
/** Contextual AST checks, deliberately scoped to renderer components and production entry points. */
export function inspectSource(source: SourceFile, file: string, render: boolean, cli: boolean): LintFinding[] {
  const findings: LintFinding[] = [];
  const text = (node: Node) => node.getText(source);
  const add = (node: Node, code: string, message: string) => {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ code, file, line: location.line + 1, column: location.character + 1, message });
  };
  const children = (node: Node) => {
    const result: Node[] = [];
    node.forEachChild((child) => {
      result.push(child);
    });
    return result;
  };
  const initializers = new Map<string, Node>();
  walk(source, (node) => {
    if (node.kind === K.VariableDeclaration) {
      const parts = children(node);
      const name = parts[0];
      const initializer = parts.at(-1);
      if (name?.kind === K.Identifier && initializer && initializer !== name) initializers.set(text(name), initializer);
    }
  });
  const walkResolved = (node: Node, visit: (node: Node) => void) => {
    const seen = new Set<Node>();
    const resolve = (value: Node) => {
      if (seen.has(value)) return;
      seen.add(value);
      visit(value);
      if (value.kind === K.Identifier) {
        const initializer = initializers.get(text(value));
        if (initializer) resolve(initializer);
      }
      value.forEachChild((child) => {
        resolve(child);
      });
    };
    resolve(node);
  };
  /** A literal media value, directly or through a local constant; a call such as staticFile(...) is not a bare literal. */
  const bareLiteral = (value: Node): Node | undefined => {
    let current: Node | undefined = value;
    for (let depth = 0; current && depth < 4; depth++) {
      if (current.kind === K.JsxExpression || current.kind === K.ParenthesizedExpression) {
        current = children(current).find(
          (child) => child.kind !== K.OpenBraceToken && child.kind !== K.CloseBraceToken,
        );
        continue;
      }
      if (current.kind === K.StringLiteral || current.kind === K.NoSubstitutionTemplateLiteral) return current;
      if (current.kind === K.TemplateExpression) return children(current)[0];
      if (current.kind === K.Identifier) {
        current = initializers.get(text(current));
        continue;
      }
      return undefined;
    }
    return undefined;
  };
  const literalTexts = (value: Node): string[] => {
    const found: string[] = [];
    walkResolved(value, (literal) => {
      if (CLASS_LITERAL_KINDS.has(literal.kind)) found.push(text(literal));
    });
    return found;
  };
  const execAliases = new Set<string>();
  const childNamespaces = new Set<string>();
  const frameAliases = new Set<string>();
  const frameNamespaces = new Set<string>();
  walk(source, (node) => {
    if (node.kind !== K.ImportDeclaration) return;
    const parts = children(node);
    const module = parts.find((part) => part.kind === K.StringLiteral);
    const moduleName = module ? text(module).slice(1, -1) : "";
    if (render && gsapInteractive.test(moduleName))
      add(
        node,
        "GSAP_PLUGIN",
        "This GSAP plugin needs scroll, pointer, the wall clock or Math.random; it cannot render deterministically.",
      );
    else if (render && banned.test(moduleName) && !(gsapModule.test(moduleName) && file === GSAP_WRAPPER))
      add(
        node,
        "ANIMATION_LIBRARY",
        gsapModule.test(moduleName)
          ? `Import GSAP from ${GSAP_WRAPPER} or @remotion/gsap.`
          : "Use frame-driven Remotion animation APIs.",
      );
    walk(node, (spec) => {
      if (spec.kind === K.ImportSpecifier) {
        const names = children(spec).map(text);
        const imported = names[0];
        const local = names.at(-1)!;
        if (/^(?:node:)?child_process$/.test(moduleName)) execAliases.add(`${local}:${imported}`);
        if (
          (moduleName === "@react-three/fiber" && imported === "useFrame") ||
          (/^(?:node:)?timers$/.test(moduleName) && ["setTimeout", "setInterval"].includes(imported))
        )
          frameAliases.add(local);
      }
      if (spec.kind === K.NamespaceImport && /^(?:node:)?child_process$/.test(moduleName))
        childNamespaces.add(children(spec).map(text).at(-1)!);
      if (spec.kind === K.ImportClause && /^(?:node:)?child_process$/.test(moduleName)) {
        const name = children(spec).find((part) => part.kind === K.Identifier);
        if (name) childNamespaces.add(text(name));
      }
      if (spec.kind === K.NamespaceImport && moduleName === "@react-three/fiber")
        frameNamespaces.add(children(spec).map(text).at(-1)!);
    });
  });
  /** Tailwind classes that run on the browser clock; `*-none` turns them off and is allowed. */
  const checkedLiterals = new Set<Node>();
  const checkClasses = (value: Node) =>
    walkResolved(value, (literal) => {
      if (!CLASS_LITERAL_KINDS.has(literal.kind) || checkedLiterals.has(literal)) return;
      checkedLiterals.add(literal);
      for (const token of text(literal).split(/[\s`'"]+|\$\{|\}/)) {
        const utility = token.replace(/^(?:[^:\s]+:)*!?/, "");
        if (!utility || /-none$/.test(utility)) continue;
        if (/^animate-[\w[\]().,%-]+$/.test(utility))
          add(literal, "TAILWIND_ANIMATION", `Tailwind ${utility} is not deterministic per rendered frame.`);
        else if (/^(?:transition(?:-[\w[\]().,%-]+)?|duration-[\w[\]().,%-]+)$/.test(utility))
          add(
            literal,
            "TAILWIND_TRANSITION",
            `Tailwind ${utility} animates on the browser clock; compute the value from the frame.`,
          );
      }
    });
  walk(source, (node) => {
    const raw = text(node);
    if (render && (node.kind === K.JsxOpeningElement || node.kind === K.JsxSelfClosingElement)) {
      const tag = children(node)[0];
      if (tag && /^(img|video|audio)$/.test(text(tag)))
        add(tag, "NATIVE_MEDIA", "Use Remotion Img or @remotion/media Video/Audio.");
    }
    if (render && node.kind === K.JsxAttribute) {
      const [name, value] = children(node);
      if (name && value && text(name) === "className") checkClasses(value);
      if (name && value && text(name) === "style")
        walkResolved(value, (property) => {
          if (property.kind !== K.PropertyAssignment) return;
          const [key] = children(property);
          if (
            key &&
            /^(?:["']?)(animation(?:Name|Duration|Delay|TimingFunction|IterationCount)?|transition(?:Property|Duration|Delay|TimingFunction)?)(?:["']?)$/.test(
              text(key),
            )
          )
            add(property, "CSS_ANIMATION", "Compute style values from the current Remotion frame.");
        });
    }
    if (render && node.kind === K.CallExpression) {
      const callee = children(node)[0];
      const name = callee ? text(callee).replace(/\s+/g, "") : "";
      if (
        /^(?:(?:window|globalThis)\.)?(requestAnimationFrame|setTimeout|setInterval)$/.test(name) ||
        frameAliases.has(name) ||
        [...frameNamespaces].some((prefix) => name === `${prefix}.useFrame`)
      )
        add(node, "WALL_CLOCK_ANIMATION", "Render animation must use useCurrentFrame, interpolate or spring.");
      if (/^(?:(?:window|globalThis)\.)?Math\.random$/.test(name))
        add(node, "UNSEEDED_RANDOM", "Use random(seed) from remotion so every render of a frame is identical.");
      if (/^(?:(?:window|globalThis)\.)?(?:Date\.now|performance\.now)$/.test(name))
        add(node, "WALL_CLOCK_VALUE", "Rendered values must derive from the frame, not the wall clock.");
      if (/^(?:cn|clsx|classnames|classNames|twMerge|twJoin|cva)$/.test(name))
        for (const argument of children(node).slice(1)) checkClasses(argument);
    }
    if (render && node.kind === K.NewExpression && /^new\s+(?:(?:window|globalThis)\.)?Date\s*(?:\(\s*\))?$/.test(raw))
      add(node, "WALL_CLOCK_VALUE", "new Date() reads the wall clock; derive rendered values from the frame.");
    if (cli && node.kind === K.CallExpression) {
      const callee = children(node)[0];
      const name = callee ? text(callee) : "";
      const imported = [...execAliases].find((entry) => entry.split(":")[0] === name)?.split(":")[1];
      const namespace = [...childNamespaces].find((prefix) => name.startsWith(`${prefix}.`));
      const operation = imported ?? (namespace ? name.slice(namespace.length + 1) : undefined);
      if (operation === "exec" || operation === "execSync")
        add(node, "SHELL_COMMAND", "Use execFile/spawn with literal argument arrays instead of a shell command.");
      if (operation && /^(spawn|spawnSync|execFile|execFileSync)$/.test(operation))
        walkResolved(node, (property) => {
          if (property.kind !== K.PropertyAssignment) return;
          const [key, value] = children(property);
          if (key && value && /^['"]?shell['"]?$/.test(text(key)) && text(value) !== "false")
            add(property, "SHELL_ENABLED", "Subprocess shell must remain disabled.");
        });
    }
    // Only active JSX stylesheet text is checked; comments and documentation strings are not animation.
    if (
      render &&
      node.kind === K.JsxElement &&
      /^<style(?:\s|>)/.test(raw) &&
      /@keyframes|(?:animation|transition)\s*:/.test(raw)
    )
      add(node, "CSS_STYLESHEET_ANIMATION", "Remove wall-clock CSS from rendered components.");
    if (render && (node.kind === K.JsxOpeningElement || node.kind === K.JsxSelfClosingElement)) {
      const [tag, ...rest] = children(node);
      if (tag && MEDIA_TAGS.test(text(tag)))
        for (const attributes of rest)
          attributes.forEachChild((attribute) => {
            if (attribute.kind !== K.JsxAttribute) return;
            const [name, value] = children(attribute);
            if (!name || !value || text(name) !== "src") return;
            const literal = bareLiteral(value);
            if (literal && STATIC_PATH.test(text(literal).replace(/^[`'"]/, "")))
              add(
                attribute,
                "STATIC_PATH",
                `src ${text(literal).slice(0, 80)} is a public/ path without staticFile(); it breaks once the bundle is served from another base.`,
              );
          });
    }
    if (render && node.kind === K.PropertyAssignment) {
      const [key, value] = children(node);
      if (
        key &&
        value &&
        /^["']?(?:backgroundImage|background|background-image)["']?$/.test(text(key)) &&
        literalTexts(value).some((value) => /url\(/i.test(value))
      )
        add(
          node,
          "CSS_BG_IMAGE",
          "CSS background-image url() is not awaited by the renderer, so frames can render before it loads.",
        );
    }
    if (
      render &&
      node.kind === K.JsxElement &&
      /^<style(?:\s|>)/.test(raw) &&
      /background(?:-image)?\s*:[^;{}]*url\(/i.test(raw)
    )
      add(node, "CSS_BG_IMAGE", "CSS background-image url() in a stylesheet is not awaited by the renderer.");
  });
  return findings;
}
const LITERAL_KINDS = new Set([
  K.StringLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.TemplateHead,
  K.TemplateMiddle,
  K.TemplateTail,
  K.JsxText,
]);
/** Advisory slop signatures in a project's literals (design-reference/slop-catalogue.md): emoji, and gradients inside the purple-blue band. */
export function inspectSlop(source: SourceFile, file: string): LintFinding[] {
  const findings: LintFinding[] = [];
  walk(source, (node) => {
    if (!LITERAL_KINDS.has(node.kind)) return;
    const value = node.getText(source);
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    const add = (code: string, message: string) =>
      findings.push({ code, file, line: location.line + 1, column: location.character + 1, message });
    if (hasEmoji(value))
      add(
        "SLOP_EMOJI",
        "Emoji in a literal: on screen they read as a template. Use a word or an icon from the film's own system.",
      );
    for (const match of value.matchAll(/(?:linear|radial)-gradient\([^;'"`]*\)/gi))
      if (isSlopGradient(match[0]))
        add(
          "SLOP_GRADIENT",
          `Purple-blue gradient ${match[0].slice(0, 80)}: take the palette from the brand or the reference.`,
        );
  });
  return findings;
}
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
/** The exact fix for each rule, appended by formatFinding. */
export const LINT_FIXES: Record<string, string> = {
  GSAP_PLUGIN: "drop the plugin; drive the effect from the frame, or from a paused timeline through useGsapTimeline",
  ANIMATION_LIBRARY: `animate with interpolate()/spring() from remotion, or GSAP through useGsapTimeline and ${GSAP_WRAPPER}`,
  NATIVE_MEDIA: "use <Img src={staticFile(…)}> from remotion, or <Video>/<Audio> from @remotion/media",
  TAILWIND_ANIMATION: "remove the animate-* class and set the value per frame with interpolate()",
  TAILWIND_TRANSITION: "remove the transition/duration class and set the value per frame with interpolate()",
  CSS_ANIMATION: "remove the animation/transition style and compute the value from useCurrentFrame()",
  CSS_STYLESHEET_ANIMATION:
    "remove @keyframes, animation and transition from the <style> and compute the value from useCurrentFrame()",
  WALL_CLOCK_ANIMATION:
    "derive the value from useCurrentFrame() with interpolate() or spring(); no timers, requestAnimationFrame or useFrame()",
  UNSEEDED_RANDOM: "use random('a-seed') from remotion",
  WALL_CLOCK_VALUE: "derive the value from useCurrentFrame(), or pass a fixed date as a prop",
  STATIC_PATH: 'wrap the path: <Img src={staticFile("projects/<id>/…")}> (no leading slash, no public/ prefix)',
  CSS_BG_IMAGE:
    'render the picture as <Img src={staticFile(…)} style={{objectFit: "cover"}}> inside an AbsoluteFill; gradients without url() may stay',
  SHELL_COMMAND: "use execFile/spawn with a literal argument array",
  SHELL_ENABLED: "remove shell: true",
};
/** `file:line CODE: message. Fix: …`, the line a done check prints. */
export const formatFinding = (finding: LintFinding) =>
  `${finding.file}:${finding.line} ${finding.code}: ${finding.message.replace(/\.$/, "")}.${LINT_FIXES[finding.code] ? ` Fix: ${LINT_FIXES[finding.code]}.` : ""}`;
/** The TypeScript sources under src/projects/<id>, bounded; throws on a bad id or a missing directory. */
function projectSources(root: string, projectId: string): string[] {
  if (!PROJECT_ID.test(projectId) || projectId.includes(".."))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Not a project id: ${projectId}` });
  const directory = path.join(root, "src/projects", projectId);
  if (!existsSync(directory))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `No project code at src/projects/${projectId}.` });
  const files: string[] = [];
  const collect = (current: string, depth = 0) => {
    if (depth > 20) throw new CliErrorObject({ code: "VALIDATION", message: "Lint directory depth exceeds 20." });
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) collect(file, depth + 1);
      else if (
        /\.(?:ts|tsx)$/.test(file) &&
        !/\.d\.ts$/.test(file) &&
        files.length < 2000 &&
        statSync(file).size <= 2 * 1024 * 1024
      )
        files.push(file);
    }
  };
  collect(directory);
  return files;
}
/** src/projects/<id> (git-ignored bespoke film code): render-rule findings fail, slop signatures stay advisory warnings. */
export function lintProjectCode(
  rootDir: string,
  projectId: string,
): { filesScanned: number; findings: LintFinding[]; warnings: LintFinding[] } {
  const root = path.resolve(rootDir);
  const files = projectSources(root, projectId);
  if (!files.length) return { filesScanned: 0, findings: [], warnings: [] };
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    const findings: LintFinding[] = [];
    const warnings: LintFinding[] = [];
    for (const file of files) {
      const source = snapshot
        .getProjects()
        .map((project) => project.program.getSourceFile(file))
        .find(Boolean);
      if (!source) throw new CliErrorObject({ code: "INTERNAL", message: `TypeScript AST unavailable: ${file}` });
      const relative = path.relative(root, file).split(path.sep).join("/");
      findings.push(...inspectSource(source, relative, true, false));
      warnings.push(...inspectSlop(source, relative));
    }
    return { filesScanned: files.length, findings, warnings };
  } finally {
    api.close();
  }
}
/** Advisory scan of src/projects/<id>: slop warnings only, never a failure. */
export function lintProjectSlop(rootDir: string, projectId: string): { filesScanned: number; warnings: LintFinding[] } {
  const { filesScanned, warnings } = lintProjectCode(rootDir, projectId);
  return { filesScanned, warnings };
}
/** A guard against a runaway tree, not a budget: the repository holds about 1,400 sources. */
export const LINT_MAX_FILES = 10_000;
/** Rendered code: the determinism rules apply. Everything else gets the CLI rules only. */
const RENDER_ROOTS = ["src/components/", "src/templates/", "src/motion/", "src/compositions/"];
const RENDER_FILES = new Set(["src/Root.tsx", "src/index.ts"]);
export const isRenderSource = (relative: string) =>
  RENDER_FILES.has(relative) || RENDER_ROOTS.some((prefix) => relative.startsWith(prefix));
export function lintProject(rootDir = process.cwd()): { filesScanned: number; findings: LintFinding[] } {
  const root = path.resolve(rootDir);
  const files: string[] = [];
  const addFile = (file: string) => {
    if (files.length >= LINT_MAX_FILES)
      throw new CliErrorObject({ code: "VALIDATION", message: `Lint input exceeds ${LINT_MAX_FILES} files.` });
    if (statSync(file).size > 2 * 1024 * 1024)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Lint source exceeds 2 MiB: ${path.relative(root, file)}`,
      });
    files.push(file);
  };
  const collect = (directory: string, depth = 0) => {
    if (depth > 20) throw new CliErrorObject({ code: "VALIDATION", message: "Lint directory depth exceeds 20." });
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new CliErrorObject({ code: "VALIDATION", message: `Symlink in lint source tree: ${entry.name}` });
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file, depth + 1);
      else if (/\.(?:ts|tsx)$/.test(file)) addFile(file);
    }
  };
  // Required trees fail loudly when missing; optional ones (absent in small fixtures or not yet created) are skipped.
  const optional = new Set(["src/motion", "src/compositions", "src/types"]);
  for (const directory of [
    "src/components",
    "src/templates",
    "src/motion",
    "src/compositions",
    "src/types",
    "src/lib",
    "src/mcp",
    "scripts",
  ]) {
    const absolute = path.join(root, directory);
    if (!optional.has(directory) || existsSync(absolute)) collect(absolute);
  }
  for (const file of RENDER_FILES) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) continue;
    if (lstatSync(absolute).isSymbolicLink())
      throw new CliErrorObject({ code: "VALIDATION", message: `Symlink in lint source tree: ${file}` });
    addFile(absolute);
  }
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    const findings: LintFinding[] = [];
    for (const file of files) {
      const source = snapshot
        .getProjects()
        .map((project) => project.program.getSourceFile(file))
        .find(Boolean);
      if (!source) throw new CliErrorObject({ code: "INTERNAL", message: `TypeScript AST unavailable: ${file}` });
      const relative = path.relative(root, file).split(path.sep).join("/");
      findings.push(...inspectSource(source, relative, isRenderSource(relative), true));
    }
    return { filesScanned: files.length, findings };
  } finally {
    api.close();
  }
}
