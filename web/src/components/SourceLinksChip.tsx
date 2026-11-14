import React from "react";
import { lookupGlossary } from "../data/glossary.js";
import { InfoHint } from "./GlossaryModal.js";

export const BLIS_COMMIT = "c79c745619b16a8019339e3bbc79ee5e2923b258";

export interface SourceLinkItem {
  readonly path: string;
  readonly label: string;
  readonly glossaryTerm?: string;
}

export interface SourceLinksChipProps {
  readonly links: readonly SourceLinkItem[];
  readonly title?: string;
  readonly glossaryTerm?: string;
  readonly commit?: string;
}

export function blisSourceUrl(path: string, commit: string = BLIS_COMMIT): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `https://github.com/inference-sim/inference-sim/blob/${commit}/${cleanPath}`;
}

export const SourceLinksChip: React.FC<SourceLinksChipProps> = ({
  links,
  title = "BLIS Source",
  glossaryTerm,
  commit = BLIS_COMMIT
}) => {
  if (links.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="source-links-chip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        padding: "5px 10px",
        background: "var(--bg-inset)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        fontSize: 11.5,
        color: "var(--text-secondary)"
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          color: "var(--text-muted)",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          fontSize: 10.5
        }}
      >
        <span>{title}</span>
        {glossaryTerm && <InfoHint term={glossaryTerm} />}
      </span>

      {links.map((link) => {
        const entry = link.glossaryTerm ? lookupGlossary(link.glossaryTerm) : undefined;
        const tooltip = entry
          ? `${link.path} — ${entry.term}: ${entry.definition}`
          : `${link.label} (${link.path} @ ${commit.slice(0, 8)})`;
        return (
          <span
            key={link.path}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 7px",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6
            }}
          >
            <a
              href={blisSourceUrl(link.path, commit)}
              target="_blank"
              rel="noopener noreferrer"
              title={tooltip}
              style={{
                color: "var(--accent-primary)",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 5
              }}
            >
              <span>{link.label}</span>
              <code
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: "var(--text-secondary)"
                }}
              >
                {link.path}
              </code>
            </a>
            {link.glossaryTerm && <InfoHint term={link.glossaryTerm} />}
          </span>
        );
      })}
    </div>
  );
};
