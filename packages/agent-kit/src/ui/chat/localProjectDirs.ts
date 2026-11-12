import type { SessionItem } from "./types.ts";

/**
 * 桌面宿主的「项目」（= 用户选择的本机文件夹 / 工作目录）独立清单。
 *
 * 项目不再由会话列表派生：删除某项目下最后一个会话时，项目仍保留在侧边栏与
 * 「选择工作空间」列表里；只有在项目更多菜单点「删除项目」才把登记移除。
 * 仅桌面宿主（localFiles 桥）写入，web 端始终为空，不影响云端会话。
 * 只移除应用内登记，永不删除磁盘文件夹及其内容。
 */

type ProjectStore = string[];

function key(userId: string): string { return `agent-kit:local-project-dirs:${userId}`; }

function read(userId: string): ProjectStore {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) || "[]");
    return Array.isArray(value)
      ? value.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
      : [];
  } catch { return []; }
}

function write(userId: string, dirs: ProjectStore): void {
  try { localStorage.setItem(key(userId), JSON.stringify(dirs)); } catch { /* ignore */ }
}

/** 归一化用于去重/比较：统一分隔符、盘符小写、去掉尾部分隔符（不用于展示）。 */
function normalize(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, drive: string) => drive.toLowerCase()).replace(/\/+$/, "");
}

/** 当前已登记的项目目录（保持最近使用在前）。 */
export function listLocalProjectDirs(userId: string): string[] {
  return read(userId);
}

/** 登记一个项目目录（去重并置顶）；空值忽略。 */
export function rememberLocalProjectDir(userId: string, dir: string | null | undefined): void {
  if (!dir) return;
  const normalized = normalize(dir);
  const rest = read(userId).filter((d) => normalize(d) !== normalized);
  write(userId, [dir, ...rest]);
}

/** 仅在目录未登记时追加到末尾（老数据回填，不改变已有项目顺序）；空值忽略。 */
export function ensureLocalProjectDir(userId: string, dir: string | null | undefined): boolean {
  if (!dir) return false;
  const normalized = normalize(dir);
  const existing = read(userId);
  if (existing.some((d) => normalize(d) === normalized)) return false;
  write(userId, [...existing, dir]);
  return true;
}

/** 移除一个项目登记（仅应用内，不碰磁盘）；空值忽略。 */
export function forgetLocalProjectDir(userId: string, dir: string | null | undefined): void {
  if (!dir) return;
  const normalized = normalize(dir);
  write(userId, read(userId).filter((d) => normalize(d) !== normalized));
}

/**
 * 合并「会话里出现的项目目录」与「独立登记清单」，输出去重后的目录与该目录下会话。
 * 已登记但已无会话的项目也会以空列表返回，用于保留空项目分组。
 */
export function mergeProjectGroups(
  registered: string[],
  sessions: SessionItem[],
): Array<[string, SessionItem[]]> {
  const byDir = new Map<string, { dir: string; list: SessionItem[] }>();
  for (const s of sessions) {
    const projectDir = s.projectDir || s.workspaceDir;
    if (s.pinOrder == null && projectDir) {
      const norm = normalize(projectDir);
      const entry = byDir.get(norm);
      if (entry) entry.list.push(s);
      else byDir.set(norm, { dir: projectDir, list: [s] });
    }
  }
  for (const dir of registered) {
    const norm = normalize(dir);
    if (!byDir.has(norm)) byDir.set(norm, { dir, list: [] });
  }
  return [...byDir.values()].map((entry) => [entry.dir, entry.list] as [string, SessionItem[]]);
}
