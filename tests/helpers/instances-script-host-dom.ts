/** Finite synthetic DOM/GSAP for exact retained C23 consumers, never browser acceptance. */
import vm from "node:vm";
import {
  extractInstanceDocument,
  preflightCompositionInstances,
} from "../../src/lib/backends/native-composition-instances-extract";
import { createInstanceController } from "../../src/lib/backends/native-composition-instances-prelude";
export class ElementFake {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  parentElement: ElementFake | null = null;
  children: ElementFake[] = [];
  value = "";
  values: Record<string, string>;
  constructor(
    public tagName: string,
    attributes: Record<string, string> = {},
    text = "",
  ) {
    this.tagName = tagName.toUpperCase();
    this.values = { ...attributes };
    this.value = text;
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  get src() {
    return this.getAttribute("src") ?? "";
  }
  get type() {
    return this.getAttribute("type") ?? "";
  }
  get attributes() {
    return Object.entries(this.values).map(([name, value]) => ({ name, value }));
  }
  get childNodes(): any[] {
    return [...(this.value ? [{ nodeType: 3, textContent: this.value }] : []), ...this.children];
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get parentNode() {
    return this.parentElement;
  }
  get textContent(): string {
    return this.value + this.children.map((e) => e.textContent).join("");
  }
  set textContent(value: string) {
    this.value = value;
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }
  get isConnected(): boolean {
    return this.tagName === "HTML" || Boolean(this.parentElement?.isConnected);
  }
  get nextElementSibling() {
    const a = this.parentElement?.children ?? [];
    return a[a.indexOf(this) + 1] ?? null;
  }
  getAttribute(name: string) {
    return this.values[name] ?? null;
  }
  hasAttribute(name: string) {
    return Object.hasOwn(this.values, name);
  }
  setAttribute(name: string, value: string) {
    this.values[name] = String(value);
  }
  removeAttribute(name: string) {
    delete this.values[name];
  }
  appendChild(child: ElementFake) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: ElementFake) {
    const at = this.children.indexOf(child);
    if (at < 0) throw Error("Not a child");
    this.children.splice(at, 1);
    child.parentElement = null;
    return child;
  }
  remove() {
    this.parentElement?.removeChild(this);
  }
  contains(e: ElementFake): boolean {
    return e === this || this.children.some((child) => child.contains(e));
  }
  cloneNode(deep: boolean) {
    const copy = new ElementFake(this.tagName, this.values, this.value);
    if (deep) for (const e of this.children) copy.appendChild(e.cloneNode(true));
    return copy;
  }
  querySelectorAll(selector: string) {
    const out: ElementFake[] = [];
    const visit = (e: ElementFake) => {
      if (matches(e, selector)) out.push(e);
      for (const c of e.children) visit(c);
    };
    for (const c of this.children) visit(c);
    return out;
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  get style(): any {
    const self = this;
    const values = () =>
      new Map(
        (self.values.style ?? "")
          .split(";")
          .filter((v) => v.trim())
          .map((v) => {
            const at = v.indexOf(":");
            return [v.slice(0, at).trim(), v.slice(at + 1).trim()];
          }),
      );
    return new Proxy(
      {
        getPropertyValue: (k: string) => values().get(k) ?? "",
        getPropertyPriority: () => "",
        *[Symbol.iterator]() {
          yield* values().keys();
        },
      },
      {
        get(t, k) {
          return k in t ? Reflect.get(t, k) : (values().get(String(k)) ?? "");
        },
        set(_t, k, v) {
          const current = values();
          current.set(String(k), String(v));
          self.values.style = [...current].map(([a, b]) => a + ":" + b).join(";");
          return true;
        },
      },
    );
  }
}
function matches(e: ElementFake, selector: string): boolean {
  if (selector === "*") return true;
  return selector.split(",").some((raw) => {
    const s = raw.trim();
    if (s.startsWith("#")) return e.id === s.slice(1);
    if (s.startsWith("template") || s.startsWith("meta") || s.startsWith("link") || s.startsWith("svg")) return false;
    const attr = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) return attr[2] === undefined ? e.hasAttribute(attr[1]) : e.getAttribute(attr[1]) === attr[2];
    return e.tagName.toLowerCase() === s;
  });
}
export class DocumentFake {
  documentElement = new ElementFake("html");
  head = this.documentElement.appendChild(new ElementFake("head"));
  body = this.documentElement.appendChild(new ElementFake("body"));
  currentScript: ElementFake | null = null;
  baseURI = "https://avc.invalid/";
  querySelectorAll(selector: string) {
    return [this.documentElement, ...this.documentElement.querySelectorAll("*")].filter((e) => matches(e, selector));
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getElementById(id: string) {
    return this.querySelector("#" + id);
  }
  createElement(tag: string) {
    return new ElementFake(tag);
  }
  importNode(node: ElementFake, deep: boolean) {
    return node.cloneNode(deep);
  }
}
const script = (id: string, target: string, duration: number) =>
  `const timeline=gsap.timeline({paused:true});timeline.to("#${target}",{opacity:1,duration:${duration},ease:"none"},0);window.__timelines["${id}"]=timeline;`;
export function source(root = false) {
  const d = new DocumentFake(),
    r = d.body.appendChild(
      new ElementFake("div", {
        id: root ? "root" : "leaf",
        "data-composition-id": root ? "root" : "leaf",
        "data-start": "0",
        "data-duration": "2",
        ...(root ? { "data-width": "64", "data-height": "64", "data-fps": "8" } : { style: "position:relative" }),
      }),
    );
  if (root) {
    r.appendChild(
      new ElementFake("div", {
        id: "first",
        "data-composition-id": "first",
        "data-composition-src": "leaf.html",
        "data-start": "0",
        "data-duration": "1",
      }),
    );
    r.appendChild(
      new ElementFake("div", {
        id: "second",
        "data-composition-id": "second",
        "data-composition-src": "leaf.html",
        "data-start": "1",
        "data-duration": "1",
        "data-media-start": "0.25",
      }),
    );
    r.appendChild(new ElementFake("span", { id: "anchor", style: "opacity:0" }));
  } else r.appendChild(new ElementFake("span", { id: "box", style: "opacity:0" }));
  r.appendChild(new ElementFake("script", {}, script(root ? "root" : "leaf", root ? "anchor" : "box", root ? 2 : 1)));
  return d;
}
export async function controlled() {
  const assets = ["leaf.html"],
    graph = await preflightCompositionInstances("ROOT", { "leaf.html": "LEAF" }, assets, async (html, name) =>
      extractInstanceDocument(source(html === "ROOT") as unknown as Document, name, assets),
    ),
    d = source(true),
    w: any = { document: d },
    violations: string[] = [],
    cap = createInstanceController(graph, d as unknown as Document, w, (message) => {
      violations.push(message);
      throw Error(message);
    });
  class Timeline {
    seconds = 0;
    targets: ElementFake[] = [];
    totalTime() {}
    duration() {
      return this.seconds;
    }
    getChildren() {
      return [{ targets: () => this.targets }];
    }
    to(target: ElementFake[], vars: { duration: number }) {
      this.targets.push(...target);
      this.seconds = Math.max(this.seconds, vars.duration);
      return this;
    }
  }
  w.gsap = { core: { Timeline }, timeline: () => new Timeline() };
  const root = d.body.children[0],
    rootScript = root.children[3];
  d.currentScript = rootScript;
  const rootTimeline = new Timeline();
  rootTimeline.to([root.children[2]], { duration: 2 });
  w.__timelines.root = rootTimeline;
  d.currentScript = null;
  const inert = new ElementFake("style", { id: "__hf-audio-group-inert" }, "hf-audio-group{display:none!important}");
  cap.instanceRegisterInertStyle(inert as unknown as Element);
  d.head.appendChild(inert);
  const sheet: any = { ownerNode: inert, href: null, disabled: false };
  const rule: any = {
    type: 1,
    parentStyleSheet: sheet,
    selectorText: "hf-audio-group",
    style: { length: 1, item: () => "display", getPropertyValue: () => "none", getPropertyPriority: () => "important" },
  };
  sheet.cssRules = [rule];
  (inert as any).sheet = sheet;
  return { d, w, cap, graph, violations, root, first: root.children[0], second: root.children[1], Timeline };
}
export function evaluateScript(s: Awaited<ReturnType<typeof controlled>>, context: vm.Context) {
  const append = s.d.body.appendChild.bind(s.d.body);
  s.d.body.appendChild = (element: ElementFake) => {
    append(element);
    if (element.tagName === "SCRIPT") {
      s.d.currentScript = element;
      try {
        vm.runInContext(element.textContent, context, { timeout: 1000 });
      } finally {
        s.d.currentScript = null;
      }
    }
    return element;
  };
}
