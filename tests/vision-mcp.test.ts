import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test(
  "actual MCP builds and verifies a scoped review; nested request cannot escape the workspace",
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "vision mcp ")),
      outside = mkdtempSync(path.join(tmpdir(), "vision outside "));
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });
    const input = path.join(root, "source.mp4");
    assert.equal(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:r=30:d=1",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        input,
      ]).status,
      0,
    );
    writeFileSync(path.join(root, "request.json"), JSON.stringify({ input: "source.mp4", count: 2, profile: "ui" }));
    const repo = path.resolve(import.meta.dirname, ".."),
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "src/mcp/stdio.ts"), "--root", root],
        cwd: root,
        stderr: "pipe",
      });
    const client = new Client({ name: "vision-contract-test", version: "1.0.0" });
    const body = (value: unknown) => {
      const response = value as { content: Array<{ type: string; text?: string }> };
      return JSON.parse(response.content.find((c) => c.type === "text")!.text!) as {
        ok: boolean;
        metadata: { manifest: string; source: { kind: string }; returned: number; metadataBounded: boolean };
        message?: string;
      };
    };
    try {
      await client.connect(transport);
      const created = body(
        await client.callTool({ name: "avc_vision_pack", arguments: { request: "request.json", output: "review" } }),
      );
      assert.equal(created.ok, true, JSON.stringify(created));
      const inspected = body(
        await client.callTool({
          name: "avc_vision_inspect",
          arguments: { manifest: created.metadata.manifest, limit: 1 },
        }),
      );
      assert.equal(inspected.ok, true, JSON.stringify(inspected));
      assert.equal(inspected.metadata.returned, 1);
      assert.equal(inspected.metadata.source.kind, "video");
      assert.equal(inspected.metadata.metadataBounded, true);
      writeFileSync(path.join(outside, "private.mp4"), "not to be read");
      writeFileSync(path.join(root, "escape.json"), JSON.stringify({ input: path.join(outside, "private.mp4") }));
      const refused = body(
        await client.callTool({ name: "avc_vision_pack", arguments: { request: "escape.json", output: "refused" } }),
      );
      assert.equal(refused.ok, false);
      assert.match(refused.message!, /escapes/);
    } finally {
      await client.close();
      await transport.close();
    }
  },
);
