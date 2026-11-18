import type { InstanceGraph, InstanceDomNode } from "./native-composition-instances-extract";
import { resolveInstanceProduct, INSTANCE_PRODUCT_DESCRIPTOR_SHA256 } from "./native-composition-instances-product";
const product = resolveInstanceProduct();
export const HYPERFRAMES_INSTANCES_PIN = {
  profile: product.profile,
  runtimeSha256: product.runtimeSha256,
  engineBytes: product.engineBytes,
  sourceClosureSha256: product.sourceClosureSha256,
  buildReceiptSha256: product.receipt.sha256,
  buildRecipeSha256: product.recipe.sha256,
  selectionContractSha256: product.selectionContract.sha256,
  productVersion: product.version,
  activation: product.activation,
  productDescriptorSha256: INSTANCE_PRODUCT_DESCRIPTOR_SHA256,
  verificationScope: product.verificationScope,
} as const;
type Timeline = {
  duration(): number;
  totalTime: unknown;
  parent?: unknown;
  startTime?(): number;
  getChildren(...args: boolean[]): (Timeline | { targets?: () => Element[]; vars?: Record<string, unknown> })[];
};
type InstanceWindow = Window & {
  gsap?: { core: { Timeline: new (...args: never[]) => unknown } };
  __timelines?: Record<string, Timeline>;
  __clipManifest?: { durationSeconds: number; clips: { id: string | null }[] };
  __avcPrivateInstanceAcquire?: unknown;
};
/** Serializable private controller. Synthetic-DOM CPU tests are not engine acceptance. */
export function createInstanceController(
  graph: InstanceGraph,
  document: Document,
  window: InstanceWindow,
  outerRefuse: (message: string) => never,
) {
  // Exact C22 private hook; no authored/global registration authority.
  let phase = "controller-created",
    mountStarted = false,
    inertStyle: Element | undefined,
    inertSheet: CSSStyleSheet | undefined;
  let dead = false,
    failure: string | undefined,
    root: Element | undefined,
    rootScript: Element | undefined,
    wrappers: Element[] | undefined,
    armed: { host: Element; script: HTMLScriptElement; consumed: boolean } | undefined,
    normalizing: Element[] | undefined;
  const knownElements = new Set<Element>();
  const scriptTexts = new Map<Element, string>();
  const hosts = new Map<string, Element>(),
    known = new WeakMap<
      Element,
      {
        id: string | null;
        owner: string;
        attributes: Record<string, string>;
        text: string;
        parent: Element | null;
        tag: string;
        css: Record<string, string>;
        children: Element[];
      }
    >(),
    loaded = new Set<Element>(),
    selected = new Set<Element>(),
    pending = new Set<Element>(),
    normalized = new Set<Element>(),
    injected = new Set<Element>(),
    frames = new Map<Element, Element>(),
    registered = new Map<string, Timeline>();
  const registryValues = Object.create(null) as Record<string, Timeline>;
  const fail = (message: unknown): never => {
    failure ??= String(message);
    return outerRefuse("Instance controller: " + failure);
  };
  const live = () => {
    if (dead || failure) fail(dead ? "controller disposed" : failure);
  };
  const row = (id: string) => graph.instances.find((value) => value.id === id) ?? fail("unknown runtime host");
  const attribute = (element: Element, name: string) => element.getAttribute(name);
  const attrs = (element: Element) => Object.fromEntries([...element.attributes].map((a) => [a.name, a.value]));
  const directText = (element: Element) =>
    [...element.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? "")
      .join("");
  // Error-only bounded diagnostic. Its first snapshot is retained by fail's latch.
  type WrapperReason =
    | "wrapper-identity"
    | "wrapper-missing"
    | "wrapper-tag"
    | "wrapper-namespace"
    | "wrapper-direct-text"
    | "wrapper-parent"
    | "wrapper-child-count"
    | "wrapper-child-order"
    | "head-child"
    | "wrapper-attribute"
    | "wrapper-style"
    | "body-shape"
    | "injected-script"
    | "inert-style-shape"
    | "inert-style-sheet"
    | "missing-inert-style";
  const wrapperFailure = (
    reason: WrapperReason,
    message: string,
    wrapperIndex?: number,
    styleDeclaration?: { key: string; value: string; priority: string },
  ): never => {
    const actual = [document.documentElement, document.head, document.body];
    const summary = (element: Element | null | undefined) => {
      if (!element) return { missing: true };
      const text = element.textContent ?? "";
      return {
        tag: element.tagName.slice(0, 24),
        id: element.id.slice(0, 64),
        attributes: element.attributes.length,
        children: element.children.length,
        textLength: text.length,
        textLiteral: text.slice(0, 120),
        exactKnownInertStyleText: text === "hf-audio-group{display:none!important}",
      };
    };
    const current = document.currentScript,
      childWrapper = wrapperIndex ?? (reason === "body-shape" || reason === "injected-script" ? 2 : 0);
    const context = {
      reason,
      ...(styleDeclaration
        ? {
            styleDeclaration: {
              key: styleDeclaration.key.slice(0, 32),
              value: styleDeclaration.value.slice(0, 80),
              priority: styleDeclaration.priority.slice(0, 16),
            },
          }
        : {}),
      wrapperIndex: wrapperIndex ?? null,
      phase,
      rootAuthenticated: Boolean(root),
      rootPublished: registered.has(graph.rootId),
      currentScript:
        current === null ? "none" : current === rootScript ? "root" : injected.has(current) ? "injected" : "unknown",
      currentScriptId: current?.id.slice(0, 64) ?? "",
      sourceSha256: graph.rootSha256,
      wrappers: actual.map((element, index) => ({
        ...summary(element),
        firstChildren:
          element && index === childWrapper
            ? [element.children[0], element.children[1]].filter(Boolean).map(summary)
            : [],
      })),
    };
    return fail(message + "; wrapperDiagnostic=" + JSON.stringify(context));
  };
  const validateInertStyle = () => {
    const element = inertStyle!;
    if (
      document.head.children.length !== 1 ||
      document.head.children[0] !== element ||
      element.parentElement !== document.head ||
      !element.isConnected ||
      element.tagName !== "STYLE" ||
      element.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      element.attributes.length !== 1 ||
      element.attributes[0].name !== "id" ||
      element.id !== "__hf-audio-group-inert" ||
      element.children.length ||
      element.textContent !== "hf-audio-group{display:none!important}"
    )
      wrapperFailure("inert-style-shape", "document wrapper inert style changed", 1);
    let valid = false;
    try {
      const sheet = (element as HTMLStyleElement).sheet;
      if (
        sheet &&
        sheet.ownerNode === element &&
        sheet.href === null &&
        sheet.disabled === false &&
        (!inertSheet || inertSheet === sheet)
      ) {
        const rules = sheet.cssRules,
          rule = rules[0] as CSSStyleRule | undefined;
        valid =
          rules.length === 1 &&
          Boolean(rule) &&
          rule!.type === 1 &&
          rule!.parentStyleSheet === sheet &&
          rule!.selectorText === "hf-audio-group" &&
          rule!.style.length === 1 &&
          rule!.style.item(0) === "display" &&
          rule!.style.getPropertyValue("display") === "none" &&
          rule!.style.getPropertyPriority("display") === "important";
        if (valid) inertSheet ??= sheet;
      }
    } catch {
      /* An inaccessible or malformed CSSOM is a refusal, never an allowance. */
    }
    if (!valid) wrapperFailure("inert-style-sheet", "document wrapper inert stylesheet changed", 1);
  };
  const requireInertStyle = () => {
    if (!inertStyle) wrapperFailure("missing-inert-style", "document wrapper private inert style required", 1);
    validateInertStyle();
  };
  // Exact observed CSSOM equivalents of trusted init.ts568–575 normalization.
  const wrapperCssEquivalents: Record<string, string> = {
    "margin-top": "0px",
    "margin-right": "0px",
    "margin-bottom": "0px",
    "margin-left": "0px",
    "padding-top": "0px",
    "padding-right": "0px",
    "padding-bottom": "0px",
    "padding-left": "0px",
    "overflow-x": "hidden",
    "overflow-y": "hidden",
  };
  const wrapperCheck = () => {
    const actual = [document.documentElement, document.head, document.body];
    if (wrappers && actual.some((element, index) => element !== wrappers![index]))
      wrapperFailure("wrapper-identity", "document wrapper identity changed");
    for (const [index, element] of actual.entries()) {
      if (!element) wrapperFailure("wrapper-missing", "document wrapper structure/text changed", index);
      if (element.tagName !== ["HTML", "HEAD", "BODY"][index])
        wrapperFailure("wrapper-tag", "document wrapper structure/text changed", index);
      if (element.namespaceURI !== "http://www.w3.org/1999/xhtml")
        wrapperFailure("wrapper-namespace", "document wrapper structure/text changed", index);
      if (directText(element).trim())
        wrapperFailure("wrapper-direct-text", "document wrapper structure/text changed", index);
    }
    if (
      actual[0].parentElement !== null ||
      actual[1].parentElement !== actual[0] ||
      actual[2].parentElement !== actual[0]
    )
      wrapperFailure("wrapper-parent", "document wrapper structure/text changed");
    if (actual[0].children.length !== 2)
      wrapperFailure("wrapper-child-count", "document wrapper structure/text changed");
    if (actual[0].children[0] !== actual[1] || actual[0].children[1] !== actual[2])
      wrapperFailure("wrapper-child-order", "document wrapper structure/text changed");
    if (inertStyle) validateInertStyle();
    else if (actual[1].children.length) wrapperFailure("head-child", "document wrapper structure/text changed", 1);
    for (const [index, element] of actual.entries()) {
      if ([...element.attributes].some((attribute) => index === 1 || attribute.name !== "style"))
        wrapperFailure("wrapper-attribute", "document wrapper attribute changed", index);
      const style = (element as HTMLElement).style;
      for (const key of [...style]) {
        const value = style.getPropertyValue(key),
          priority = style.getPropertyPriority(key),
          equivalent =
            (index === 0 || index === 2) &&
            Object.hasOwn(wrapperCssEquivalents, key) &&
            value === wrapperCssEquivalents[key],
          expected =
            key === "width"
              ? graph.rootDocument.root.attributes["data-width"]
              : key === "height"
                ? graph.rootDocument.root.attributes["data-height"]
                : undefined;
        if (
          priority ||
          !(
            equivalent ||
            ((key === "margin" || key === "padding") && (value === "0" || value === "0px")) ||
            (key === "overflow" && value === "hidden") ||
            (expected !== undefined && value === expected + "px")
          )
        )
          wrapperFailure("wrapper-style", "document wrapper style changed", index, { key, value, priority });
      }
    }
    if (root) {
      const children = [...actual[2].children];
      if (children.length !== 1 + injected.size || children[0] !== root || root.parentElement !== actual[2])
        wrapperFailure("body-shape", "document body shape changed");
      for (const [index, script] of [...injected].entries())
        if (
          children[index + 1] !== script ||
          script.tagName !== "SCRIPT" ||
          script.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
          script.parentElement !== actual[2] ||
          script.textContent !== scriptTexts.get(script) ||
          script.attributes.length ||
          script.children.length
        )
          wrapperFailure("injected-script", "injected script changed");
    }
    wrappers ??= actual;
  };
  const assign = (element: Element, shape: InstanceDomNode, owner: string, flattened = false) => {
    if (known.has(element)) fail("node registered twice");
    if (element.tagName !== shape.tag) fail("mounted tag differs");
    const expected = { ...shape.attributes };
    if (flattened) {
      for (const name of ["id", "data-composition-id", "data-start", "data-duration"]) delete expected[name];
      expected["data-hf-authored-id"] = shape.attributes.id;
      expected["data-hf-inner-root"] = "true";
    }
    if (shape.tag === "SCRIPT") {
      if (owner !== graph.rootId) fail("unexpected mounted author script");
      rootScript = element;
    }
    const authoredId = shape.attributes.id,
      privateId =
        shape.tag === "SCRIPT"
          ? null
          : element === root
            ? graph.rootId
            : shape.attributes["data-composition-src"]
              ? authoredId
              : authoredId
                ? `i${graph.instances.findIndex((value) => value.id === owner) + 1}_${authoredId}`
                : null;
    if (privateId && privateId.length > 64) fail("private clip identity bound");
    knownElements.add(element);
    known.set(element, {
      id: privateId,
      owner,
      attributes: expected,
      text: shape.text,
      parent: element.parentElement,
      tag: shape.tag,
      css: shape.css,
      children: [...element.children],
    });
    const expectedChildren = shape.children.filter((child) => !flattened || child.tag !== "SCRIPT"),
      actual = [...element.children].filter((child) => !frames.has(child));
    if (element.hasAttribute("data-composition-src")) {
      if (actual.length) fail("initial host not empty");
      hosts.set(authoredId, element);
      return;
    }
    if (actual.length !== expectedChildren.length) fail("mounted child shape differs");
    for (let i = 0; i < actual.length; i++) assign(actual[i], expectedChildren[i], owner);
  };
  const rootAuth = () => {
    wrapperCheck();
    if (root) return;
    const candidates = [...document.querySelectorAll("[data-composition-id]")].filter(
      (el) => !el.hasAttribute("data-composition-src"),
    );
    if (
      candidates.length !== 1 ||
      candidates[0].getAttribute("data-composition-id") !== graph.rootId ||
      candidates[0].parentElement !== document.body
    )
      fail("authentic root missing");
    root = candidates[0];
    assign(root, graph.rootDocument.root, graph.rootId);
    if (!rootScript || rootScript.textContent !== graph.rootDocument.record.script || rootScript.parentElement !== root)
      fail("root script identity/text");
    if (hosts.size !== graph.instances.length) fail("initial host count differs");
    wrapperCheck();
  };
  // Detached registration authority comes solely from the private C22 hook; matching
  // id/text is only consistency, never a global lookup or authored capability.
  const instanceRegisterInertStyle = (element: Element) => {
    phase = "register-inert-style";
    live();
    rootAuth();
    if (
      inertStyle ||
      mountStarted ||
      !registered.has(graph.rootId) ||
      document.currentScript !== null ||
      element.isConnected ||
      element.parentElement !== null ||
      element.tagName !== "STYLE" ||
      element.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      element.attributes.length !== 1 ||
      element.attributes[0].name !== "id" ||
      element.id !== "__hf-audio-group-inert" ||
      element.children.length ||
      element.textContent !== "hf-audio-group{display:none!important}"
    )
      fail("private inert style registration authority/shape");
    inertStyle = element;
  };
  const targetCheck = (owner: string, timeline: Timeline) => {
    if (
      !window.gsap?.core.Timeline ||
      !(timeline instanceof window.gsap.core.Timeline) ||
      !timeline ||
      typeof timeline.totalTime !== "function" ||
      typeof timeline.duration !== "function" ||
      typeof timeline.getChildren !== "function" ||
      !Number.isFinite(timeline.duration()) ||
      timeline.duration() <= 0
    )
      fail("invalid genuine timeline");
    const duration = owner === graph.rootId ? graph.rootDuration : graph.documents[row(owner).source].record.duration;
    if (timeline.duration() > duration) fail("timeline duration outside authored bound");
    const tweens = timeline.getChildren(false, true, true);
    if (!Array.isArray(tweens) || tweens.length > 1024) fail("timeline introspection bound");
    for (const tween of tweens) {
      if (tween instanceof window.gsap!.core.Timeline) {
        const child = tween as Timeline,
          match = [...registered].find(([key, value]) => key !== graph.rootId && value === child);
        if (
          owner !== graph.rootId ||
          !match ||
          child.parent !== timeline ||
          typeof child.startTime !== "function" ||
          child.startTime() !== row(match[0]).start
        )
          fail("unowned nested timeline");
        continue;
      }
      const tweenWithTargets = tween as { targets?: () => Element[] };
      if (typeof tweenWithTargets.targets !== "function") fail("unowned non-tween animation");
      for (const target of tweenWithTargets.targets!()) {
        const entry = known.get(target);
        if (!entry || entry.owner !== owner || entry.tag === "AUDIO" || entry.tag === "VIDEO")
          fail("timeline target outside owned nonmedia elements");
      }
    }
  };
  const publish = (owner: string, timeline: Timeline) => {
    live();
    if (registered.has(owner)) fail("timeline publication repeated");
    targetCheck(owner, timeline);
    registered.set(owner, timeline);
    registryValues[owner] = timeline;
  };
  const registry = new Proxy(registryValues, {
    set(_target, key, value) {
      phase = "root-publication";
      live();
      rootAuth();
      if (key !== graph.rootId || document.currentScript !== rootScript) fail("global registry publication authority");
      publish(graph.rootId, value);
      return true;
    },
    defineProperty() {
      return fail("registry defineProperty");
    },
    deleteProperty() {
      return fail("registry delete");
    },
    setPrototypeOf() {
      return fail("registry prototype");
    },
  });
  Object.defineProperty(window, "__timelines", {
    get: () => registry,
    set: (value) => {
      live();
      if (value !== registry) fail("registry replacement");
    },
    configurable: false,
  });
  const hostCheck = (element: Element) => {
    rootAuth();
    const id = attribute(element, "data-composition-id");
    if (!id || hosts.get(id) !== element || element.parentElement !== root || !element.isConnected)
      fail("host ownership");
    const expected = row(id!);
    if (
      attribute(element, "id") !== id ||
      attribute(element, "data-composition-src") !== expected.source ||
      attribute(element, "data-start") !== known.get(element)?.attributes["data-start"] ||
      attribute(element, "data-media-start") !== (known.get(element)?.attributes["data-media-start"] ?? null)
    )
      fail("host metadata");
    return expected;
  };
  const scan = () => {
    live();
    rootAuth();
    available();
    wrapperCheck();
    const elements = [...document.querySelectorAll("*")];
    if (elements.length > 512 + graph.instances.length * 512 + 8) fail("expanded DOM count bound");
    for (const element of elements) {
      if (
        [document.documentElement, document.head, document.body].includes(element as HTMLElement) ||
        element === inertStyle
      )
        continue;
      if (injected.has(element)) {
        if (
          element.parentElement !== document.body ||
          element.textContent !== scriptTexts.get(element) ||
          element.attributes.length
        )
          fail("injected script changed");
        continue;
      }
      if (frames.has(element)) {
        const video = frames.get(element)!;
        if (
          element.parentElement !== video.parentElement ||
          video.nextElementSibling !== element ||
          element.id !== "__render_frame_" + video.getAttribute("data-hf-render-id") + "__" ||
          element.getAttribute("data-avc-native-frame") !== ""
        )
          fail("transport frame changed");
        continue;
      }
      const entry = known.get(element);
      if (!entry) fail("unknown DOM element");
      if (
        !element.isConnected ||
        element.parentElement !== entry!.parent ||
        element.tagName !== entry!.tag ||
        directText(element) !== entry!.text
      )
        fail("node/text/parent ownership changed");
      const children = [...element.children].filter((child) => !frames.has(child));
      if (element.hasAttribute("data-composition-src")) {
        if (children.length > 1 || (children.length === 1 && known.get(children[0])?.owner !== element.id))
          fail("host mounted shape changed");
      } else if (
        children.length !== entry!.children.length ||
        children.some((child, index) => child !== entry!.children[index])
      )
        fail("child order/identity changed");
      const actual = attrs(element),
        expected = entry!.attributes;
      const css = new Map<string, string>(),
        priorities = new Map<string, string>(),
        style = (element as HTMLElement).style;
      for (const key of [...style]) {
        css.set(key, style.getPropertyValue(key));
        priorities.set(key, style.getPropertyPriority(key));
      }
      type ElementStyleReason =
        | "new-property"
        | "immutable-value"
        | "root-overflow"
        | "display"
        | "visibility"
        | "position"
        | "network"
        | "root-layout"
        | "root-sizing"
        | "flattened-sizing";
      const styleFailure = (message: string, reason: ElementStyleReason, key: string): never => {
        const diagnostic = {
          reason,
          phase,
          tag: element.tagName.slice(0, 24),
          actualId: element.id.slice(0, 64),
          authoredId: (expected.id ?? "").slice(0, 64),
          privateId: entry!.id?.slice(0, 64) ?? null,
          owner: entry!.owner.slice(0, 64),
          rootObject: element === root,
          sourceSha256: entry!.owner === graph.rootId ? graph.rootSha256 : row(entry!.owner).sourceSha256,
          styleDeclaration: {
            key: key.slice(0, 32),
            value: (css.get(key) ?? "").slice(0, 80),
            priority: (priorities.get(key) ?? "").slice(0, 16),
          },
        };
        return fail(message + "; elementStyleDiagnostic=" + JSON.stringify(diagnostic));
      };
      const initial = new Map(Object.entries(entry!.css));
      const mutable = new Set<string>();
      const script = entry!.owner === graph.rootId ? graph.rootScript : row(entry!.owner).script;
      if (expected.id && script.targets.includes(expected.id))
        for (const key of ["opacity", "transform", "color", "background-color", "border-color"]) mutable.add(key);
      if (element === root)
        for (const key of ["position", "overflow", "visibility", "width", "height", "--comp-width", "--comp-height"])
          mutable.add(key);
      if (element.hasAttribute("data-composition-src") || ["AUDIO", "VIDEO"].includes(entry!.tag))
        for (const key of ["visibility", "display", "position", "width", "height"]) mutable.add(key);
      if (expected["data-hf-inner-root"] === "true") for (const key of ["width", "height"]) mutable.add(key);
      // Exact applyClipLayout overflow semantics belong to the captured root object only.
      // Validate before initial-value equality so a priority change cannot bypass this gate.
      if (element === root)
        for (const key of ["overflow-x", "overflow-y"])
          if (css.has(key) && (css.get(key) !== "hidden" || priorities.get(key) !== ""))
            styleFailure("root layout changed", "root-overflow", key);
      for (const [key, value] of initial)
        if (!mutable.has(key) && css.get(key) !== value)
          styleFailure("immutable style changed", "immutable-value", key);
      for (const [key, value] of css) {
        if (
          element === root &&
          (key === "overflow-x" || key === "overflow-y") &&
          value === "hidden" &&
          priorities.get(key) === ""
        )
          continue;
        if (initial.get(key) === value || mutable.has(key)) continue;
        styleFailure("new unsupported style: " + key, "new-property", key);
      }
      if (css.has("display") && !["none", "block", "flex"].includes(css.get("display")!))
        styleFailure("unknown display state", "display", "display");
      if (css.has("visibility") && !["visible", "hidden", ""].includes(css.get("visibility")!))
        styleFailure("unknown visibility state", "visibility", "visibility");
      if (css.has("position") && !["absolute", "relative"].includes(css.get("position")!))
        styleFailure("unknown position state", "position", "position");
      for (const [key, value] of css)
        if (/url\(|@import/i.test(value)) styleFailure("runtime style network reference", "network", key);
      if (element === root) {
        if (css.get("position") && css.get("position") !== "relative")
          styleFailure("root layout changed", "root-layout", "position");
        if (css.get("overflow") && css.get("overflow") !== "hidden")
          styleFailure("root layout changed", "root-layout", "overflow");
        for (const [name, key] of [
          ["data-width", "width"],
          ["data-height", "height"],
        ])
          if (expected[name] && css.get(key) && css.get(key) !== expected[name] + "px")
            styleFailure("root sizing changed", "root-sizing", key);
      }
      if (expected["data-hf-inner-root"] === "true")
        for (const key of ["width", "height"])
          if (css.get(key) !== "100%" || priorities.get(key) !== "")
            styleFailure("flattened root sizing", "flattened-sizing", key);
      for (const [key, value] of Object.entries(expected)) {
        if (key === "style") continue;
        if (key === "data-duration" && normalized.has(element)) {
          if (actual["data-duration"] !== undefined || actual["data-hf-authored-duration"] !== value)
            fail("sanitized duration differs");
        } else if (key === "src" && ["AUDIO", "VIDEO"].includes(entry!.tag)) {
          const source = row(entry!.owner).source,
            base = new URL(source, "https://avc.invalid/"),
            url = new URL(value, base);
          if (new URL(actual.src, "https://avc.invalid/").href !== url.href) fail("media src changed");
        } else if (actual[key] !== value) fail("immutable attribute changed: " + key);
      }
      for (const key of Object.keys(actual)) {
        if (
          Object.hasOwn(expected, key) ||
          key === "style" ||
          (key === "data-hf-authored-duration" && normalized.has(element)) ||
          (["AUDIO", "VIDEO"].includes(entry!.tag) &&
            ["data-hf-render-id", "data-avc-native-index", "preload"].includes(key))
        )
          continue;
        fail("new unsupported attribute: " + key);
      }
      if (element.hasAttribute("data-composition-src")) hostCheck(element);
    }
    for (const media of document.querySelectorAll("audio,video")) {
      const owned = known.get(media);
      if (owned && media.hasAttribute("data-hf-render-id") && owned.id !== media.getAttribute("data-hf-render-id"))
        fail("native media render ID changed");
      if (media.hasAttribute("preload") && media.getAttribute("preload") !== "auto") fail("native preload changed");
    }
    for (const element of knownElements) if (!elements.includes(element)) fail("authenticated node removed");
    for (const [owner, timeline] of registered) targetCheck(owner, timeline);
  };
  const prepareMounted = (caller: "treeGuard" | "instancePrepareMedia") => {
    for (const [id, host] of hosts) {
      const hostLoaded = loaded.has(host),
        children = [...host.children];
      if (!hostLoaded || children.length !== 1) {
        // Error-only snapshot from the same predicate inputs, retained by fail's first latch.
        const summary = (element: Element) => {
          const retained = known.get(element);
          return {
            tag: element.tagName.slice(0, 24),
            id: element.id.slice(0, 64),
            authoredId: (element.getAttribute("data-hf-authored-id") ?? "").slice(0, 64),
            namespace: (element.namespaceURI ?? "").slice(0, 64),
            retainedKnown: Boolean(retained),
            owner: (retained?.owner ?? "").slice(0, 64),
            innerRoot: element.getAttribute("data-hf-inner-root") === "true",
          };
        };
        const diagnostic = {
          reason: hostLoaded ? "child-count" : "not-loaded",
          phase,
          caller,
          hostId: id.slice(0, 64),
          sourceSha256: row(id).sourceSha256,
          loaded: hostLoaded,
          pending: pending.has(host),
          selected: selected.has(host),
          connected: host.isConnected,
          rootParent: host.parentElement === root,
          childCount: children.length,
          firstChildren: children.slice(0, 2).map(summary),
        };
        fail("incomplete mounted host; mountedHostDiagnostic=" + JSON.stringify(diagnostic));
      }
      const entry = row(id),
        shape = graph.documents[entry.source].root,
        inner = children[0];
      if (!known.has(inner)) assign(inner, shape, id, true);
    }
  };
  const available = () => {
    for (const [id, host] of hosts)
      if (loaded.has(host) && host.children.length === 1 && !known.has(host.children[0]))
        assign(host.children[0], graph.documents[row(id).source].root, id, true);
  };
  const treeGuard = (loaderPhase: string, targets: Element[]) => {
    phase = ["before-mount", "mounted", "scripts-complete", "validate"].includes(loaderPhase)
      ? "guard:" + loaderPhase
      : "guard:unknown";
    live();
    rootAuth();
    requireInertStyle();
    if (!["before-mount", "mounted", "scripts-complete", "validate"].includes(loaderPhase))
      fail("unknown loader phase");
    if (loaderPhase === "before-mount") {
      mountStarted = true;
      scan();
      if (pending.size) fail("unfinished prior source batch");
      for (const host of targets) {
        hostCheck(host);
        if (pending.has(host) || loaded.has(host)) fail("host remount");
        pending.add(host);
      }
      if (pending.size > 16) fail("fetch count bound");
    } else {
      if (pending.size || loaded.size !== hosts.size) fail("incomplete source loads");
      prepareMounted("treeGuard");
      scan();
      if (loaderPhase === "scripts-complete" && registered.size !== hosts.size + 1)
        fail("incomplete script publication");
    }
  };
  const instanceFetch = async (host: Element, src: string) => {
    phase = "instance-fetch";
    live();
    const expected = hostCheck(host);
    requireInertStyle();
    if (
      !pending.has(host) ||
      loaded.has(host) ||
      typeof src !== "string" ||
      ![expected.source, new URL(expected.source, "https://avc.invalid/").href].includes(src)
    )
      fail("unplanned instance fetch");
    pending.delete(host);
    loaded.add(host);
    return expected.source;
  };
  /** Prepared C23-only source authority. A scalar id, never a caller selector/document callback. */
  const instanceSourceRootId = (host: Element, src: string): string => {
    phase = "source-root-selection";
    live();
    const expected = hostCheck(host);
    requireInertStyle();
    const source = graph.documents[expected.source],
      authoredId = source?.record.authoredId;
    if (
      !loaded.has(host) ||
      pending.has(host) ||
      selected.has(host) ||
      host.children.length !== 0 ||
      typeof src !== "string" ||
      src !== expected.source ||
      !source ||
      typeof authoredId !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,55}$/.test(authoredId) ||
      source.root.tag !== "DIV" ||
      source.root.attributes.id !== authoredId ||
      source.root.attributes["data-composition-id"] !== authoredId ||
      expected.authoredId !== authoredId
    )
      fail("source root selection ownership/identity");
    selected.add(host);
    return authoredId;
  };
  const instanceArmScript = (host: Element, script: HTMLScriptElement) => {
    phase = "arm-script";
    live();
    const expected = hostCheck(host);
    requireInertStyle();
    if (
      !loaded.has(host) ||
      armed ||
      injected.has(script) ||
      script.isConnected ||
      script.src ||
      script.type ||
      script.tagName !== "SCRIPT" ||
      typeof script.textContent !== "string" ||
      !script.textContent.includes(graph.documents[expected.source].record.script.trim())
    )
      fail("script arm ownership/payload");
    // The only caller holds C runtime private capability. Text containment is an
    // additional consistency check, NOT independent wrapper authenticity proof.
    if (Object.hasOwn(window, "__avcPrivateInstanceAcquire")) fail("private acquisition shadow");
    armed = { host, script, consumed: false };
    injected.add(script);
    scriptTexts.set(script, script.textContent);
    Object.defineProperty(window, "__avcPrivateInstanceAcquire", {
      configurable: true,
      value: (current: Element) => {
        live();
        if (
          !armed ||
          armed.host !== host ||
          armed.script !== current ||
          current !== document.currentScript ||
          !current.isConnected ||
          current.parentElement !== document.body ||
          armed.consumed ||
          Object.hasOwn(window, "__avcPrivateInstanceAcquire")
        )
          fail("one-shot acquisition identity/deletion");
        armed!.consumed = true;
        const facade = new Proxy(Object.create(null), {
          get(_target, key) {
            if (key !== expected.authoredId) fail("leaf registry read outside owner");
            return registryValues[expected.id];
          },
          set(_target, key, value) {
            if (key !== expected.authoredId || document.currentScript !== script)
              fail("leaf registry publication authority");
            publish(expected.id, value);
            armed = undefined;
            return true;
          },
          defineProperty() {
            return fail("leaf registry define");
          },
          deleteProperty() {
            return fail("leaf registry delete");
          },
          setPrototypeOf() {
            return fail("leaf registry prototype");
          },
        });
        return Object.freeze({ registry: facade, fail });
      },
    });
  };
  const instancePrepareMedia = (assignIds: (document: Document) => unknown) => {
    phase = "prepare-media";
    live();
    rootAuth();
    requireInertStyle();
    prepareMounted("instancePrepareMedia");
    scan();
    if (typeof assignIds !== "function") fail("native media assigner");
    assignIds(document);
    const media = [...document.querySelectorAll("audio,video")],
      ids = new Set();
    if (media.length !== graph.mediaCount) fail("expanded native media count");
    for (const element of media) {
      const entry = known.get(element),
        id = element.getAttribute("data-hf-render-id");
      if (!entry || entry.owner === graph.rootId || !id || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || ids.has(id))
        fail("native media render identity");
      ids.add(id);
      entry!.id = id;
    }
    scan();
  };
  const treeNormalize = (normalizationPhase: string, nodes: Element[]) => {
    phase =
      normalizationPhase === "before"
        ? "normalize:before"
        : normalizationPhase === "after"
          ? "normalize:after"
          : "normalize:unknown";
    live();
    rootAuth();
    requireInertStyle();
    if (
      !Array.isArray(nodes) ||
      new Set(nodes).size !== nodes.length ||
      nodes.length > 16 ||
      nodes.some(
        (node) =>
          !hosts.has(node.getAttribute("data-composition-id") ?? "") ||
          hosts.get(node.getAttribute("data-composition-id")!) !== node,
      )
    )
      fail("normalization node authority");
    if (normalizationPhase === "before") {
      if (normalizing) fail("repeated normalization pending");
      for (const node of nodes) {
        hostCheck(node);
        if (node.hasAttribute("data-end") || node.hasAttribute("data-hf-authored-end"))
          fail("normalization end metadata");
        if (
          normalized.has(node)
            ? node.hasAttribute("data-duration") ||
              node.getAttribute("data-hf-authored-duration") !== known.get(node)?.attributes["data-duration"]
            : !node.hasAttribute("data-duration") ||
              node.getAttribute("data-duration") !== known.get(node)?.attributes["data-duration"] ||
              node.hasAttribute("data-hf-authored-duration")
        )
          fail("raw normalization metadata");
      }
      normalizing = nodes.slice();
    } else if (normalizationPhase === "after") {
      if (!normalizing || nodes.length !== normalizing.length || nodes.some((node, i) => node !== normalizing![i]))
        fail("normalization callback changed");
      for (const node of nodes) {
        hostCheck(node);
        const entry = known.get(node);
        if (
          node.hasAttribute("data-duration") ||
          node.getAttribute("data-hf-authored-duration") !== entry?.attributes["data-duration"] ||
          node.hasAttribute("data-end") ||
          node.hasAttribute("data-hf-authored-end")
        )
          fail("normalized metadata");
        normalized.add(node);
      }
      normalizing = undefined;
    } else fail("unknown normalization phase");
  };
  const instanceClipId = (element: Element) => {
    phase = "clip-id";
    live();
    rootAuth();
    requireInertStyle();
    scan();
    const entry = known.get(element);
    if (!entry || !element.isConnected || entry.parent !== element.parentElement)
      fail("unknown/changed collectible Element");
    return entry!.id;
  };
  const treeReady = () => {
    treeGuard("validate", []);
    if (
      armed ||
      normalizing ||
      normalized.size !== hosts.size ||
      registered.size !== hosts.size + 1 ||
      Object.hasOwn(window, "__avcPrivateInstanceAcquire")
    )
      fail("incomplete instance lifecycle");
    if (window.__clipManifest?.durationSeconds !== graph.rootDuration) fail("root manifest duration");
    const clipIds = new Set<string>();
    for (const clip of window.__clipManifest!.clips) {
      if (clip.id === null) continue;
      if (
        clipIds.has(clip.id) ||
        ![...knownElements].map((element) => known.get(element)!).some((value) => value.id === clip.id)
      )
        fail("manifest clip ownership");
      clipIds.add(clip.id);
    }
  };
  const treeMediaGuard = (element: Element, start: number, end: number) => {
    phase = "media-guard";
    live();
    rootAuth();
    requireInertStyle();
    const entry = known.get(element);
    if (!entry || !["AUDIO", "VIDEO"].includes(entry.tag) || entry.owner === graph.rootId)
      fail("native descriptor Element authority");
    const expected = row(entry!.owner);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > graph.rootDuration ||
      start < expected.windowStart ||
      end > expected.windowEnd
    )
      fail("native descriptor outside ancestor window");
  };
  const instanceRegisterFrame = (video: Element, image: Element) => {
    phase = "register-frame";
    live();
    rootAuth();
    requireInertStyle();
    available();
    if (
      !known.has(video) ||
      known.get(video)!.tag !== "VIDEO" ||
      image.tagName !== "IMG" ||
      frames.has(image) ||
      video.nextElementSibling !== image ||
      image.parentElement !== video.parentElement ||
      image.id !== "__render_frame_" + video.getAttribute("data-hf-render-id") + "__"
    )
      fail("private frame ownership");
    frames.set(image, video);
    knownElements.add(image);
    known.set(image, {
      id: null,
      owner: known.get(video)!.owner,
      attributes: attrs(image),
      text: "",
      parent: image.parentElement,
      tag: "IMG",
      css: {},
      children: [],
    });
  };
  const dispose = () => {
    dead = true;
    inertStyle = undefined;
    inertSheet = undefined;
    armed = undefined;
    normalizing = undefined;
    delete window.__avcPrivateInstanceAcquire;
    pending.clear();
    loaded.clear();
    selected.clear();
    normalized.clear();
    hosts.clear();
    frames.clear();
    injected.clear();
    scriptTexts.clear();
    knownElements.clear();
    registered.clear();
  };
  return {
    instanceRegisterInertStyle,
    treeGuard,
    treeNormalize,
    treeReady,
    treeMediaGuard,
    instanceFetch,
    instanceSourceRootId,
    instanceArmScript,
    instancePrepareMedia,
    instanceClipId,
    instanceRegisterFrame,
    dispose,
  };
}
export function instancesPrelude(graph: InstanceGraph) {
  return `const __name=(fn)=>fn,instanceController=(${createInstanceController.toString()})(${JSON.stringify(graph)},document,window,refuse);const {instanceRegisterInertStyle,treeGuard,treeNormalize,treeReady,treeMediaGuard,instanceSourceRootId,instanceArmScript,instancePrepareMedia,instanceClipId,instanceRegisterFrame}=instanceController;const instanceFetch=async(host,src)=>localFetch(await instanceController.instanceFetch(host,src));`;
}
