// An agent's reply as formatted text: GitHub-flavoured markdown (lists,
// tables, code, links), with any raw HTML in it shown as text, never run.
// Replies quote web pages, connector results and files the agent read, so
// HTML in them is not trusted to render in the app that holds the device
// cookie. Tables scroll sideways in their own box; code blocks have Copy.

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy code"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => {},
        )
      }
      className="absolute top-1.5 right-1.5 grid size-8 place-items-center rounded-md text-code-text/70 hover:text-code-text"
    >
      {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node as { props: { children?: unknown } }).props.children);
  return '';
};

// Raw HTML would otherwise be dropped silently; show it as the text it is.
type MdNode = { type: string; value?: string; children?: MdNode[] };
function htmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === 'html') node.type = 'text';
    node.children?.forEach(walk);
  };
  return walk;
}

const components: Components = {
  p: ({ children }) => <p className="my-0">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline decoration-border underline-offset-2"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-0 flex list-disc flex-col gap-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-0 flex list-decimal flex-col gap-1 pl-5">{children}</ol>,
  h1: ({ children }) => <p className="my-0 font-semibold">{children}</p>,
  h2: ({ children }) => <p className="my-0 font-semibold">{children}</p>,
  h3: ({ children }) => <p className="my-0 font-semibold">{children}</p>,
  h4: ({ children }) => <p className="my-0 font-semibold">{children}</p>,
  blockquote: ({ children }) => (
    <blockquote className="my-0 border-l-2 border-border pl-3 text-subtle">{children}</blockquote>
  ),
  code: ({ className, children }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded-[5px] bg-muted px-1 py-px font-mono text-[0.86em] break-words">{children}</code>
    ),
  pre: ({ children }) => (
    <div className="relative">
      <pre className="my-0 overflow-x-auto rounded-xl bg-code-bg p-3 pr-10 font-mono text-[12.5px] leading-relaxed text-code-text">
        {children}
      </pre>
      <CopyButton text={textOf(children)} />
    </div>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="bg-muted px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="border-t border-border px-2.5 py-1.5 align-top">{children}</td>,
  hr: () => <hr className="my-1 border-border" />,
  img: ({ alt }) => <span className="text-muted-foreground">[image: {alt}]</span>,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, htmlAsText]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
