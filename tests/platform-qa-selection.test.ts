import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { parse } from "acorn";
import { NoReactInternals } from "remotion/no-react";
import { ProjectVideoSchema } from "../src/lib/project-props";
import { freezeRenderData, renderBoundary } from "../src/lib/timeline-ir/render";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { compileTimeline } from "../src/lib/timeline";
import { AbsolutePhase, HarnessFaults } from "./helpers/platform-handoff-lifecycle";
import { selectQaComposition, type QaSelectedComposition } from "./helpers/platform-qa-selection";

const require = createRequire(import.meta.url);
const { transformSync } = createRequire(require.resolve("tsx/package.json"))("esbuild") as {
  transformSync: (text: string, options: Record<string, unknown>) => { code: string };
};
const renderer = path.dirname(require.resolve("@remotion/renderer/package.json"));
const bundler = path.dirname(require.resolve("@remotion/bundler/package.json"));
const studio = fs.realpathSync(path.join(bundler, "..", "studio"));
const remotion = path.dirname(require.resolve("remotion/package.json"));
type AstNode = { type: string; start: number; end: number; [key: string]: any };
function parsed(file: string) {
  const raw = fs.readFileSync(file, "utf8");
  const text = file.endsWith(".tsx")
    ? transformSync(raw, { loader: "tsx", format: "esm", jsx: "transform", target: "es2022" }).code
    : raw;
  return { text, ast: parse(text, { ecmaVersion: 2022, sourceType: "module" }) };
}
function walk(node: any, visit: (node: AstNode) => void) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (value && typeof value === "object") walk(value, visit);
  }
}
function initializer(file: string, name: string) {
  const source = parsed(file);
  const found: AstNode[] = [];
  walk(source.ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.name === name && node.init)
      found.push(node.init);
  });
  assert.equal(found.length, 1, `Exact installed/production consumer ${name}`);
  return source.text.slice(found[0]!.start, found[0]!.end);
}
function evaluate(expression: string, bindings: Record<string, unknown>) {
  return vm.runInNewContext(`(${expression})`, bindings, { timeout: 1000 });
}
const metadata = evaluate(initializer("src/components/GenericProject.tsx", "calculateProjectMetadata"), {
  ProjectVideoSchema,
  freezeRenderData,
  compileTimelineIR,
  renderBoundary,
  compileTimeline,
});
const props = ProjectVideoSchema.parse({
  projectId: "cpu-only",
  format: "landscape",
  productName: "CPU DATA",
  tagline: "",
  accentColor: "#112233",
  bgColor: "#ffffff",
  textColor: "#000000",
  voiceoverEnabled: false,
  musicVolume: 0,
  scenes: [{ id: "title", text: "", headline: "CPU DATA", visualType: "title", durationInFrames: 90 }],
});
const selected = (input: Record<string, unknown>): QaSelectedComposition => ({
  id: "ProjectLandscape",
  width: 1920,
  height: 1080,
  fps: 30,
  ...metadata({ props: input }),
});

