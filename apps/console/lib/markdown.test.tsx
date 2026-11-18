import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown, parseBlocks } from "./markdown";

describe("safe Markdown", () => {
  it("parses headings, lists, code and paragraphs", () => {
    expect(
      parseBlocks("# Title\n\nSome *text*.\n- one\n- two\n1. first\n```\ncode <b>\n```").map((block) => block.type),
    ).toEqual(["heading", "paragraph", "list", "list", "code"]);
  });

  it("renders inline marks as elements and everything else as text", () => {
    const { container } = render(
      <Markdown
        source={
          "Use **bold**, `code` and [docs](https://example.com) but not [x](javascript:alert(1)) or <script>alert(1)</script>"
        }
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com");
    expect(links[0]?.getAttribute("rel")).toContain("noopener");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});
