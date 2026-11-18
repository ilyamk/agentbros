import { digest } from "../jobs/model-artifacts";
import { validateCompositionInstances, type InstanceGraphInput } from "./native-composition-instances";
import { STATIC_TREE_LIMITS, staticTreeSourceName } from "./native-composition-tree";
export interface InstanceDomNode {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  css: Record<string, string>;
  children: InstanceDomNode[];
}
export interface ExtractedInstanceDocument {
  record: Omit<InstanceGraphInput["root"], "html">;
  root: InstanceDomNode;
}
/** Inert DOM semantic extraction only. No claim about raw attribute spelling/duplicates. */
export function extractInstanceDocument(
  document: Document,
  sourceName: string,
  assetNames: string[],
): ExtractedInstanceDocument {
  const fail = (message: string): never => {
    throw Error("Instance inert DOM: " + message);
  };
  const allowedTags = new Set(["HTML", "HEAD", "BODY", "DIV", "SPAN", "P", "SCRIPT", "AUDIO", "VIDEO"]);
  const allowedAttributes = new Set([
    "id",
    "style",
    "data-composition-id",
    "data-composition-src",
    "data-start",
    "data-duration",
    "data-media-start",
    "data-width",
    "data-height",
    "data-fps",
    "src",
    "muted",
    "data-volume",
    "data-playback-rate",
  ]);
  const elements = [...document.querySelectorAll("*")];
  if (elements.length > 512) fail("element count bound");
  const roots = elements.filter(
    (e) => e.hasAttribute("data-composition-id") && !e.hasAttribute("data-composition-src"),
  );
  if (roots.length !== 1) fail("exactly one composition root required");
  const root = roots[0];
  if (root.tagName !== "DIV" || root.parentElement !== document.body || document.body.children.length !== 1)
    fail("root must be only body element");
  if (root.getAttribute("data-start") !== "0") fail("explicit root data-start=0 required");
  if (root.hasAttribute("data-media-start") && root.getAttribute("data-media-start") !== "0")
    fail("root media origin unsupported");
  if (root.hasAttribute("data-end") || root.id !== root.getAttribute("data-composition-id"))
    fail("root identity/end unsupported");
  const wrappers = [document.documentElement, document.head, document.body];
  if (
    wrappers.some(
      (element, index) =>
        !element ||
        element.tagName !== ["HTML", "HEAD", "BODY"][index] ||
        element.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
        element.attributes.length ||
        [...element.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? "").trim()),
    ) ||
    document.documentElement.parentElement !== null ||
    document.head.parentElement !== document.documentElement ||
    document.body.parentElement !== document.documentElement ||
    document.documentElement.children.length !== 2 ||
    document.documentElement.children[0] !== document.head ||
    document.documentElement.children[1] !== document.body ||
    document.head.children.length
  )
    fail("unsupported document wrapper");
  const scriptElements = elements.filter((e) => e.tagName === "SCRIPT");
  if (scriptElements.length !== 1 || scriptElements[0].parentElement !== root || scriptElements[0].attributes.length)
    fail("one direct inline classic root script required");
  const scripts = scriptElements[0].textContent ?? "";
  if (new TextEncoder().encode(scripts).length > 32768) fail("script byte bound");
  const number = (element: Element, name: string, optional = false) => {
    const raw = element.getAttribute(name);
    if (raw === null && optional) return 0;
    if (raw === null || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) return fail("literal " + name + " required");
    const value = Number(raw);
    if (!Number.isFinite(value) || value > 36001) return fail("timing number bound");
    return value;
  };
  const localIds: string[] = [],
    mediaIds: string[] = [],
    styles: string[] = [],
    hosts: InstanceGraphInput["root"]["hosts"] = [];
  const allowedSources = new Set(assetNames),
    prefix = sourceName.slice(0, sourceName.lastIndexOf("/") + 1);
  for (const element of elements) {
    if (!allowedTags.has(element.tagName) || element.namespaceURI !== "http://www.w3.org/1999/xhtml")
      fail("unsupported tag/namespace");
    for (const attribute of element.attributes) {
      if (
        !allowedAttributes.has(attribute.name) ||
        attribute.name.startsWith("data-hf-") ||
        attribute.name.startsWith("data-avc-")
      )
        fail("unsupported retained attribute: " + attribute.name);
    }
    if (element.id.length > 56) fail("private expanded identity length bound");
    if (element.id.startsWith("__render_frame_") || element.id.startsWith("__avc")) fail("private identity");
    if (element !== root && element.hasAttribute("id") && !element.hasAttribute("data-composition-src"))
      localIds.push(element.id);
    if (element.hasAttribute("style")) styles.push(element.getAttribute("style")!);
    if (element.hasAttribute("data-composition-src")) {
      if (
        element.tagName !== "DIV" ||
        element.parentElement !== root ||
        element.children.length ||
        (element.textContent ?? "").trim() ||
        element.id !== element.getAttribute("data-composition-id") ||
        element.hasAttribute("src") ||
        element.hasAttribute("data-end")
      )
        fail("external host shape/identity");
      const source = element.getAttribute("data-composition-src")!;
      if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.html$/.test(source) || !allowedSources.has(source))
        fail("external source outside exact allowlist");
      hosts.push({
        id: element.id,
        source,
        start: number(element, "data-start"),
        duration: number(element, "data-duration"),
        inPoint: number(element, "data-media-start", true),
      });
    } else if (element !== root && element.hasAttribute("data-composition-id")) fail("nested inline composition");
    if (["AUDIO", "VIDEO"].includes(element.tagName)) {
      if (
        !element.id ||
        element.children.length ||
        element.hasAttribute("data-composition-id") ||
        element.hasAttribute("data-composition-src")
      )
        fail("media shape/identity");
      const src = element.getAttribute("src");
      if (
        !src ||
        !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:mp4|webm|wav|mp3|m4a)$/.test(src) ||
        !allowedSources.has(prefix + src)
      )
        fail("media outside literal local allowlist");
      if ((element.tagName === "AUDIO") !== /\.(?:wav|mp3|m4a)$/.test(src!)) fail("media tag/source kind mismatch");
      number(element, "data-start");
      if (number(element, "data-duration") <= 0) fail("media positive duration");
      number(element, "data-media-start", true);
      for (const name of ["data-volume", "data-playback-rate"])
        if (element.hasAttribute(name)) {
          const value = number(element, name);
          if (name === "data-volume" ? value > 1 : value < 0.125 || value > 8) fail("media literal gain/rate bound");
        }
      if (element.hasAttribute("muted") && element.getAttribute("muted") !== "")
        fail("literal muted attribute required");
      mediaIds.push(element.id);
    } else if (
      element.hasAttribute("src") ||
      element.hasAttribute("muted") ||
      element.hasAttribute("data-volume") ||
      element.hasAttribute("data-playback-rate")
    )
      fail("media-only attributes");
    if (
      element !== root &&
      !element.hasAttribute("data-composition-src") &&
      !["AUDIO", "VIDEO"].includes(element.tagName) &&
      ["data-start", "data-duration", "data-media-start", "data-width", "data-height", "data-fps"].some((name) =>
        element.hasAttribute(name),
      )
    )
      fail("unsupported local timing/metadata");
    if (element !== root && ["data-width", "data-height", "data-fps"].some((name) => element.hasAttribute(name)))
      fail("host metadata override unsupported");
  }
  const shape = (element: Element): InstanceDomNode => ({
    tag: element.tagName,
    attributes: Object.fromEntries([...element.attributes].map((a) => [a.name, a.value])),
    css: Object.fromEntries(
      [...(element as HTMLElement).style].map((key) => [key, (element as HTMLElement).style.getPropertyValue(key)]),
    ),
    text: [...element.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? "")
      .join(""),
    children: [...element.children].map(shape),
  });
  return {
    record: {
      authoredId: root.getAttribute("data-composition-id")!,
      duration: number(root, "data-duration"),
      start: 0,
      localIds,
      mediaIds,
      script: scripts,
      styles,
      hosts,
      unsupported: [],
    },
    root: shape(root),
  };
}
export type InstanceGraph = ReturnType<typeof validateCompositionInstances> & {
  documents: Record<string, ExtractedInstanceDocument>;
  rootDocument: ExtractedInstanceDocument;
  assetNames: string[];
};
/** Callback must be the worker's own inert DOMParser, never supplied by a request. */
export async function preflightCompositionInstances(
  html: string,
  children: Record<string, string>,
  assetNames: string[],
  extract: (html: string, name: string, assets: string[]) => Promise<ExtractedInstanceDocument>,
): Promise<InstanceGraph> {
  if (Buffer.byteLength(html) > STATIC_TREE_LIMITS.rootBytes) throw Error("Instance root byte bound");
  const sources = Object.entries(children);
  if (sources.length > 128) throw Error("Instance snapshot count bound");
  let total = Buffer.byteLength(html);
  for (const [name, body] of sources) {
    staticTreeSourceName(name);
    if (typeof body !== "string" || Buffer.byteLength(body) > STATIC_TREE_LIMITS.childBytes)
      throw Error("Instance child byte bound");
    total += Buffer.byteLength(body);
    if (total > STATIC_TREE_LIMITS.totalBytes) throw Error("Instance snapshot aggregate byte bound");
  }
  const rootDocument = await extract(html, "", assetNames);
  if (rootDocument.record.mediaIds.length) throw Error("Instance root native media unsupported");
  const documents: Record<string, ExtractedInstanceDocument> = {},
    assets: InstanceGraphInput["assets"] = {};
  for (const host of rootDocument.record.hosts) {
    const name = staticTreeSourceName(host.source);
    if (!Object.hasOwn(children, name)) throw Error("Instance source outside exact snapshot allowlist");
    if (Object.hasOwn(documents, name)) continue;
    const doc = await extract(children[name], name, assetNames);
    if (doc.record.hosts.length) throw Error("Instance direct leaves only");
    if (
      ["data-width", "data-height", "data-fps", "data-media-start"].some((attr) =>
        Object.hasOwn(doc.root.attributes, attr),
      )
    )
      throw Error("Instance leaf root metadata override unsupported");
    documents[name] = doc;
    assets[name] = { ...doc.record, html: children[name] };
  }
  const graph = validateCompositionInstances({ root: { ...rootDocument.record, html }, assets });
  for (const instance of graph.instances)
    if (instance.start + instance.script.duration > graph.rootDuration)
      throw Error("Instance genuine root nesting exceeds root duration");
  const unused = sources
    .filter(([name]) => !Object.hasOwn(documents, name))
    .map(([name, body]) => ({ name, sha256: digest(body), bytes: Buffer.byteLength(body) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const result = { ...graph, documents, rootDocument, assetNames: [...assetNames].sort(), unused };
  return { ...result, graphSha256: digest(JSON.stringify(result)) };
}

export function validateInstanceViewport(
  graph: InstanceGraph,
  viewport: { width: number; height: number; fps: number },
) {
  for (const [name, key] of [
    ["data-width", "width"],
    ["data-height", "height"],
    ["data-fps", "fps"],
  ] as const)
    if (Number(graph.rootDocument.root.attributes[name]) !== viewport[key])
      throw Error("Instance root viewport differs from capture");
  if (
    !Number.isSafeInteger(graph.rootDuration * viewport.fps) ||
    graph.rootDuration * viewport.fps < 1 ||
    graph.rootDuration * viewport.fps > 36001
  )
    throw Error("Instance root duration must be exact capture frames");
}
