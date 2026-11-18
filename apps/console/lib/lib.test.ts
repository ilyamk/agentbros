import { describe, expect, it } from "vitest";
import { commandLine, formatDuration, formatRelative, formatUsd } from "./format";
import { fixtureNow, fixtureProjects, fixtureViews } from "./fixtures";
import { cspNonce, installCspNonce } from "./nonce";
import { hrefFor, parseRoute, projectHref } from "./router";
import { dictionaries } from "@/i18n";
import { mediaHref } from "@/media";

describe("router", () => {
  it("parses and builds hash routes", () => {
    expect(parseRoute("")).toEqual({ name: "home" });
    expect(parseRoute("#/settings")).toEqual({ name: "settings" });
    expect(parseRoute("#/projects/promo-acme")).toMatchObject({
      name: "project",
      project: "promo-acme",
      view: "canvas",
    });
    expect(parseRoute("#/projects/promo-acme/history")).toMatchObject({ name: "project", view: "history" });
    expect(parseRoute("#/nope").name).toBe("not-found");
    expect(projectHref("promo-acme", "history")).toBe("#/projects/promo-acme/history");
    expect(parseRoute(hrefFor({ name: "project", project: "a-b2", view: "timeline" }))).toMatchObject({
      project: "a-b2",
      view: "timeline",
    });
  });
});

describe("nonce", () => {
  it("reads the page's csp-nonce and hands it to get-nonce's global", () => {
    const meta = document.createElement("meta");
    meta.name = "csp-nonce";
    meta.content = "abc123";
    document.head.append(meta);
    expect(installCspNonce(document)).toBe("abc123");
    expect(cspNonce()).toBe("abc123");
    expect(globalThis.__webpack_nonce__).toBe("abc123");
    meta.remove();
  });
});

describe("format", () => {
  it("never shows a past moment as the future", () => {
    expect(formatRelative("2026-11-17T09:20:00Z", Date.parse("2026-11-17T09:18:00Z"), "en-US")).toBe("now");
    expect(formatRelative("2026-11-17T09:08:00Z", Date.parse("2026-11-17T09:18:00Z"), "en-US")).toBe("10 min. ago");
  });

  it("freezes the fixture clock at the latest fixture time", () => {
    const now = fixtureNow();
    for (const view of Object.values(fixtureViews)) expect(Date.parse(view.generatedAt)).toBeLessThanOrEqual(now);
    for (const project of fixtureProjects.projects) expect(Date.parse(project.updatedAt)).toBeLessThanOrEqual(now);
  });

  it("formats money, durations and the exact command", () => {
    expect(formatUsd(3.1, "en-US")).toBe("$3.10");
    expect(formatDuration(366_000, dictionaries.en.units)).toBe("6 min");
    expect(commandLine(["pnpm", "film:approve", "--answer", "<words>"], "Yes, go")).toBe(
      'pnpm film:approve --answer "Yes, go"',
    );
  });
});

describe("media URLs", () => {
  it("match the server: /media/<id>/<path>, renders under @out/", () => {
    expect(mediaHref("promo-acme", { kind: "image", path: "frames/a b.png" })).toBe(
      "/media/promo-acme/frames/a%20b.png",
    );
    expect(mediaHref("promo-acme", { kind: "video", root: "out", path: "final.mp4" })).toBe(
      "/media/promo-acme/@out/final.mp4",
    );
  });
});
