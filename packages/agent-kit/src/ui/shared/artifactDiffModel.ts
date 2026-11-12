/** Pure file-change aggregation and text comparison shared by the UI and regression checks. */
export type ArtifactType = "html" | "markdown" | "image" | "audio" | "video" | "pdf" | "text" | "word" | "excel" | "ppt" | "other" | "dir" | "browser";

export interface ArtifactChange {
  id: string;
  name: string;
  type: ArtifactType;
  size?: number;
  change?: "added" | "modified" | "deleted";
  oldContent?: string | null;
  newContent?: string | null;
}

/** Changes are history, independent of the list of currently existing generated documents. */
export function aggregateArtifactChanges(messages: Array<{ role: string; artifacts?: ArtifactChange[] }>): ArtifactChange[] {
  const changes = new Map<string, ArtifactChange>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const current of message.artifacts ?? []) {
      const previous = changes.get(current.id);
      if (current.change === "added") {
        // Recreating a deleted path updates its final state while retaining its original baseline.
        if (previous?.change === "deleted") {
          changes.set(current.id, { ...current, change: "modified", oldContent: previous.oldContent });
        }
        continue;
      }
      if (current.change !== "modified" && current.change !== "deleted") continue;
      changes.set(current.id, {
        ...current,
        oldContent: previous ? previous.oldContent : current.oldContent,
        newContent: current.change === "deleted" ? undefined : current.newContent,
      });
    }
  }
  // A later edit that exactly restores the baseline leaves no net content change.
  return [...changes.values()].filter((change) => change.change === "deleted"
    || typeof change.oldContent !== "string" || typeof change.newContent !== "string"
    || change.oldContent !== change.newContent);
}

export interface DiffOp {
  type: "same" | "del" | "add";
  line: string;
}

export interface DiffRow {
  left?: { line: string; kind: "same" | "del" };
  right?: { line: string; kind: "same" | "add" };
}

export interface NumberedDiffRow {
  row: DiffRow;
  index: number;
  leftNo: number | null;
  rightNo: number | null;
}
export type DiffSection = { kind: "rows"; rows: NumberedDiffRow[] }
  | { kind: "gap"; start: number; rows: NumberedDiffRow[] };

/** Number before folding: hidden context must still count towards original file positions. */
export function numberDiffRows(rows: DiffRow[]): NumberedDiffRow[] {
  let leftNo = 0;
  let rightNo = 0;
  return rows.map((row, index) => ({ row, index,
    leftNo: row.left ? ++leftNo : null, rightNo: row.right ? ++rightNo : null }));
}

export function foldDiffRows(rows: NumberedDiffRow[], context = 3): DiffSection[] {
  const ranges: Array<{ start: number; end: number }> = [];
  rows.forEach(({ row }, index) => {
    if (row.left?.kind !== "del" && row.right?.kind !== "add") return;
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length, index + context + 1);
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  });
  const sections: DiffSection[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start > cursor) sections.push({ kind: "gap", start: cursor, rows: rows.slice(cursor, start) });
    sections.push({ kind: "rows", rows: rows.slice(start, end) });
    cursor = end;
  }
  if (cursor < rows.length) sections.push({ kind: "gap", start: cursor, rows: rows.slice(cursor) });
  return sections;
}

/** Keep line terminators for comparison, so a missing final newline is a real difference. */
export function splitDiffLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Bounded Myers: long files with small edits remain accurately aligned, including repeated lines.
 * Very dissimilar files fall back to explicit whole-block deletion/addition, never fake same-index alignment. */
