import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { loadCampaign } from "./store";
import { refuse, verifyPin } from "./files";
import {
  campaignReviewPin,
  campaignReviewState,
  CampaignSelectionSchema,
  saveCampaignSelection,
} from "./review-service";

/**
 * The campaign review service's standalone HTTP API (no page): state, selection and receipt-pinned `/file`, on a
 * per-process token. The console serves the campaign review (src/lib/console/review/campaign.ts, RFC 0004 WP13); this
 * server stays as the harness of the campaign review service tests.
 */
export async function startCampaignReviewServer(options: { projectId: string; rootDir?: string; port?: number }) {
  const root = path.resolve(options.rootDir ?? process.cwd()),
    id = options.projectId;
  loadCampaign(root, id);
  const token = randomBytes(32).toString("hex"),
    cookieName = `campaign_review_${token.slice(0, 12)}`;
  let origin = "";
  const state = () => campaignReviewState(root, id);
  const valid = (value: string) => {
    const bytes = Buffer.from(value);
    return bytes.length === token.length && timingSafeEqual(bytes, Buffer.from(token));
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const send = (code: number, value: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
        send(403, { message: "Invalid host or origin" });
        return;
      }
      const url = new URL(req.url ?? "/", origin);
      const cookie =
        String(req.headers.cookie ?? "")
          .split(";")
          .map((item) => item.trim())
          .find((item) => item.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1) ?? "";
      if (
        !valid(String(req.headers["x-review-token"] ?? "")) &&
        !(url.pathname === "/file" && ["GET", "HEAD"].includes(req.method ?? "") && valid(cookie))
      ) {
        send(403, { message: "Session token required" });
        return;
      }
      if (req.method === "POST" && req.headers.origin !== origin) {
        send(403, { message: "Same-origin mutation required" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/file`);
        send(200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        send(200, state());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/selection") {
        if (req.headers["content-type"] !== "application/json") refuse("JSON content type required");
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 65536) refuse("Review selection is too large");
          chunks.push(chunk);
        }
        const result = saveCampaignSelection(
          root,
          id,
          CampaignSelectionSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        );
        if ("conflict" in result) {
          send(409, { message: result.conflict });
          return;
        }
        const saved = result.saved;
        send(200, saved);
        return;
      }
      if (["GET", "HEAD"].includes(req.method ?? "") && url.pathname === "/file") {
        const pin = campaignReviewPin(root, id, url.searchParams.get("path"));
        const file = verifyPin(root, pin),
          size = statSync(file).size;
        let start = 0,
          end = size - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            res.end();
            return;
          }
          if (!match[1]) start = Math.max(0, size - Number(match[2]));
          else {
            start = Number(match[1]);
            if (match[2]) end = Math.min(end, Number(match[2]));
          }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            res.end();
            return;
          }
        }
        res.writeHead(req.headers.range ? 206 : 200, {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          ...(req.headers.range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        const stream = createReadStream(file, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
        return;
      }
      send(404, { message: "Unknown campaign review route" });
    } catch (error) {
      send(400, { message: error instanceof Error ? error.message : "Campaign review failed" });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Campaign review listener unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, url: `${origin}/#${token}` };
}
