import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Use the same CLI bundled with codex-sdk, unless the host explicitly overrides it. */
export function getCodexCliPath(): string {
  const explicit = process.env.CODEX_CLI_PATH?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CODEX_CLI_PATH 不存在：${explicit}`);
    return explicit;
  }
  const target = `${process.platform}-${process.arch}`;
  const packages: Record<string, [string, string]> = {
    "win32-x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
    "win32-arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
    "darwin-x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
    "darwin-arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
    "linux-x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
    "linux-arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
  };
  const entry = packages[target];
  if (!entry) throw new Error(`不支持的 Codex 平台：${target}`);
  // Resolve at runtime by path. A dynamic require.resolve of an optional platform
  // package makes Turbopack try to bundle every platform during the Web build.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const starts = [
    ...(resourcesPath ? [resourcesPath] : []),
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ];
  let packageJson: string | undefined;
  for (const start of starts) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", entry[0], "package.json");
      if (existsSync(candidate)) { packageJson = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
    }
    if (packageJson) break;
  }
  if (!packageJson) throw new Error(`Codex 平台包不存在：${entry[0]}`);
  const executable = path.join(path.dirname(packageJson), "vendor", entry[1], "bin", process.platform === "win32" ? "codex.exe" : "codex");
  if (!existsSync(executable)) throw new Error("Codex SDK 自带的 CLI 不存在，请重新安装依赖");
  return executable;
}
