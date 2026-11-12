import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getCodexCliPath } from "./codex-cli.js";
import { resolveModelsFile } from "./models-file.js";

type ModelEntry = { id: string; name?: string; vendor?: string; url?: string; apiKey?: string; [key: string]: unknown };
export type CodexModelChoice = { id: string; name?: string; meta?: Record<string, unknown> };

let liveModels: CodexModelChoice[] = [];
let liveModelsAt = 0;
let liveModelsRequest: Promise<CodexModelChoice[]> | null = null;

/** Ask the installed Codex CLI for the account's current model catalog. */
export function fetchCodexModelOptions(refresh = false): Promise<CodexModelChoice[]> {
  if (!refresh && liveModels.length && Date.now() - liveModelsAt < 60_000) return Promise.resolve(liveModels);
  if (liveModelsRequest) return liveModelsRequest;
  liveModelsRequest = (async () => {
    const executable = getCodexCliPath();
    const models = await new Promise<CodexModelChoice[]>((resolve, reject) => {
      const child = spawn(executable, ["app-server", "--stdio"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error, value?: CodexModelChoice[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (error) reject(error); else resolve(value ?? []);
      };
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      const timer = setTimeout(() => finish(new Error("Codex 模型列表请求超时")), 20_000);
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.once("error", (error) => finish(error));
      child.once("close", () => finish(new Error(stderr || "Codex app-server 意外退出")));
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line) as { id?: number; result?: { data?: Array<{ model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean }> }; error?: { message?: string } };
            if (message.id === 1) {
              if (message.error) { finish(new Error(message.error.message || "Codex 初始化失败")); return; }
              send({ method: "initialized" });
              send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false } });
            } else if (message.id === 2) {
              if (message.error) { finish(new Error(message.error.message || "Codex 模型列表读取失败")); return; }
              const data = message.result?.data ?? [];
              finish(undefined, data.filter((model) => model.model && !model.hidden)
                .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
                .map((model) => ({ id: model.model!, name: model.displayName || model.model })));
              return;
            }
          } catch { /* Ignore unrelated notifications and partial protocol output. */ }
          newline = buffer.indexOf("\n");
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-kit", title: "Agent Kit", version: "0.3.8" }, capabilities: null } });
    });
    if (!models.length) throw new Error("Codex 未返回可用模型");
    liveModels = models;
    liveModelsAt = Date.now();
    return models;
  })().finally(() => { liveModelsRequest = null; });
  return liveModelsRequest;
}

function codebuddyEntries(): ModelEntry[] {
  const file = resolveModelsFile();
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { models?: unknown };
    return Array.isArray(parsed.models) ? parsed.models.filter((m): m is ModelEntry => Boolean(m && typeof m === "object" && typeof m.id === "string")) : [];
  } catch { return []; }
}

export function getCodexModelOptions(): CodexModelChoice[] {
  const result: CodexModelChoice[] = [...liveModels];
  for (const entry of codebuddyEntries()) {
    if (!entry.url || !entry.vendor) continue;
    result.push({
      id: entry.id,
      name: entry.name || entry.id,
      meta: {
        vendor: entry.vendor,
        maxInputTokens: entry.maxInputTokens,
        maxOutputTokens: entry.maxOutputTokens,
        supportsToolCall: entry.supportsToolCall,
        supportsImages: entry.supportsImages,
      },
    });
  }
  return result;
}

/** Resolve only a server-side configured model; never accept an arbitrary client URL or API key. */
export function resolveCodexModel(key: string | undefined): { model?: string; baseUrl?: string; apiKey?: string } {
  if (!key || key === "__codex_default__") {
    return { model: liveModels[0]?.id };
  }
  const entry = codebuddyEntries().find((m) => `${m.vendor || ""}::${m.id}` === key);
  if (!entry) {
    const native = getCodexModelOptions().find((m) => !m.meta?.vendor && m.id === key);
    if (!native) throw new Error(`Codex 模型未配置：${key}`);
    return { model: native.id };
  }
  const url = new URL(entry.url!);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Codex 自定义模型 URL 必须使用 HTTP(S)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Codex 自定义模型 URL 不得含凭据、查询参数或片段");
  const basePath = url.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
  if (basePath === url.pathname) throw new Error(`模型 ${entry.id} 的 URL 不是 chat/completions 端点`);
  const rawKey = String(entry.apiKey || "");
  const envName = rawKey.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
  const apiKey = envName ? process.env[envName] : rawKey;
  if (!apiKey) throw new Error(`模型 ${entry.id} 缺少 API Key`);
  return { model: entry.id, baseUrl: `${url.origin}${basePath}`, apiKey };
}
