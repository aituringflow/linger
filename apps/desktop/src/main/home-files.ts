import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LauncherFsEntry } from "../shared/types";

/**
 * 桌面「文件管理」组件读本机目录的落点。
 *
 * 约定：渲染层只拿相对 home 的 rel 路径（"" = home 本身），绝对路径不往渲染层铺。
 * 所有入口都先过 resolveInHome —— 越界（../、绝对路径、软链逃逸）一律拒绝，
 * 免得组件某天被塞进一个 ../.. 就把整个磁盘读出来。
 */
const HOME = os.homedir();

export function homeDir(): string {
  return HOME;
}

/** rel → 绝对路径；越出 home 返回 null。 */
export function resolveInHome(rel: unknown): string | null {
  if (typeof rel !== "string") return null;
  // 前缀 "/" 视作「相对 home 的根」，避免 "/etc" 这种被当成绝对路径放行。
  const abs = path.resolve(HOME, rel.replace(/^[/\\]+/, ""));
  if (abs === HOME) return abs;
  return abs.startsWith(HOME + path.sep) ? abs : null;
}

function toRel(abs: string): string {
  return path.relative(HOME, abs).split(path.sep).join("/");
}

/**
 * 列一层目录：文件夹与文件一起返回，大小取不到的（无权限/已删除）给 0。
 * 目录不存在（ENOENT）返回 null —— 渲染层据此回落到 home，而不是停在空壳目录里。
 */
export async function listDirectory(rel: unknown): Promise<LauncherFsEntry[] | null> {
  const abs = resolveInHome(rel);
  if (!abs) return null;
  let items: Dirent[] = [];
  try {
    items = await fs.readdir(abs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // 没权限等其它错误：当作空目录，让界面显示「此目录为空」而不是报错
    return [];
  }
  const entries = await Promise.all(items.map(async (item): Promise<LauncherFsEntry> => {
    const childAbs = path.join(abs, item.name);
    let size = 0;
    let mtimeMs = 0;
    let isDir = item.isDirectory();
    try {
      // 软链按目标算：指向文件夹的软链要能进得去。
      const stat = item.isSymbolicLink() ? await fs.stat(childAbs) : await fs.lstat(childAbs);
      isDir = stat.isDirectory();
      size = stat.isDirectory() ? 0 : stat.size;
      mtimeMs = stat.mtimeMs;
    } catch { /* 断链/无权限：当作空文件列出 */ }
    return { rel: toRel(childAbs), name: item.name, isDir, size, mtimeMs };
  }));
  return entries;
}

/** 校验用户输入的文件/文件夹名：不能带分隔符，不能是 . / .. */
function validName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  return Boolean(trimmed) && trimmed !== "." && trimmed !== ".." && !/[/\\\0]/.test(trimmed);
}

export async function renamePath(rel: unknown, name: unknown): Promise<boolean> {
  const abs = resolveInHome(rel);
  if (!abs || abs === HOME || !validName(name)) return false;
  const target = path.join(path.dirname(abs), name.trim());
  if (!target.startsWith(HOME + path.sep)) return false;
  try {
    await fs.rename(abs, target);
    return true;
  } catch { return false; }
}

export async function createDirectory(rel: unknown, name: unknown): Promise<"ok" | "exists" | "error"> {
  const dir = resolveInHome(rel);
  if (!dir || !validName(name)) return "error";
  const target = path.join(dir, name.trim());
  if (!target.startsWith(HOME + path.sep)) return "error";
  try {
    await fs.mkdir(target);
    return "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "error";
  }
}

/** 把 rel 移到 destDir（同样相对 home）。自己移到自己里面会被拦下。 */
export async function movePath(rel: unknown, destDir: unknown): Promise<boolean> {
  const abs = resolveInHome(rel);
  const dest = resolveInHome(destDir);
  if (!abs || !dest || abs === HOME) return false;
  if (dest !== HOME && !dest.startsWith(HOME + path.sep)) return false;
  // 目标是自己或自己的子目录：fs.rename 会报 ENOTEMPTY/EINVAL，先挡掉。
  if (dest === abs || dest.startsWith(abs + path.sep)) return false;
  try {
    await fs.rename(abs, path.join(dest, path.basename(abs)));
    return true;
  } catch { return false; }
}

/**
 * 删除走系统废纸篓（主进程用 shell.trashItem，见 index.ts），这里只做路径校验。
 * 不能删 home 本身。
 */
export function trashTarget(rel: unknown): string | null {
  const abs = resolveInHome(rel);
  return !abs || abs === HOME ? null : abs;
}

/**
 * 文件系统监听：监听指定目录的变化，触发回调。
 * 只监听一层目录（不递归），足够文件管理组件用。
 * 返回一个停止监听的函数。
 */
export function watchDirectory(rel: unknown, onChange: () => void): (() => void) | null {
  const abs = resolveInHome(rel);
  if (!abs) return null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(abs, { persistent: false }, () => {
      // 防抖：连续多次变化只触发一次
      onChange();
    });
  } catch {
    return null;
  }
  return () => {
    watcher?.close();
    watcher = null;
  };
}
