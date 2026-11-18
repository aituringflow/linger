/**
 * agent-kit · Docker 守护进程地址解析（服务端）
 *
 * 为什么不能写死 `/var/run/docker.sock`：Docker Desktop for Mac 从 4.13 起把 socket
 * 挪到 `~/.docker/run/docker.sock`，并通过 docker context（默认 `desktop-linux`）交给
 * CLI。只认 `/var/run/docker.sock` 时 dockerode 一律 `connect ENOENT`，而调用方普遍是
 * `try { … } catch { 当作「没有」 }` 的写法——于是「容器是否在运行」「镜像是否已存在」
 * 全部静默判假，群容器每次都被当成没起过而重建，构建也会重复拉镜像。
 *
 * 解析顺序（与 docker CLI 一致，纯 JS，不额外起子进程）：
 *   1. DOCKER_HOST 环境变量（unix:// / tcp:// / npipe://）；
 *   2. `~/.docker/config.json` 的 currentContext → `contexts/meta/<sha256(name)>/meta.json`
 *      里的 Endpoints.docker.Host；
 *   3. 平台默认值：Windows 命名管道，macOS/Linux 依次探测常见 socket 路径。
 *
 * 远程 daemon（Linux 服务器上常见的 `tcp://host:2376` + DOCKER_TLS_VERIFY=1）会按
 * DOCKER_CERT_PATH（默认 `~/.docker`）读取 ca/cert/key，否则握手必然失败。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import Dockerode from "dockerode";

type Endpoint = Pick<Dockerode.DockerOptions, "host" | "port" | "socketPath" | "protocol" | "ca" | "cert" | "key">;
type TlsOptions = Pick<Endpoint, "protocol" | "ca" | "cert" | "key">;

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * TLS 参数：只有 DOCKER_TLS_VERIFY 打开时才用（与 docker CLI 的语义一致）。
 * 证书目录 DOCKER_CERT_PATH 默认 `~/.docker`；缺证书时仍标 https，让连接阶段报出
 * 明确的握手错误，而不是悄悄回落成明文 http。
 */
function tlsOptions(): TlsOptions | null {
  const verify = process.env.DOCKER_TLS_VERIFY?.trim();
  if (!verify || verify === "0") return null;
  const dir = process.env.DOCKER_CERT_PATH?.trim() || path.join(homedir(), ".docker");
  const read = (name: string): Buffer | undefined => {
    try { return readFileSync(path.join(dir, name)); } catch { return undefined; }
  };
  return { protocol: "https", ca: read("ca.pem"), cert: read("cert.pem"), key: read("key.pem") };
}

/** `unix://` / `tcp://` / `http(s)://` / `npipe://` → dockerode 连接参数。 */
function parseHost(raw: string): Endpoint | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("unix://")) return { socketPath: value.slice("unix://".length) };
  if (value.startsWith("npipe://")) {
    const rest = value.slice("npipe://".length);
    return { socketPath: rest.startsWith("//") ? rest : `//${rest.replace(/^\/+/, "")}` };
  }
  if (/^(tcp|https?):\/\//.test(value)) {
    const url = new URL(value.replace(/^tcp:\/\//, "http://"));
    const tls = value.startsWith("https://") ? (tlsOptions() ?? { protocol: "https" as const }) : tlsOptions();
    return {
      host: url.hostname,
      // 显式写了端口就照用（2376 通常就是 TLS 端口）；没写时按是否 TLS 选默认值。
      port: url.port ? Number(url.port) : tls ? 2376 : 2375,
      ...tls,
    };
  }
  // 裸路径（极少见，手工写错也兜一下）
  if (value.startsWith("/") || value.startsWith("\\")) return { socketPath: value };
  return null;
}

/** 当前 docker context 指向的 endpoint；未配置或读不到返回 null。 */
function contextHost(): string | null {
  const config = readJson(path.join(homedir(), ".docker", "config.json")) as { currentContext?: unknown } | null;
  const name = typeof config?.currentContext === "string" ? config.currentContext.trim() : "";
  if (!name) return null;
  const digest = createHash("sha256").update(name).digest("hex");
  const meta = readJson(path.join(homedir(), ".docker", "contexts", "meta", digest, "meta.json")) as
    { Endpoints?: { docker?: { Host?: unknown } } } | null;
  const host = meta?.Endpoints?.docker?.Host;
  return typeof host === "string" && host.trim() ? host.trim() : null;
}

/** 平台默认 socket：只返回真实存在的那个，都不在就回落传统路径（连接时会报错，便于定位）。 */
function defaultEndpoint(): Endpoint {
  if (process.platform === "win32") return { socketPath: "//./pipe/docker_engine" };
  const candidates = [
    path.join(homedir(), ".docker", "run", "docker.sock"), // Docker Desktop for Mac
    "/var/run/docker.sock",
    "/run/docker.sock",
  ];
  return { socketPath: candidates.find(candidate => existsSync(candidate)) ?? "/var/run/docker.sock" };
}

/** 解析一次并缓存：socket 路径在进程生命周期内不会变。 */
let cachedOptions: Endpoint | null = null;

export function dockerEndpointOptions(): Endpoint {
  if (cachedOptions) return cachedOptions;
  const fromEnv = process.env.DOCKER_HOST ? parseHost(process.env.DOCKER_HOST) : null;
  const fromContext = fromEnv ? null : contextHost();
  cachedOptions = fromEnv ?? (fromContext ? parseHost(fromContext) : null) ?? defaultEndpoint();
  return cachedOptions;
}

/** 供错误提示/日志用的可读地址。 */
export function dockerEndpointLabel(): string {
  const options = dockerEndpointOptions();
  if (options.socketPath) return options.socketPath;
  return `${options.host ?? "127.0.0.1"}:${options.port ?? 2375}`;
}

let client: Dockerode | null = null;

/** 进程内共用的 dockerode 客户端（连接池由它自己维护，别每次 new）。 */
export function dockerClient(): Dockerode {
  if (!client) client = new Dockerode(dockerEndpointOptions());
  return client;
}

/**
 * docker CLI 可执行文件。
 *
 * 不能只依赖 `spawn("docker")`：Linux 服务器上由 systemd / pm2 / cron 拉起时 PATH 常常
 * 只有 `/usr/bin:/bin`（pm2 的 `export PATH=/usr/local/bin:$PATH` 也只是补一个），docker
 * 装在 `/usr/snap/bin`、`/usr/local/bin` 或 Docker Desktop 的 app 包里时会直接 ENOENT。
 * 所以按 `GROUP_DOCKER_CLI_PATH` → 已知安装位置（存在才用）→ PATH 的顺序解析。
 */
export function dockerExecutable(): string {
  const configured = process.env.GROUP_DOCKER_CLI_PATH?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Docker", "Docker", "resources", "bin", "docker.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
    ];
    const installed = candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate));
    if (installed) return installed;
    return "docker";
  }
  const candidates = [
    "/usr/bin/docker", // deb/rpm 包（Linux 服务器最常见）
    "/usr/local/bin/docker", // 官方 get.docker.com 脚本 / 手动安装
    "/usr/sbin/docker",
    "/snap/bin/docker", // Ubuntu snap
    "/opt/homebrew/bin/docker", // macOS arm64 Homebrew
    "/Applications/Docker.app/Contents/Resources/bin/docker", // Docker Desktop for Mac 未进 PATH
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? "docker";
}
