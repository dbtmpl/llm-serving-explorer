import React, { useMemo, useState } from "react";
import { GLOSSARY_ENTRIES, lookupGlossary } from "../data/glossary.js";

export const InfoHint: React.FC<{ term: string }> = ({ term }) => {
  const entry = lookupGlossary(term);
  if (!entry) {
    return null;
  }
  return (
    <span className="info-hint" title={`${entry.term}: ${entry.definition}`} aria-label={entry.term}>
      ?
    </span>
  );
};

export interface GlossaryModalProps {
  open: boolean;
  onClose: () => void;
}

export const GlossaryModal: React.FC<GlossaryModalProps> = ({ open, onClose }) => {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GLOSSARY_ENTRIES;
    return GLOSSARY_ENTRIES.filter(
      (e) =>
        e.term.toLowerCase().includes(q) ||
        e.shortLabel.toLowerCase().includes(q) ||
        e.definition.toLowerCase().includes(q)
    );
  }, [query]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="glossary-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Inference Serving Glossary"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="glossary-panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Glossary (BLIS &amp; vLLM Terms)</h2>
          <button type="button" onClick={onClose} data-testid="close-glossary">
            Close
          </button>
        </div>
        <input
          type="search"
          placeholder="Filter terms (e.g. KV Block, TTFT, Preemption)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {filtered.map((entry) => (
          <div key={entry.term} className="glossary-item">
            <div className="glossary-term">{entry.term}</div>
            <div className="glossary-def">{entry.definition}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
