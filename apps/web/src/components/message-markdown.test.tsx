import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "./message-markdown";
import { ChatMessage } from "./chat-message";
import type { UIMessage } from "ai";

const sample = "# DevStash\n\n## Tech stack\n\n| Layer | Choice |\n| --- | --- |\n| Framework | **Next.js** |\n| Database | PostgreSQL |\n\n### Next steps\n\n- [x] Read the schema\n- [ ] Verify billing\n  - Check webhook validation\n\n```ts\nconst safe = true;\n```";

describe("response markdown", () => {
  test("uses identical structured markup while streaming and at completion", () => {
    const stream = renderToStaticMarkup(<MessageMarkdown text={sample} streaming />);
    const done = renderToStaticMarkup(<MessageMarkdown text={sample} />);
    expect(stream.replace('aria-busy="true"', 'aria-busy="false"')).toBe(done);
    for (const element of ["<table>", "<thead>", "<tbody>", "<h1>", "<h2>", "<h3>", "<strong>", '<input type="checkbox"']) expect(done).toContain(element);
    expect(done).toContain("Next.js");
  });
  test("keeps unfinished code fences in a code block", () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'```ts\nconst value = "in progress";'} streaming />);
    expect(html).toContain("<pre");
    expect(html).toContain("language-ts");
    expect(html).not.toContain("```ts");
  });
  test("supports nested lists, strikethrough, and escaped table pipes", () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'- Parent\n  - Child\n\n~~obsolete~~\n\n| Key | Value |\n|---|---|\n| a\\|b | `value` |'} />);
    expect(html.match(/<ul>/g)?.length).toBe(2);
    expect(html).toContain("<del>obsolete</del>");
    expect(html).toContain("a|b");
  });
  test("blocks unsafe URLs, raw HTML, and remote image requests", () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'[bad](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n![tracking](https://evil.example/pixel)\n\n[ok](https://example.com)'} />);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).toContain('href="https://example.com/"');
  });
  test("renders paths literally instead of italicizing underscore segments", () => {
    const html = renderToStaticMarkup(<MessageMarkdown text="src/my_file_name.ts" />);
    expect(html).toContain("src/my_file_name.ts");
    expect(html).not.toContain("<em>");
  });
});

test("completed tools are grouped without hiding failed or approval-required calls", () => {
  const message: UIMessage = { id: "qa", role: "assistant", parts: [
    { type: "dynamic-tool", toolName: "read_file", toolCallId: "1", state: "output-available", input: { path: "one" }, output: "private large output" },
    { type: "dynamic-tool", toolName: "read_file", toolCallId: "2", state: "output-available", input: { path: "two" }, output: "two" },
    { type: "dynamic-tool", toolName: "read_file", toolCallId: "3", state: "output-error", input: {}, errorText: "Permission denied" },
    { type: "dynamic-tool", toolName: "shell", toolCallId: "4", state: "approval-requested", input: {}, approval: { id: "approval-1" } },
  ] };
  const html = renderToStaticMarkup(<ChatMessage message={message} />);
  expect(html).toContain("2 completed tool calls");
  expect(html).not.toContain("private large output");
  expect(html).toContain("Permission denied");
  expect(html).toContain("Approval needed");
});
