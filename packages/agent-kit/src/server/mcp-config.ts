/** MCP servers supplied by the hosting application, never by a chat request. */
import { createHash } from "node:crypto";
type AppMcpApproval = { /** Codex per-tool approval policy; `approve` allows a trusted tool without prompting. */
  toolApprovals?: Record<string, "auto" | "prompt" | "writes" | "approve">;
  /** Environment variable names passed to a Codex stdio MCP child. */
  envVars?: string[];
  /** Keep tools visible to CodeBuddy from the first model request instead of deferring behind ToolSearch. */
  eager?: boolean;
};

export type AppMcpServer = AppMcpApproval & (
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
);

export type AppMcpServers = Record<string, AppMcpServer>;

/** Detect changes to a live session's MCP setup without logging credentials. */
export function mcpConfigFingerprint(servers: AppMcpServers = {}): string {
  const stable = Object.fromEntries(Object.entries(servers).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

const RESERVED = new Set(["web_fetch", "browser_agent", "memory"]);

export function validateAppMcpServers(servers: AppMcpServers = {}): AppMcpServers {
  const normalized = new Set<string>();
  for (const [name, server] of Object.entries(servers)) {
    const toolPrefix = name.replace(/-/g, "_");
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || RESERVED.has(toolPrefix) || normalized.has(toolPrefix)) {
      throw new Error(`Invalid or reserved MCP server name: ${name}`);
    }
    normalized.add(toolPrefix);
    if (server.type === "stdio") {
      if (!server.command?.trim()) throw new Error(`MCP server ${name} requires a command`);
    } else if (server.type === "http") {
      const url = new URL(server.url);
      if (!(["http:", "https:"].includes(url.protocol))) throw new Error(`MCP server ${name} requires an HTTP URL`);
    } else {
      throw new Error(`Unsupported MCP server type: ${name}`);
    }
  }
  return servers;
}

/** Remove app-level policy metadata before sending MCP transport definitions to CodeBuddy. */
export function codebuddyMcpConfig(servers: AppMcpServers = {}) {
  validateAppMcpServers(servers);
  return Object.fromEntries(Object.entries(servers).map(([name, { toolApprovals: _policy, envVars: _envVars, eager, ...transport }]) => [name,
    { ...transport, ...(eager ? { alwaysLoad: true, defer_loading: false } : {}) },
  ]));
}

/** Codex CLI accepts MCP configuration through its mcp_servers config table. */
export function codexMcpConfig(servers: AppMcpServers = {}) {
  validateAppMcpServers(servers);
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name,
    {
      ...(server.type === "stdio"
        ? { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}), ...(server.envVars ? { env_vars: server.envVars } : {}) }
        : { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) }),
      ...(server.toolApprovals ? { tools: Object.fromEntries(Object.entries(server.toolApprovals).map(([tool, approval_mode]) => [tool, { approval_mode }])) } : {}),
    },
  ]));
}
