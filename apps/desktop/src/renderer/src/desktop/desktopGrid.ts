/** Desktop slots keep a useful card size while sharing spare space between margins and gaps. */
export interface DesktopGrid {
  left: number;
  top: number;
  cardWidth: number;
  cardHeight: number;
  columnGap: number;
  rowGap: number;
  columns: number;
  rows: number;
}

const clamp = (min: number, max: number, value: number) => Math.max(min, Math.min(max, value));

/** 顶部状态栏高度（CSS `.status-bar` 用同一个数字）：卡片不能钻到它下面。 */
export const MENU_BAR_HEIGHT = 26;

export function desktopGrid(width: number, height: number, dockReserveOverride?: number): DesktopGrid {
  const sidePadding = clamp(24, 48, width * 0.035);
  const top = MENU_BAR_HEIGHT + clamp(10, 24, height * 0.02);
  // 自动隐藏 Dock 时不给 Dock 留位：桌面组件与最大化窗口都能用满原本 Dock 占的那块高度。
  const dockReserve = dockReserveOverride ?? clamp(106, 132, height * 0.12);
  const columnGap = clamp(8, 16, width * 0.01);
  const rowGap = clamp(8, 16, height * 0.012);
  const usableWidth = Math.max(1, width - 2 * sidePadding);
  const usableHeight = Math.max(160, height - top - dockReserve);
  const columns = Math.max(1, Math.floor((usableWidth + columnGap) / (200 + columnGap)));
  const rows = Math.max(1, Math.floor((usableHeight + rowGap) / (280 + rowGap)));
  const cardWidth = Math.min(220, (usableWidth - (columns - 1) * columnGap) / columns);
  const cardHeight = Math.min(320, (usableHeight - (rows - 1) * rowGap) / rows);
  const usedWidth = columns * cardWidth + (columns - 1) * columnGap;
  return { left: Math.max(sidePadding, (width - usedWidth) / 2), top, cardWidth, cardHeight, columnGap, rowGap, columns, rows };
}

export function widgetExtent(count: number, size: number, gap: number): number {
  return count * size + (count - 1) * gap;
}

export interface GridPlacement {
  columns: number;
  rows: number;
  column: number;
  row: number;
  page: number;
}

export function fitPlacement(grid: DesktopGrid, input: Partial<GridPlacement>): GridPlacement {
  const integer = (value: number | undefined, fallback: number) => Number.isFinite(value) ? Math.floor(value!) : fallback;
  const columns = clamp(1, grid.columns, integer(input.columns, 3));
  const rows = clamp(1, grid.rows, integer(input.rows, 1));
  return {
    columns, rows,
    column: clamp(0, grid.columns - columns, integer(input.column, 0)),
    row: clamp(0, grid.rows - rows, integer(input.row, 0)),
    page: Math.max(0, integer(input.page, 0)),
  };
}

export function placementsOverlap(a: GridPlacement, b: GridPlacement): boolean {
  return a.page === b.page
    && a.column < b.column + b.columns && b.column < a.column + a.columns
    && a.row < b.row + b.rows && b.row < a.row + a.rows;
}

export function firstFreePlacement(grid: DesktopGrid, occupied: GridPlacement[], input: Partial<GridPlacement>): GridPlacement {
  const preferred = fitPlacement(grid, input);
  const free = (candidate: GridPlacement) => occupied.every((existing) => !placementsOverlap(candidate, existing));
  if (free(preferred)) return preferred;
  for (let page = preferred.page; ; page++) {
    for (let row = 0; row <= grid.rows - preferred.rows; row++) {
      for (let column = 0; column <= grid.columns - preferred.columns; column++) {
        const candidate = { ...preferred, page, row, column };
        if (free(candidate)) return candidate;
      }
    }
  }
}

/** 某个格位在视口里的中心点（用于「离鼠标最近」的距离计算）。 */
function placementCenter(grid: DesktopGrid, placement: GridPlacement): { x: number; y: number } {
  return {
    x: grid.left + placement.column * (grid.cardWidth + grid.columnGap)
      + widgetExtent(placement.columns, grid.cardWidth, grid.columnGap) / 2,
    y: grid.top + placement.row * (grid.cardHeight + grid.rowGap)
      + widgetExtent(placement.rows, grid.cardHeight, grid.rowGap) / 2,
  };
}

/**
 * 离某个屏幕坐标最近的空闲格位：右键菜单里「添加文件管理」要用鼠标位置决定落在哪。
 *
 * 先只看当前页（用户眼前这页永远比后面的页更符合预期），当前页排满了才顺延到下一页；
 * 同一页内按「组件中心到鼠标的距离」取最小 —— 所以正好点在某个空格上就落在那个格子，
 * 点在已占用的格子上就落到它旁边最近的那块空地。
 */
export function nearestFreePlacement(
  grid: DesktopGrid,
  occupied: GridPlacement[],
  size: { columns: number; rows: number },
  point: { x: number; y: number },
  page: number,
): GridPlacement {
  const columns = clamp(1, grid.columns, Math.floor(size.columns));
  const rows = clamp(1, grid.rows, Math.floor(size.rows));
  const free = (candidate: GridPlacement) => occupied.every((existing) => !placementsOverlap(candidate, existing));
  for (let offset = 0; offset < 64; offset++) {
    const candidatePage = Math.max(0, page + offset);
    let best: GridPlacement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let row = 0; row <= grid.rows - rows; row++) {
      for (let column = 0; column <= grid.columns - columns; column++) {
        const candidate: GridPlacement = { columns, rows, column, row, page: candidatePage };
        if (!free(candidate)) continue;
        const center = placementCenter(grid, candidate);
        const distance = Math.hypot(center.x - point.x, center.y - point.y);
        if (distance < bestDistance) { best = candidate; bestDistance = distance; }
      }
    }
    if (best) return best;
  }
  // 所有页都排满了（极少见）：退回首选格位，交给 placeWidgets 再兜一层。
  return fitPlacement(grid, { columns, rows, page });
}

/** Resolve saved layouts after a viewport change without changing stored coordinates. */export function placeWidgets(grid: DesktopGrid, desired: Array<{ id: string; placement: Partial<GridPlacement> }>): Map<string, GridPlacement> {
  const placed = new Map<string, GridPlacement>();
  const occupied: GridPlacement[] = [];
  for (const widget of desired) {
    const resolved = firstFreePlacement(grid, occupied, widget.placement);
    placed.set(widget.id, resolved);
    occupied.push(resolved);
  }
  return placed;
}
