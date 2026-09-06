import { isValidElement, memo, useDeferredValue, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

export function safeMessageUrl(value: string): string | undefined {
  if (/^#[\w-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const language = isValidElement<{ className?: string }>(children)
    ? children.props.className?.match(/language-([\w+#.-]+)/)?.[1] : undefined;
  const codeRef = useRef<HTMLPreElement>(null);
  const [copyState, setCopyState] = useState("Copy");
  return <div className="code-block">
    <div className="code-header"><span>{language ?? "Code"}</span><button type="button" aria-label="Copy code" onClick={async () => {
      try {
        await navigator.clipboard.writeText(codeRef.current?.textContent ?? "");
        setCopyState("Copied");
      } catch { setCopyState("Copy failed — try again"); }
    }}>{copyState}</button></div>
    <pre ref={codeRef} tabIndex={0} aria-label="Code block">{children}</pre>
  </div>;
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }) => <code className={className}>{children}</code>,
  table: ({ children }) => <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Response table"><table>{children}</table></div>,
  a: ({ href, children }) => href ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
  // Model-generated images must not issue background requests to third parties.
  img: ({ alt }) => <span className="attachment-line">{alt ? `Image: ${alt}` : "Image omitted"}</span>,
};

const MarkdownDocument = memo(function MarkdownDocument({ text }: { text: string }) {
  return <Markdown remarkPlugins={plugins} components={components} skipHtml urlTransform={safeMessageUrl}>{text}</Markdown>;
});

export const MessageMarkdown = memo(function MessageMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Keep input urgent while parsing the current streaming snapshot. The same
  // renderer stays mounted at completion, including an unfinished code fence.
  const deferredText = useDeferredValue(text);
  return <div className="message-text" aria-busy={streaming}>
    <MarkdownDocument text={streaming ? deferredText : text} />
  </div>;
});