/** Exact installed public consumer; only its internal browser boundary is captured, never invoked. */
function consumedStill(composition: QaSelectedComposition, inputProps: Record<string, unknown>) {
  let captured: any, bundleState: any, markup: any;
  const publicStill = evaluate(initializer(path.join(renderer, "dist/render-still.js"), "renderStill"), {
    exports: {
      internalRenderStill: (options: unknown) => {
        captured = options;
        return options;
      },
    },
    no_react_1: { NoReactInternals },
    logger_1: {
      Log: {
        warn: () => {
          throw Error("Unexpected warning branch");
        },
      },
    },
    image_format_1: { DEFAULT_STILL_IMAGE_FORMAT: "png" },
    jpeg_quality_1: { DEFAULT_JPEG_QUALITY: 80 },
    overwrite_1: { DEFAULT_OVERWRITE: true },
    TimeoutSettings_1: { DEFAULT_TIMEOUT: 30000 },
    browser_download_progress_bar_1: {
      defaultBrowserDownloadProgress: () => {
        throw Error("No browser download");
      },
    },
    licensing_1: {
      LicensingInternals: {
        getUsageRecorder: () => () => {
          throw Error("No licensing execution");
        },
      },
    },
    default_on_log_1: {
      defaultOnLog: () => {
        throw Error("No renderer logs");
      },
    },
  });
  publicStill({
    composition,
    inputProps,
    imageFormat: "png",
    logLevel: "error",
    onBrowserDownload: () => {
      throw Error("No browser");
    },
  });
  assert.ok(captured, "Real public serialization reached capture boundary");
  const source = parsed(path.join(renderer, "dist/render-still.js"));
  const callbacks: AstNode[] = [];
  walk(source.ast, (node) => {
    if (
      node.type === "Property" &&
      node.key.name === "pageFunction" &&
      source.text.slice(node.value.start, node.value.end).includes("serializedResolvedPropsWithSchema: props")
    )
      callbacks.push(node.value);
  });
  assert.equal(callbacks.length, 1, "Exact setBundleMode consumer");
  const setMode = evaluate(source.text.slice(callbacks[0]!.start, callbacks[0]!.end), {
    window: {
      remotion_setBundleMode: (value: unknown) => {
        bundleState = value;
      },
    },
  });
  setMode(
    composition.id,
    captured.serializedResolvedPropsWithCustomSchema,
    composition.durationInFrames,
    composition.fps,
    composition.height,
    composition.width,
  );
  const jsx = (type: unknown, values: unknown) => ({ type, props: values });
  const renderContent = evaluate(initializer(path.join(studio, "dist/renderEntry.js"), "renderContent"), {
    getBundleMode: () => bundleState,
    no_react_1: { NoReactInternals },
    jsx_runtime_1: { jsx, jsxs: jsx },
    CompositionRootContexts: "Contexts",
    remotion_1: {
      Internals: {
        CompositionManagerProvider: "Manager",
        RemotionRootContexts: "Contexts",
        RenderAssetManagerProvider: "Assets",
      },
    },
    window: { remotion_logLevel: "error" },
    renderToDOM: (value: unknown) => {
      markup = value;
    },
    GetVideoComposition: "GetVideo",
  });
  renderContent("Root");
  assert.ok(markup, "Real renderContent supplied metadata provider");
  const manager = {
    compositions: [{ id: composition.id, defaultProps: {} }],
    canvasContent: { type: "composition", compositionId: composition.id },
    currentCompositionMetadata: markup.props.currentCompositionMetadata,
  };
  const resolved = evaluate(
    initializer(path.join(remotion, "dist/cjs/ResolveCompositionConfig.js"), "useResolvedVideoConfig"),
    {
      exports: { ResolveCompositionContext: "Resolve" },
      EditorProps_js_1: { EditorPropsContext: "Editor" },
      CompositionManagerContext_js_1: { CompositionManager: "Manager" },
      react_1: {
        useContext: (name: string) => (name === "Manager" ? manager : name === "Editor" ? { props: {} } : {}),
        useMemo: (action: () => unknown) => action(),
      },
      use_remotion_environment_js_1: { useRemotionEnvironment: () => ({ isRendering: true }) },
    },
  )(composition.id);
  assert.equal(resolved.type, "success");
  const createElement = (type: unknown, values: unknown, ...children: unknown[]) => ({ type, props: values, children });
  const generic = evaluate(initializer("src/components/GenericProject.tsx", "GenericProject"), {
    React: { createElement, Fragment: "Fragment" },
    TimelineComposition: "Timeline",
    TalkingHeadComposition: "TalkingHead",
    PromoVideo: "Promo",
    QAEvidenceProbe: "Probe",
    Audio: "Audio",
    staticFile: () => {
      throw Error("Unexpected audio branch");
    },
  });
  const element = generic(resolved.result.props);
  return {
    input: NoReactInternals.deserializeJSONWithSpecialTypes(captured.serializedInputPropsWithCustomSchema),
    rendered: resolved.result.props,
    probeMounted: element.children.some((child: any) => child?.type === "Probe"),
  };
}

test("exact installed public/metadata/Generic consumers discard late input flag from old resolved props", () => {
  const movie = selected(props),
    consumed = consumedStill(movie, { ...props, qaEvidence: true });
  assert.equal(consumed.input.qaEvidence, true);
  assert.equal(consumed.rendered.qaEvidence, undefined);
  assert.equal(consumed.probeMounted, false);
});
test("shared actual QA selection resolves opt-in before still and preserves movie canonical props and geometry", async () => {
  const movie = selected(props),
    phase = new AbsolutePhase(Date.now() + 1000, () => {}, new HarnessFaults());
  let selects = 0;
  try {
    const qa = await selectQaComposition(phase, props, movie, async (input) => {
      selects++;
      assert.equal(input.qaEvidence, true);
      return selected(input);
    });
    const consumed = consumedStill(qa.qaComposition, qa.qaProps);
    assert.equal(selects, 1);
    assert.equal(consumed.rendered.qaEvidence, true);
    assert.equal(consumed.probeMounted, true);
    assert.equal(movie.props.qaEvidence, undefined);
    assert.equal(qa.qaComposition.durationInFrames, movie.durationInFrames);
  } finally {
    phase.dispose();
  }
});
for (const drift of ["flag", "geometry", "copy"])
  test(`QA selection rejects ${drift} drift instead of overriding resolved props`, async () => {
    const movie = selected(props),
      phase = new AbsolutePhase(Date.now() + 1000, () => {}, new HarnessFaults());
    try {
      await assert.rejects(
        selectQaComposition(phase, props, movie, async (input) => {
          const qa = selected(input);
          return drift === "flag"
            ? { ...qa, props: movie.props }
            : drift === "geometry"
              ? { ...qa, width: 480 }
              : { ...qa, props: { ...qa.props, productName: "changed" } };
        }),
        /QA|Non-QA/,
      );
    } finally {
      phase.dispose();
    }
  });
