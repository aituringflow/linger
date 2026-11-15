export interface ActivityTool {
  name: string;
  input?: string;
  activity?: string;
  status?: "running" | "completed" | "failed";
}

/** 内置记忆 MCP 的工具名在不同 SDK 中分别为 mcp__memory__save / memory/save。 */
export function memoryToolLabel(name: string): string | null {
  if (/^(?:mcp__local_memory__|local_memory\/)upsert_memory$/i.test(name)) return "保存记忆";
  const match = /^(?:mcp__memory__|memory\/)(save|list|delete|find_files)$/i.exec(name);
  if (!match) return null;
  return ({ save: "保存记忆", list: "查看记忆", delete: "删除记忆", find_files: "查找记忆文件" } as Record<string, string>)[match[1].toLowerCase()];
}

export type LocalToolKind = "knowledge" | "memory";

/**
 * 本地检索 MCP 的精确识别，必须排在"名字里含 search 就是网页搜索"这类关键词兜底之前。
 *
 * search 只是动词，不说明检索来源：旧兜底把 mcp__local_memory__search_memory 标成了
 * 「网页搜索」，用户会以为记忆被拿去上网搜了。按 (server, tool) 组合判定，同时兼容
 * 不同 SDK 的两种命名风格：mcp__local_memory__search_memory 与 local_memory/search_memory，
 * 以及工具名简写成 search 的情况。
 */
export function localToolKind(name: string): LocalToolKind | null {
  const full = name.toLowerCase();
  const tool = (full.split("__").pop() ?? full).split("/").pop() ?? full;
  if (!/^search(?:_knowledge|_memory)?$/.test(tool)) return null;
  if (full.includes("knowledge") || full.includes("local_kb")) return "knowledge";
  if (full.includes("memory")) return "memory";
  return null;
}

export function isCommandTool(name: string): boolean {
  const base = (name.split("__").pop() ?? name).toLowerCase();
  return /bash|powershell|command|shell/.test(base) || base === "run";
}

/** Legacy history can use its input JSON; new events carry an independently extracted detail. */
export function activityDetail(tool: ActivityTool): string {
  let detail = tool.activity ?? "";
  if (!detail && tool.input) {
    try {
      const input = JSON.parse(tool.input) as Record<string, unknown>;
      const keys = isCommandTool(tool.name)
        ? ["command", "cmd", "script", "description"]
        : ["description", "file_path", "notebook_path", "query", "url", "pattern", "path", "prompt"];
      for (const key of keys) {
        if (typeof input[key] === "string" && input[key].trim()) { detail = input[key]; break; }
      }
    } catch { /* Old truncated JSON is not a usable summary. */ }
  }
  return detail.replace(/\s+/g, " ").trim();
}

export function toolActivityText(tool: ActivityTool, label: string): string {
  const memoryLabel = memoryToolLabel(tool.name);
  if (memoryLabel) {
    if (tool.status === "running") return `正在${memoryLabel}`;
    if (tool.status === "failed") return `${memoryLabel}失败`;
    return memoryLabel;
  }
  const detail = activityDetail(tool);
  if (isCommandTool(tool.name)) {
    const state = tool.status === "running" ? "正在运行" : tool.status === "failed" ? "运行失败" : "已运行";
    return `${state} ${detail || "命令"}`;
  }
  const state = tool.status === "running" ? "正在执行" : tool.status === "failed" ? "执行失败" : "已执行";
  return `${state} ${label}${detail ? ` ${detail}` : ""}`;
}
