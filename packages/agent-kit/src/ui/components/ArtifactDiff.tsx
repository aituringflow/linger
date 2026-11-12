"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CloseIcon } from "../icons/SharedIcons.tsx";
import { changedSpan, compareArtifact, foldDiffRows, numberDiffRows, type ArtifactChange, type DiffRow } from "../shared/artifactDiffModel.ts";
export type { ArtifactChange, ArtifactType } from "../shared/artifactDiffModel.ts";

function lineText(line: string): string { return line.replace(/\r?\n$/, ""); }

function renderLine(row: DiffRow, side: "left" | "right"): ReactNode {
  const cell = row[side];
  if (!cell) return null;
  const text = lineText(cell.line);
  const modified = row.left?.kind === "del" && row.right?.kind === "add";
  let content: ReactNode = text;
  if (modified) {
    const span = changedSpan(lineText(row.left!.line), lineText(row.right!.line));
    const end = side === "left" ? span.oldEnd : span.newEnd;
    content = <>{text.slice(0, span.start)}<mark className={`diff-inline diff-inline--${side === "left" ? "del" : "add"}`}>{text.slice(span.start, end)}</mark>{text.slice(end)}</>;
  }
  return <><span className="diff-line-content">{content || "\u00a0"}</span>{!cell.line.endsWith("\n") ? <span className="diff-no-newline" title="文件末尾没有换行符">↵ 无末尾换行</span> : null}</>;
}

export function ArtifactDiffPanel({ changes, activeId, onSelect, onClose }: {
  changes: ArtifactChange[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const active = changes.find((change) => change.id === activeId) ?? changes[0];
  const comparison = useMemo(() => active ? compareArtifact(active) : null, [active]);
  const [selection, setSelection] = useState<{ comparison: typeof comparison; full: boolean; expanded: number[] }>({ comparison: null, full: false, expanded: [] });
  const numbered = useMemo(() => numberDiffRows(comparison?.rows ?? []), [comparison]);
  const folded = useMemo(() => foldDiffRows(numbered), [numbered]);
  if (!active || !comparison) return <div className="diff-nocontent">当前没有文件变更</div>;
  const view: { full: boolean; expanded: number[] } = selection.comparison === comparison ? selection : { full: false, expanded: [] };
  const sections = view.full ? [{ kind: "rows" as const, rows: numbered }] : folded;
  const label = active.change === "deleted" ? "已删除" : active.change === "added" ? "新增" : "已修改";
  return (
    <div className="diff-panel">
      <div className="diff-tabs" role="tablist" aria-label="变更文件">
        {changes.map((change) => (
          <button key={change.id} type="button" role="tab" aria-selected={change.id === active.id}
            className={`diff-tab${change.id === active.id ? " is-active" : ""}`}
            onClick={() => onSelect(change.id)}
            title={`${change.change === "deleted" ? "删除" : change.change === "added" ? "新增" : "修改"} ${change.name}`}>
            <span className={`diff-tab-mark diff-tab-mark--${change.change ?? "modified"}`} aria-hidden="true">{change.change === "added" ? "+" : change.change === "deleted" ? "−" : "~"}</span>
            <span className="diff-tab-name">{change.name}</span>
          </button>
        ))}
        <span className="diff-tabs-spacer" />
        <button type="button" className="diff-close" onClick={onClose} aria-label="关闭变更视图" title="关闭变更视图">
          <CloseIcon />
        </button>
      </div>
      <div className="diff-file-head">
        <span className="diff-file-name" title={active.name}>{active.name}</span>
        <span className={`diff-change-tag diff-change-tag--${active.change ?? "modified"}`}>{label}</span>
        {comparison.available ? <span className="diff-stat"><span className="diff-stat-add">+{comparison.adds}</span> <span className="diff-stat-del">−{comparison.dels}</span> · {comparison.same} 行未变</span> : null}
      </div>
      {comparison.coarse ? <div className="diff-notice">差异较大，部分内容以整段删除和新增展示。</div> : null}
      <div className="diff-body">
        {!comparison.available ? (
          <div className="diff-nocontent">
            <span className="diff-nocontent-name">{active.name}</span>
            <span>无法显示内容对比：{!comparison.oldAvailable && !comparison.newAvailable ? "新旧内容快照均不可用" : !comparison.oldAvailable ? "缺少修改前的内容快照" : "缺少修改后的内容快照"}。</span>
            <span>二进制文件或超出快照大小限制的文件仅记录变更状态。</span>
          </div>
        ) : comparison.rows.length === 0 ? <div className="diff-nocontent">文件内容为空，没有可显示的文本行。</div> : (
          <table className="diff-table" aria-label={`${active.name} 内容对比`}>
            <colgroup><col className="diff-lineno-col" /><col /><col className="diff-lineno-col" /><col /></colgroup>
            <thead><tr><th colSpan={2}>修改前</th><th colSpan={2}>修改后</th></tr></thead>
            <tbody>
              {sections.flatMap((section) => {
                if (section.kind === "gap" && !view.expanded.includes(section.start)) return [];
                return section.rows.map(({ row, index, leftNo: ln, rightNo: rn }) => {
                const modified = row.left?.kind === "del" && row.right?.kind === "add";
                return <tr key={index} className={`diff-row${modified ? " is-modified" : ""}`}>
                  <td className={`diff-lineno${row.left?.kind === "del" ? " is-del" : ""}`}><span className="diff-line-mark" aria-label={modified ? "修改" : row.left?.kind === "del" ? "删除" : undefined}>{modified ? "~" : row.left?.kind === "del" ? "−" : ""}</span>{ln ?? ""}</td>
                  <td className={`diff-cell diff-cell--left${row.left?.kind === "del" ? " is-del" : ""}${row.left ? "" : " is-empty"}`}>{renderLine(row, "left")}</td>
                  <td className={`diff-lineno${row.right?.kind === "add" ? " is-add" : ""}`}><span className="diff-line-mark" aria-label={modified ? "修改" : row.right?.kind === "add" ? "新增" : undefined}>{modified ? "~" : row.right?.kind === "add" ? "+" : ""}</span>{rn ?? ""}</td>
                  <td className={`diff-cell diff-cell--right${row.right?.kind === "add" ? " is-add" : ""}${row.right ? "" : " is-empty"}`}>{renderLine(row, "right")}</td>
                </tr>;
                });
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
