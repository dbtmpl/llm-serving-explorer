/** Renders the markup of src/content (bold, code, links, citation links, formulas, tables) as React nodes. */
import katex from "katex";
import "katex/dist/katex.min.css";
import type { ReactNode } from "react";
import { blocks, parseInline, paragraphs, type Inline } from "../content/index.js";

/** Typeset TeX with KaTeX (HTML for the eye, MathML for screen readers); throws on a mistake in the formula. */
export const typeset = (tex: string, display: boolean): string => katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "error", output: "htmlAndMathml" });

function Tex({ tex, display }: { tex: string; display: boolean }) {
  const Tag = display ? "div" : "span";
  return <Tag className={display ? "lv-formula" : "lv-tex"} dangerouslySetInnerHTML={{ __html: typeset(tex, display) }} />;
}

function nodes(items: Inline[]): ReactNode[] {
  return items.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "bold":
        return <strong key={i}>{nodes(n.children)}</strong>;
      case "code":
        return <code key={i}>{n.text}</code>;
      case "math":
        return <Tex key={i} tex={n.tex} display={false} />;
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
 * Otherwise one `<p className={className}>` per paragraph, a typeset formula per `$$ ... $$` block
 * and a table per pipe table.
 */
export function Rich({ text, inline, className }: { text: string; inline?: boolean; className?: string }) {
  if (inline) return <>{nodes(parseInline(paragraphs(text).join(" ")))}</>;
  return (
    <>
      {blocks(text).map((b, i) => {
        if (b.type === "formula") return <Tex key={i} tex={b.tex} display />;
        if (b.type === "table")
          return (
            <div key={i} className="lv-table-wrap">
              <table className="lv-table">
                <thead>
                  <tr>
                    {b.head.map((h, j) => (
                      <th key={j}>{nodes(parseInline(h))}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        <td key={k}>{nodes(parseInline(c))}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        return (
          <p key={i} className={className}>
            {nodes(parseInline(b.text))}
          </p>
        );
      })}
    </>
  );
}
