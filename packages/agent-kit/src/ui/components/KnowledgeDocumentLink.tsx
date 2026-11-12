import { useState, type ReactNode } from "react";

export function KnowledgeDocumentLink({ libraryId, chunkId, hash, children }: { libraryId: string; chunkId: number; hash: string; children: ReactNode }) {
  const [error, setError] = useState("");
  const api = (window as Window & { launcher?: { knowledge?: { revealDocument?: (libraryId: string, chunkId: number, hash: string) => Promise<void> } } }).launcher?.knowledge;
  return <span style={{ display: "block" }}><button type="button" disabled={!api?.revealDocument} style={{ color: "var(--accent, #6b5bd2)", background: "none", border: 0, padding: 0, cursor: "pointer", textDecoration: "underline", font: "inherit" }} onClick={() => {
    setError("");
    void api?.revealDocument?.(libraryId, chunkId, hash).catch(() => setError("文档不可用，可能已移动或移除。"));
  }}>{children}</button>{error && <span role="alert"> {error}</span>}</span>;
}
