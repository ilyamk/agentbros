export type Rect = { x: number; y: number; width: number; height: number };
export type MeasuredText = {
  /** Position in the page's stashed node list, for CDP font lookups. */
  index: number;
  text: string;
  /** Ink box per rendered line, clipped by masking ancestors. */
  lines: Rect[];
  /** Ink box per line, clipped only by masks inside the declared region. */
  regionLines: Rect[];
  region?: { name: string; rect: Rect };
  opacity: number;
  family: string;
  weight: string;
  fontSize?: number;
  style: string;
  names: string[];
  label: string;
  elementId: number;
  ancestorIds: number[];
  clipPath: boolean;
  /** Computed text-align and colour of the text's parent. */
  align: string;
  colour: string;
  /** Stable across frames: the nearest block-level ancestor's tag and text, so a split word's spans track as one element. */
  block: string;
  /** The nearest ancestor with its own opacity below 1 on this frame (its elementId), or null: texts under one fader enter as one. */
  fader: number | null;
  /** The nearest `data-overflow` ancestor's reason: a block declaring that this text crosses the stage or safe zone by design on this frame. */
  overflow?: string;
};
/** A computed style of a visible element larger than half a percent of the stage, as Chromium reports it. */
export type MeasuredStyle = { label: string; value: string };
export type PageMeasurement = {
  texts: MeasuredText[];
  customFamilies: string[];
  gradients: MeasuredStyle[];
  backdrops: MeasuredStyle[];
};

/**
 * Runs inside the composition page; serialised with toString(), so it must not
 * reference anything outside itself. Lists every visible text node with the box
 * its glyphs actually occupy, rather than the taller line box.
 */
