import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";

const elements = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "title",
  "desc",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "filter",
  "feGaussianBlur",
  "use",
]);
const attributes = new Set([
  "xmlns",
  "xmlns:xlink",
  "viewBox",
  "width",
  "height",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "fill-rule",
  "clip-rule",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "points",
  "transform",
  "id",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "fx",
  "fy",
  "fr",
  "clip-path",
  "clipPathUnits",
  "mask",
  "maskUnits",
  "maskContentUnits",
  "href",
  "xlink:href",
  "color",
  "version",
  "preserveAspectRatio",
  "vector-effect",
  "paint-order",
  "stroke-dasharray",
  "stroke-dashoffset",
  "filter",
  "filterUnits",
  "primitiveUnits",
  "stdDeviation",
  "in",
  "result",
  "color-interpolation-filters",
  "overflow",
  "xml:space",
  "enable-background",
  "class",
  "role",
  "aria-hidden",
  "aria-label",
  "focusable",
]);
export function parseIconSvg(svg: string) {
  if (Buffer.byteLength(svg) > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(svg))
    throw Error("Unsafe SVG declaration or size");
  const document = new DOMParser({
    onError: () => {
      throw Error("Malformed SVG XML");
    },
  }).parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (
    !root ||
    root.tagName !== "svg" ||
    (root.namespaceURI !== null && root.namespaceURI !== "http://www.w3.org/2000/svg")
  )
    throw Error("SVG requires one namespaced root");
  const ids = new Map<string, Element>(),
    refs: { id: string; owner: Element }[] = [];
  let count = 0;
  function walk(node: Element, depth: number) {
    if (
      ++count > 20000 ||
      depth > 64 ||
      !elements.has(node.tagName) ||
      (node.namespaceURI !== null && node.namespaceURI !== "http://www.w3.org/2000/svg")
    )
      throw Error(`Unsupported SVG element or complexity: ${node.tagName}`);
    if (node.hasAttribute("style")) {
      const style = node.getAttribute("style")!;
      node.removeAttribute("style");
      for (const declaration of style.split(";").filter((s) => s.trim())) {
        const index = declaration.indexOf(":");
        const key = declaration.slice(0, index).trim(),
          value = declaration.slice(index + 1).trim();
        if (
          index < 1 ||
          ![
            "fill",
            "stroke",
            "stroke-width",
            "opacity",
            "fill-opacity",
            "stroke-opacity",
            "stop-color",
            "stop-opacity",
            "enable-background",
          ].includes(key) ||
          !value ||
          /!important|[{}]/i.test(value)
        )
          throw Error("Unsupported SVG style");
        node.setAttribute(key, value);
      }
    }
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i)!;
      const value = attr.value;
      if (!attributes.has(attr.name) || /\\|[\u0000-\u0008]/.test(value))
        throw Error(`Unsafe SVG attribute: ${attr.name}`);
      if (attr.name === "xmlns") {
        if (value !== "http://www.w3.org/2000/svg") throw Error("Unsafe SVG namespace");
        continue;
      }
      if (attr.name === "xmlns:xlink") {
        if (value !== "http://www.w3.org/1999/xlink") throw Error("Unsafe SVG namespace");
        continue;
      }
      if (/(?:https?:|data:|javascript:|file:|\/\/)/i.test(value)) throw Error("External SVG reference");
      if (attr.name === "id") {
        if (!/^[a-zA-Z_][\w.-]*$/.test(value) || ids.has(value)) throw Error("Invalid or duplicate SVG id");
        ids.set(value, node);
      }
      if (attr.name === "href" || attr.name === "xlink:href") {
        if (!/^#[a-zA-Z_][\w.-]*$/.test(value)) throw Error("Unsafe SVG href");
        refs.push({ id: value.slice(1), owner: node });
      }
      if (/url\s*\(/i.test(value)) {
        const match = /^url\(\s*['"]?#([a-zA-Z_][\w.-]*)['"]?\s*\)$/.exec(value);
        if (!match) throw Error("Unsafe SVG URL");
        refs.push({ id: match[1], owner: node });
      }
      if (
        attr.name === "stdDeviation" &&
        (!/^[0-9. ]+$/.test(value) || value.split(/ +/).some((n) => !Number.isFinite(Number(n)) || Number(n) > 128))
      )
        throw Error("SVG filter exceeds limit");
      if (value.length > 500000) throw Error("SVG path exceeds limit");
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) walk(child as Element, depth + 1);
      else if (![3, 8].includes(child.nodeType)) throw Error("Unsupported SVG node");
    }
  }
  walk(root, 0);
  for (let node = document.firstChild; node; node = node.nextSibling)
    if (
      node !== root &&
      node.nodeType !== 8 &&
      !(node.nodeType === 7 && node.nodeName === "xml") &&
      !(node.nodeType === 3 && !node.textContent?.trim())
    )
      throw Error("Unsupported SVG document node");
  for (const ref of refs) {
    const target = ids.get(ref.id);
    if (!target) throw Error("Missing internal SVG reference");
    if (ref.owner.tagName === "use") throw Error("SVG use expansion is unsupported; supply flattened paths");
  }
  const graph = new Map<Element, Element[]>();
  for (const ref of refs) {
    const target = ids.get(ref.id)!;
    let owner: Element | null = ref.owner;
    while (owner) {
      graph.set(owner, [...(graph.get(owner) ?? []), target]);
      owner = owner.parentNode?.nodeType === 1 ? (owner.parentNode as Element) : null;
    }
  }
  const visiting = new Set<Element>(),
    done = new Set<Element>();
  function visit(node: Element) {
    if (visiting.has(node)) throw Error("Cyclic SVG reference");
    if (done.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target);
    visiting.delete(node);
    done.add(node);
  }
  for (const node of graph.keys()) visit(node);
  return document;
}
export function validateSvg(svg: string) {
  parseIconSvg(svg);
  return svg;
}
export function styleSvg(
  svg: string,
  options: { size: number; padding: number; colour?: string; strokeWidth?: number; background: string },
) {
  const doc = parseIconSvg(svg),
    root = doc.documentElement!;
  const view = root.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
  const w = view?.[2] ?? Number(root.getAttribute("width")),
    h = view?.[3] ?? Number(root.getAttribute("height"));
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h)))
    throw Error("SVG needs finite dimensions or viewBox");
  if (!view) root.setAttribute("viewBox", `0 0 ${w} ${h}`);
  root.setAttribute("width", String(options.size));
  root.setAttribute("height", String(options.size));
  root.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const colour = options.colour ?? "#111111";
  function apply(node: Element) {
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i)!;
      if (
        attr.value === "currentColor" ||
        (options.colour &&
          ["fill", "stroke", "stop-color"].includes(attr.name) &&
          attr.value !== "none" &&
          !attr.value.startsWith("url("))
      )
        attr.value = colour;
      if (options.strokeWidth && attr.name === "stroke-width") attr.value = String(options.strokeWidth);
    }
    for (let n = node.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) apply(n as Element);
  }
  if (options.colour && !root.hasAttribute("fill")) root.setAttribute("fill", options.colour);
  apply(root);
  const area = options.size - 2 * options.padding;
  root.setAttribute("x", String(options.padding));
  root.setAttribute("y", String(options.padding));
  root.setAttribute("width", String(area));
  root.setAttribute("height", String(area));
  const inner = new XMLSerializer().serializeToString(root);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${options.size}" height="${options.size}" viewBox="0 0 ${options.size} ${options.size}">${options.background === "transparent" ? "" : `<rect width="${options.size}" height="${options.size}" fill="${options.background}"/>`}${inner}</svg>`;
}
