import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin } from "../cli";
import { reviewHash } from "./review-pack";

const [packetFile, log] = process.argv.slice(2);
if (!packetFile || !log) throw new Error("Missing evaluation packet.");
const packet = JSON.parse(readFileSync(packetFile, "utf8")) as {
  brief: string;
  metadata: unknown;
  assets: Array<{ id: string; path: string; sha256: string }>;
};
const root = path.dirname(packetFile);
serveStdio(
  () => {
    const server = new McpServer({ name: "vision-review", version: "1.0.0" });
    server.registerTool(
      "read_manifest",
      {
        description: "Read the review question and available evidence IDs. No answer key is provided.",
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true },
      },
      async () => {
        appendFileSync(log, JSON.stringify({ tool: "read_manifest", status: "delivered" }) + "\n");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                brief: packet.brief,
                metadata: packet.metadata,
                images: packet.assets.map((asset) => ({ id: asset.id })),
              }),
            },
          ],
        };
      },
    );
    server.registerTool(
      "read_image",
      {
        description: "Open a pinned review image by ID. This returns the image, not a description.",
        inputSchema: z.object({ id: z.string().max(100) }).strict(),
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        const asset = packet.assets.find((asset) => asset.id === id);
        if (!asset) throw new Error("Unknown image ID.");
        const file = path.resolve(root, asset.path);
        assertPathWithin(root, file);
        const actual = reviewHash(file);
        if (actual !== asset.sha256) {
          appendFileSync(log, JSON.stringify({ tool: "read_image", id, status: "hash-mismatch" }) + "\n");
          throw new Error("Image integrity check failed; this evidence is invalid.");
        }
        const bytes = readFileSync(file);
        appendFileSync(
          log,
          JSON.stringify({ tool: "read_image", id, sha256: actual, bytes: bytes.length, status: "delivered" }) + "\n",
        );
        return {
          content: [
            { type: "image", mimeType: "image/png", data: bytes.toString("base64") },
            { type: "text", text: JSON.stringify({ id, sha256: actual }) },
          ],
        };
      },
    );
    return server;
  },
  { onerror: (error) => process.stderr.write(error.message + "\n") },
);
