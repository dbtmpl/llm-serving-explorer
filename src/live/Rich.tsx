/** Renders the inline markup of src/content (bold, code, links, citation links) as React nodes. */
import type { ReactNode } from "react";
import { paragraphs, parseInline, type Inline } from "../content/index.js";

function nodes(items: Inline[]): ReactNode[] {
  return items.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "bold":
        return <strong key={i}>{nodes(n.children)}</strong>;
      case "code":
        return <code key={i}>{n.text}</code>;
      case "link":
        // a link inside a clickable callout must not also select the node
        return (
          <a key={i} className="lv-link" href={n.href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            {n.text}
          </a>
        );
    }
  });
}

/**
 * `inline`: only the inline nodes, for the caller to wrap (titles, a paragraph the caller owns).
 * Otherwise one `<p className={className}>` per paragraph of the text.
 */
export function Rich({ text, inline, className }: { text: string; inline?: boolean; className?: string }) {
  if (inline) return <>{nodes(parseInline(paragraphs(text).join(" ")))}</>;
  return (
    <>
      {paragraphs(text).map((p, i) => (
        <p key={i} className={className}>
          {nodes(parseInline(p))}
        </p>
      ))}
    </>
  );
}
