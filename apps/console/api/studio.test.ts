import { describe, expect, it, vi } from "vitest";
import { CONSOLE_TOKEN_HEADER, StudioStatusResponseSchema } from "@contract";
import { fixtureViews } from "@/lib/fixtures";
import { FixtureApiClient } from "./fixture";
import { HttpApiClient } from "./http";

const TOKEN = "b".repeat(64);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Remotion Studio in the API clients (§17 amendment of D21)", () => {
  it("HttpApiClient reads the status and posts open and stop with the token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const replies = [
      json(200, { ok: true }),
      json(200, { ok: true, available: true, target: { kind: "film", entry: "src/index.ts", composition: "Film" } }),
      json(200, { ok: true, url: "http://127.0.0.1:3000/ProjectSquare", reused: false }),
      json(200, { ok: true, available: false, reason: "No build yet." }),
    ];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return replies.shift()!;
    }) as unknown as typeof globalThis.fetch;
    const client = new HttpApiClient({ fetch, fragment: { token: TOKEN }, sleep: async () => {} });
    await client.start();
    expect((await client.studioStatus("demo")).available).toBe(true);
    expect(calls[1]?.url).toBe("/api/projects/demo/studio");
    expect(calls[1]?.init.method).toBe("GET");
    expect(await client.studioOpen("demo", { format: "square" })).toEqual({
      ok: true,
      url: "http://127.0.0.1:3000/ProjectSquare",
      reused: false,
    });
    expect(calls[2]?.url).toBe("/api/projects/demo/studio");
    expect(calls[2]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ format: "square" });
    expect((calls[2]?.init.headers as Record<string, string>)[CONSOLE_TOKEN_HEADER]).toBe(TOKEN);
    expect((await client.studioStop("demo")).available).toBe(false);
    expect(calls[3]?.url).toBe("/api/projects/demo/studio/stop");
    await expect(client.studioOpen("demo", { format: "portrait" as never })).rejects.toThrow();
  });

  it("FixtureApiClient is deterministic: open, reuse, switch format, stop; films open their own composition", async () => {
    const now = () => Date.parse("2026-11-17T09:00:00Z");
    const client = new FixtureApiClient({ now });
    const footage = fixtureViews.footage.project.id;
    const before = StudioStatusResponseSchema.parse(await client.studioStatus(footage));
    expect(before.available).toBe(true);
    expect(before.running).toBeUndefined();
    const first = await client.studioOpen(footage, {});
    expect(first.reused).toBe(false);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/Project(Vertical|Square|Landscape)$/);
    expect((await client.studioOpen(footage, {})).reused).toBe(true);
    const running = await client.studioStatus(footage);
    expect(running.running).toMatchObject({
      url: first.url,
      startedAt: "2026-11-17T09:00:00.000Z",
      ...(running.target?.format ? { format: running.target.format } : {}),
    });
    const stopped = await client.studioStop(footage);
    expect(stopped.running).toBeUndefined();
    const film = await client.studioStatus(fixtureViews.filmBuild.project.id);
    expect(film.target).toEqual({ kind: "film", entry: "src/index.ts", composition: "Film" });
    expect(film.formats).toBeUndefined();
  });
});
