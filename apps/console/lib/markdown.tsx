/**
 * Safe Markdown for agent card bodies (RFC 0004 D14, §6.4): a small subset rendered to React elements, never to HTML.
 * The contract already refuses tag-like `<` in agent Markdown; this renderer still treats every character as text.
 * Supported: paragraphs, `#`–`###` headings, `-`/`*`/`1.` lists, fenced code, `**bold**`, `*italic*`, `` `code` ``
 * and `[text](https://…)` links (http and https only; anything else stays text).
 */
import { Fragment, type ReactNode } from "react";

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^```/.test(line.trim())) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test((lines[i] ?? "").trim()); i++) code.push(lines[i] ?? "");
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!.trim() });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const last = blocks.at(-1);
      if (last?.type === "list" && last.ordered === ordered) last.items.push(item[3]!);
      else blocks.push({ type: "list", ordered, items: [item[3]!] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={key}>{renderInline(part.slice(2, -2), key)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = link[2]!;
      if (/^https?:\/\//i.test(href))
        return (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-link underline underline-offset-2"
          >
            {link[1]}
          </a>
        );
      return <Fragment key={key}>{link[1]}</Fragment>;
    }
    if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_")))
      if (part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>;
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={["space-y-2 text-sm leading-relaxed break-words", className].filter(Boolean).join(" ")}>
      {blocks.map((block, index) => {
        const key = `b-${index}`;
        switch (block.type) {
          case "heading": {
            const Tag = (["h3", "h4", "h5"] as const)[block.level - 1]!;
            return (
              <Tag key={key} className="font-semibold">
                {renderInline(block.text, key)}
              </Tag>
            );
          }
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={key} className={block.ordered ? "list-decimal space-y-1 ps-5" : "list-disc space-y-1 ps-5"}>
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </Tag>
            );
          }
          case "code":
            return (
              <pre
                key={key}
                tabIndex={0}
                className="overflow-x-auto focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none rounded-md bg-muted p-3 font-mono text-xs"
              >
                <code>{block.text}</code>
              </pre>
            );
          case "paragraph":
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
