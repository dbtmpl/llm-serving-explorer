import React from "react";

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      tokens.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      tokens.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      tokens.push(<code key={key++}>{token.slice(1, -1)}</code>);
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    tokens.push(text.slice(lastIdx));
  }
  return tokens;
}

export const NarrativeRenderer: React.FC<{ markdown: string }> = ({ markdown }) => {
  const lines = markdown.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    if (listOrdered) {
      blocks.push(
        <ol key={key++}>
          {listItems.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>
      );
    } else {
      blocks.push(
        <ul key={key++}>
          {listItems.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
    }
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    if (line.startsWith("### ")) {
      flushList();
      blocks.push(<h3 key={key++}>{renderInlineMarkdown(line.slice(4))}</h3>);
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      blocks.push(<h2 key={key++}>{renderInlineMarkdown(line.slice(3))}</h2>);
      continue;
    }
    if (line.startsWith("# ")) {
      flushList();
      blocks.push(<h1 key={key++}>{renderInlineMarkdown(line.slice(2))}</h1>);
      continue;
    }

    const unorderedMatch = /^[-*]\s+(.*)$/.exec(line);
    if (unorderedMatch) {
      if (listItems.length > 0 && listOrdered) {
        flushList();
      }
      listOrdered = false;
      listItems.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = /^\d+\.\s+(.*)$/.exec(line);
    if (orderedMatch) {
      if (listItems.length > 0 && !listOrdered) {
        flushList();
      }
      listOrdered = true;
      listItems.push(orderedMatch[1]);
      continue;
    }

    flushList();
    blocks.push(<p key={key++}>{renderInlineMarkdown(line)}</p>);
  }

  flushList();

  return <div className="narrative-box">{blocks}</div>;
};
