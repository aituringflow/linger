/**
 * Windows 控制台中文日志乱码修复（macOS 无此问题）。
 *
 * 现象：从 Windows PowerShell 5.1 / cmd 启动 launcher 时，主进程的中文 console 日志显示成
 * 「鑵捐浜?」这类乱码，英文与 URL 完全正常；macOS 上同样的日志正常。
 *
 * 成因：Electron 的 stdout 被 shell 捕获时是管道（`process.stdout.isTTY === false`），
 * Node 会按 UTF-8 往管道写字节；而 Windows PowerShell 5.1 按 `[Console]::OutputEncoding`
 * （简体中文系统默认 936 / GBK）解码 native 程序的输出——UTF-8 字节被当成 GBK 读，
 * 就是「鑵捐浜?」（部分字节无效还会被替换成 ?）。mac 的终端与管道都是 UTF-8，所以不受影响。
 *
 * 修复只发生在本进程内：把 console 输出转成**控制台代码页对应的字节**再写出去，
 * 不改系统设置、不改用户终端、也不改日志文件的既有行为（转码只作用于 stdout/stderr 的字符串输出）。
 *
 * 判断刻意保守，只在能确定编码时才转：
 *   · 仅 Windows；
 *   · stdout 是 TTY 时不动——libuv 会把 UTF-8 转成 UTF-16 调 WriteConsoleW，此时再转码会二次编码；
 *   · PowerShell 7 / Git Bash(MSYS) 本身就是 UTF-8 语义，不动；
 *   · 其余按当前控制台代码页：65001（UTF-8）不动；936/54936/950/932/949 转对应编码；
 *   · 未知代码页或探测不到（没有控制台，例如双击启动）不动——宁可维持现状，也不猜错编码。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { format } from "node:util";
import iconv from "iconv-lite";

/** 常见 ANSI 代码页 → iconv 编码名。只收录能确定映射的，其余一律不转。 */
const CODE_PAGE_ENCODINGS: Record<number, string> = {
  936: "gbk", // 简体中文
  54936: "gb18030", // 简体中文（GB18030）
  950: "big5", // 繁体中文
  932: "shift_jis", // 日文
  949: "euc-kr", // 韩文
};

/**
 * 读当前控制台代码页。
 *
 * `chcp.com` 的输出文案随系统语言变化（「Active code page: 936」/「活动代码页: 936」），
 * 所以不解析文案，只取其中的数字；输出本身可能是本地编码，用 latin1 读避免数字被乱码影响。
 */
export function detectConsoleCodePage(): number | null {
  if (process.platform !== "win32") return null;
  // 允许手动覆盖（终端编码特殊、或想强制走某套解码时）：LAUNCHER_CONSOLE_CP=936。
  const override = Number(process.env.LAUNCHER_CONSOLE_CP ?? "");
  if (Number.isInteger(override) && override > 0) return override;
  try {
    const chcp = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "chcp.com");
    const result = spawnSync(chcp, [], { windowsHide: true, timeout: 1500 });
    const raw = Buffer.isBuffer(result.stdout) ? result.stdout.toString("latin1") : String(result.stdout ?? "");
    const match = /\b(\d{3,5})\b/.exec(raw);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 纯判断：需要把输出转成哪个 iconv 编码；`null` = 保持 UTF-8。
 * 单独导出是为了能直接验证判断表，不必真的替换 console 或启动 Electron。
 */
export function consoleTranscodeEncoding(opts: {
  platform: NodeJS.Platform | string;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  codePage: number | null;
}): string | null {
  if (opts.platform !== "win32") return null;
  // TTY：libuv 自己做 UTF-8 → UTF-16，不能在这里再转一次。
  if (opts.isTTY) return null;
  // Git Bash / MSYS2（mintty）按 UTF-8 显示，不经过 Windows 代码页。
  if (opts.env.MSYSTEM) return null;
  // PowerShell 7 显式按 UTF-8 解码 native 输出，即使控制台代码页还是 936。
  if (/PowerShell[\\/]7/i.test(opts.env.PSModulePath ?? "")) return null;
  if (opts.codePage == null) return null;
  return CODE_PAGE_ENCODINGS[opts.codePage] ?? null;
}

/** 在 app 启动早期调用一次：命中条件时替换 console 的输出实现。 */
export function setupConsoleEncoding(): void {
  const encoding = consoleTranscodeEncoding({
    platform: process.platform,
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
    codePage: detectConsoleCodePage(),
  });
  if (!encoding) return;

  const write = (stream: NodeJS.WriteStream, args: unknown[]) => {
    // 关键：写 Buffer 而不是 string。console.*(string) 会按 UTF-8 编码，
    // 这里要让字节直接落到控制台代码页上，由终端按 936 等 ANSI 编码解读。
    stream.write(iconv.encode(`${format(...args)}\n`, encoding));
  };
  console.log = (...args: unknown[]) => write(process.stdout, args);
  console.info = (...args: unknown[]) => write(process.stdout, args);
  console.debug = (...args: unknown[]) => write(process.stdout, args);
  console.warn = (...args: unknown[]) => write(process.stderr, args);
  console.error = (...args: unknown[]) => write(process.stderr, args);
}