export function computeDiff(oldLines: string[], newLines: string[]): { ops: DiffOp[]; coarse: boolean } {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const before = oldLines.slice(start, oldEnd);
  const after = newLines.slice(start, newEnd);
  const prefix: DiffOp[] = oldLines.slice(0, start).map((line) => ({ type: "same", line }));
  const suffix: DiffOp[] = oldLines.slice(oldEnd).map((line) => ({ type: "same", line }));
  const finish = (middle: DiffOp[], coarse = false) => ({ ops: [...prefix, ...middle, ...suffix], coarse });
  if (!before.length) return finish(after.map((line) => ({ type: "add", line })));
  if (!after.length) return finish(before.map((line) => ({ type: "del", line })));

  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  let work = 0;
  for (let distance = 0; distance <= before.length + after.length; distance++) {
    if (work + frontier.size > 1_000_000) break;
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      work++;
      const down = frontier.get(diagonal + 1) ?? -Infinity;
      const right = frontier.get(diagonal - 1) ?? -Infinity;
      let x = diagonal === -distance || (diagonal !== distance && right < down) ? down : right + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) { x++; y++; }
      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        const middle: DiffOp[] = [];
        for (let d = distance; d >= 0; d--) {
          const previous = trace[d];
          const k = x - y;
          const previousK = k === -d || (k !== d && (previous.get(k - 1) ?? -Infinity) < (previous.get(k + 1) ?? -Infinity)) ? k + 1 : k - 1;
          const previousX = previous.get(previousK) ?? 0;
          const previousY = previousX - previousK;
          while (x > previousX && y > previousY) {
            middle.push({ type: "same", line: before[x - 1] }); x--; y--;
          }
          if (d > 0) {
            if (x === previousX) { middle.push({ type: "add", line: after[y - 1] }); y--; }
            else { middle.push({ type: "del", line: before[x - 1] }); x--; }
          }
        }
        return finish(middle.reverse());
      }
    }
  }
  return finish([
    ...before.map((line): DiffOp => ({ type: "del", line })),
    ...after.map((line): DiffOp => ({ type: "add", line })),
  ], true);
}

export function buildDiffRows(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op.type === "same") {
      rows.push({ left: { line: op.line, kind: "same" }, right: { line: op.line, kind: "same" } });
      index++;
      continue;
    }
    const deleted: string[] = [];
    const added: string[] = [];
    while (index < ops.length && ops[index].type !== "same") {
      (ops[index].type === "del" ? deleted : added).push(ops[index].line);
      index++;
    }
    for (let k = 0; k < Math.max(deleted.length, added.length); k++) {
      rows.push({
        left: k < deleted.length ? { line: deleted[k], kind: "del" } : undefined,
        right: k < added.length ? { line: added[k], kind: "add" } : undefined,
      });
    }
  }
  return rows;
}

/** Preserve unavailable snapshots as unknown rather than incorrectly claiming every line was added/deleted. */
export function compareArtifact(change: ArtifactChange) {
  const oldAvailable = change.change === "added" || typeof change.oldContent === "string";
  const newAvailable = change.change === "deleted" || typeof change.newContent === "string";
  if (!oldAvailable || !newAvailable) return { available: false as const, oldAvailable, newAvailable, rows: [], adds: 0, dels: 0, same: 0, coarse: false };
  const oldLines = splitDiffLines(change.change === "added" ? "" : change.oldContent ?? "");
  const newLines = splitDiffLines(change.change === "deleted" ? "" : change.newContent ?? "");
  const { ops, coarse } = computeDiff(oldLines, newLines);
  return {
    available: true as const, oldAvailable, newAvailable,
    rows: coarse ? ops.map((op): DiffRow => op.type === "same"
      ? { left: { line: op.line, kind: "same" }, right: { line: op.line, kind: "same" } }
      : op.type === "del" ? { left: { line: op.line, kind: "del" } } : { right: { line: op.line, kind: "add" } }) : buildDiffRows(ops),
    coarse,
    adds: ops.filter((op) => op.type === "add").length,
    dels: ops.filter((op) => op.type === "del").length,
    same: ops.filter((op) => op.type === "same").length,
  };
}

export function changedSpan(oldText: string, newText: string): { start: number; oldEnd: number; newEnd: number } {
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) { oldEnd--; newEnd--; }
  return { start, oldEnd, newEnd };
}