export function measureVisibleText(stage: { width: number; height: number }): PageMeasurement {
  type Info = {
    opacity: number;
    id: number;
    ancestorIds: number[];
    style: CSSStyleDeclaration;
    clipPath: boolean;
    fader: number | null;
  };
  const seen = new Map<Element, Info>();
  let nextId = 0;
  const infoOf = (element: Element): Info => {
    const known = seen.get(element);
    if (known) return known;
    const style = getComputedStyle(element);
    const parent = element.parentElement ? infoOf(element.parentElement) : undefined;
    const id = nextId++;
    const info: Info = {
      opacity: Number(style.opacity) * (parent?.opacity ?? 1),
      id,
      fader: Number(style.opacity) < 0.999 ? id : (parent?.fader ?? null),
      ancestorIds: parent ? [parent.id, ...parent.ancestorIds] : [],
      style,
      clipPath:
        (style.clipPath !== "" && style.clipPath !== "none") ||
        (style.maskImage !== "" && style.maskImage !== "none") ||
        parent?.clipPath === true,
    };
    seen.set(element, info);
    return info;
  };
  const intersect = (a: Rect, b: Rect): Rect | undefined => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
  };
  const coversStage = (box: DOMRect) =>
    box.left <= 0 && box.top <= 0 && box.right >= stage.width && box.bottom >= stage.height;
  /** Masks between the text and `until`. A stage-sized clip is ignored: text cut off by the stage edge is a defect. */
  const clipLines = (lines: Rect[], from: Element, until: Element | null): Rect[] => {
    let current = lines;
    for (let element: Element | null = from; element && element !== until; element = element.parentElement) {
      const { overflowX, overflowY } = infoOf(element).style;
      if (overflowX === "visible" && overflowY === "visible") continue;
      const box = element.getBoundingClientRect();
      if (coversStage(box)) continue;
      const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
      current = current.map((line) => intersect(line, clip)).filter((line): line is Rect => line !== undefined);
    }
    return current;
  };
  const canvas = document.createElement("canvas").getContext("2d");
  const inkLines = (range: Range, text: string, style: CSSStyleDeclaration): Rect[] => {
    const shown =
      style.textTransform === "uppercase"
        ? text.toUpperCase()
        : style.textTransform === "lowercase"
          ? text.toLowerCase()
          : text;
    if (canvas) {
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      canvas.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
    }
    const metrics = canvas?.measureText(shown);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5);
    return rects.map((rect) => {
      if (!metrics || !metrics.fontBoundingBoxAscent)
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      const scaleY = rect.height / (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
      const top = rect.y + Math.max(0, metrics.fontBoundingBoxAscent - metrics.actualBoundingBoxAscent) * scaleY;
      const bottom =
        rect.y + Math.min(rect.height, (metrics.fontBoundingBoxAscent + metrics.actualBoundingBoxDescent) * scaleY);
      const vertical = { y: top, height: Math.max(1, bottom - top) };
      // Side bearings and trailing letter-spacing are only known for the whole string, so wrapped text keeps its advance box.
      if (rects.length > 1 || !metrics.width) return { x: rect.x, width: rect.width, ...vertical };
      const scaleX = rect.width / metrics.width;
      const left = rect.x - metrics.actualBoundingBoxLeft * scaleX;
      const right = rect.x + metrics.actualBoundingBoxRight * scaleX;
      return right > left
        ? { x: left, width: right - left, ...vertical }
        : { x: rect.x, width: rect.width, ...vertical };
    });
  };
  const transparent = (colour: string) => /^rgba\(.*,\s*0\)$/.test(colour) || colour === "transparent";
  const hiddenInk = (style: CSSStyleDeclaration) =>
    transparent(style.webkitTextFillColor || style.color) &&
    style.backgroundClip !== "text" &&
    parseFloat(style.webkitTextStrokeWidth || "0") === 0;
  const labelOf = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`;
  const blockKey = (element: Element): string => {
    let block = element;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const display = infoOf(current).style.display;
      if (!display.startsWith("inline") && display !== "contents") {
        block = current;
        break;
      }
    }
    return `${labelOf(block)}|${(block.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80)}`;
  };

  const texts: MeasuredText[] = [];
  const nodes: Node[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = node.textContent?.trim();
    if (!text || !parent || ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TITLE"].includes(parent.tagName)) continue;
    const info = infoOf(parent);
    if (info.opacity <= 0.01 || info.style.visibility !== "visible" || hiddenInk(info.style)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const ink = inkLines(range, text, info.style);
    const lines = clipLines(ink, parent, null);
    if (!lines.length) continue;
    const regionElement = parent.closest("[data-region]");
    const overflow = parent.closest("[data-overflow]")?.getAttribute("data-overflow")?.trim();
    const regionBox = regionElement?.getBoundingClientRect();
    const names: string[] = [];
    for (let element: Element | null = parent; element; element = element.parentElement)
      for (const name of [element.id, element.getAttribute("data-element"), element.getAttribute("data-region")])
        if (name) names.push(name);
    texts.push({
      index: nodes.length,
      text,
      lines,
      regionLines: regionElement ? clipLines(ink, parent, regionElement) : lines,
      ...(regionElement && regionBox
        ? {
            region: {
              name: regionElement.getAttribute("data-region") ?? "",
              rect: { x: regionBox.x, y: regionBox.y, width: regionBox.width, height: regionBox.height },
            },
          }
        : {}),
      opacity: info.opacity,
      family: info.style.fontFamily,
      weight: info.style.fontWeight,
      fontSize: parseFloat(info.style.fontSize),
      style: info.style.fontStyle,
      names,
      label: labelOf(parent),
      elementId: info.id,
      ancestorIds: info.ancestorIds,
      clipPath: info.clipPath,
      align: info.style.textAlign,
      colour: info.style.color,
      block: blockKey(parent),
      fader: info.fader,
      ...(overflow ? { overflow } : {}),
    });
    nodes.push(node);
  }
  (window as unknown as { __motionCheckNodes: Node[] }).__motionCheckNodes = nodes;
  const gradients: MeasuredStyle[] = [];
  const backdrops: MeasuredStyle[] = [];
  const minArea = stage.width * stage.height * 0.005;
  for (const element of document.body.querySelectorAll("*")) {
    const info = infoOf(element);
    const { backgroundImage, backdropFilter } = info.style;
    const webkitBackdrop = (info.style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter;
    const backdrop =
      backdropFilter && backdropFilter !== "none"
        ? backdropFilter
        : webkitBackdrop && webkitBackdrop !== "none"
          ? webkitBackdrop
          : "";
    const gradient = backgroundImage.includes("gradient(");
    if ((!gradient && !backdrop) || info.opacity <= 0.05 || info.style.visibility !== "visible") continue;
    const box = element.getBoundingClientRect();
    const shown = intersect(
      { x: box.x, y: box.y, width: box.width, height: box.height },
      { x: 0, y: 0, width: stage.width, height: stage.height },
    );
    if (!shown || shown.width * shown.height < minArea) continue;
    if (gradient) gradients.push({ label: labelOf(element), value: backgroundImage });
    if (backdrop) backdrops.push({ label: labelOf(element), value: backdrop });
  }
  return {
    texts,
    customFamilies: [...new Set([...document.fonts].map((face) => face.family.replace(/^["']|["']$/g, "")))],
    gradients,
    backdrops,
  };
}

/** tsx's keepNames wraps inner functions in `__name`, which the page does not have. */
export const measureScript = (stage: { width: number; height: number }) =>
  `(() => { const __name = (value) => value; return (${measureVisibleText.toString()})(${JSON.stringify(stage)}); })()`;
