import { spawn } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import Dockerode from "dockerode";
import { artifactSessionDir, uploadStorageDir } from "./artifacts.js";
import { appHomePath } from "./app-home.js";

const DEFAULT_IMAGE = "agent-kit-group-node:24";
const image = () => process.env.GROUP_BASH_IMAGE?.trim() || DEFAULT_IMAGE;
/** 一个群共享一个容器：名称只由 sessionId 决定，群内所有 AI 复用。 */
const hashFor = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
const nameFor = (sessionId: string) => `agent-group-${hashFor(sessionId)}`;
const networkName = (name: string) => `${name}-network`;
const gatewayName = (name: string) => `${name}-gateway`;
let imageBuild: Promise<void> | undefined;

/** 终端会话的私有配置目录：应用主目录下 `terminal-home/<sessionId-hash>`
 *  （`~/.<AGENT_APP_NAME>/terminal-home`，未声明应用名时 `~/.agent/terminal-home`）。
 *  仅通过 bind 挂载进容器的 /group/terminal-home，供 PTY 终端 exec 使用；
 *  不挂给 AI 文件工具，也不在 artifacts 内。
 *  注意：PTY 的 $HOME 是工作区根 /group/artifacts（`cd ~` 要回工作区），这里只放
 *  用户看不见的终端内部状态——bash 初始化文件（用 --rcfile 指定）、命令历史、npm 缓存，
 *  所以这些不落进群共享目录。 */
export function terminalHomeDir(sessionId: string): string {
  return appHomePath("terminal-home", hashFor(sessionId));
}
/** 供 terminal-session 复用容器命名（PTY exec 打在同一群容器里）。 */
export { nameFor, gatewayName };

function dockerExecutable(): string {
  const configured = process.env.GROUP_DOCKER_CLI_PATH?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Docker", "Docker", "resources", "bin", "docker.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
    ];
    const installed = candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate));
    if (installed) return installed;
  }
  return "docker";
}

function docker(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = dockerExecutable();
    // Docker Desktop invokes docker-credential-desktop via PATH when pulling images.
    const env = path.isAbsolute(executable)
      ? { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}` }
      : process.env;
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
    let stdout = "", stderr = "";
    const cap = 64 * 1024;
    const timer = setTimeout(() => { child.kill(); reject(new Error("container_timeout")); }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout.length > cap) { child.kill(); reject(new Error("output_limit")); } });
    child.stderr.on("data", chunk => { stderr += String(chunk); if (stderr.length > cap) { child.kill(); reject(new Error("output_limit")); } });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error([stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `docker_exit_${code}`)); });
  });
}

/* ── Docker Engine API 快路径 ─────────────────────────────────────────
 * 本机 docker CLI 单次调用约 2.5-3s（Docker Desktop 的 WSL 代理握手开销），
 * 同一操作的 Engine API 只要 5-10ms（实测相差约 300 倍）。终端启动路径要连续做
 * 多次「容器是否就绪」检查，走 CLI 会让每次打开终端白等十几秒。因此：
 *   - 只读检查 / 容器内短命令 → dockerode（快路径）
 *   - 重建容器的重活（run / rm / network，参数映射复杂且不常发生）→ 仍用 CLI */
let dockerApiClient: Dockerode | null = null;
function dockerApi(): Dockerode {
  if (dockerApiClient) return dockerApiClient;
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("tcp://")) {
    const url = new URL(host);
    dockerApiClient = new Dockerode({ host: url.hostname, port: url.port ? Number(url.port) : 2375 });
  } else {
    dockerApiClient = new Dockerode({ socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock" });
  }
  return dockerApiClient;
}

/** 容器 inspect：不存在或出错返回 null（等价 CLI 的 `.catch(() => "")`）。 */
async function inspectFast(name: string) {
  try { return await dockerApi().getContainer(name).inspect(); }
  catch { return null; }
}

/** 在容器内执行一条短命令，合并 stdout/stderr 返回（Engine API exec，非 TTY）。
 *  用于 getent / ip route / iptables 这类网关内配置命令，替代慢速的 `docker exec`。
 *  返回 exit code（等价 CLI 版本的 resolve/reject 语义，供 -C 存在性探测判断）。 */
async function execCapture(container: string, cmd: string[], timeoutMs = 20_000): Promise<{ output: string; code: number }> {
  const api = dockerApi();
  const exec = await api.getContainer(container).exec({ AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd });
  const stream = await exec.start({ hijack: false, stdin: false });
  let output = "";
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", chunk => { output += String(chunk); });
  stderr.on("data", chunk => { output += String(chunk); });
  api.modem.demuxStream(stream, stdout, stderr);
  const timer = setTimeout(() => { (stream as unknown as { destroy?: () => void }).destroy?.(); }, timeoutMs);
  await new Promise<void>(resolve => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", resolve);
  });
  clearTimeout(timer);
  const code = await exec.inspect().then(info => info.ExitCode ?? 0, () => -1);
  return { output, code };
}

/** Dockerfile 内容指纹，写到镜像 label 上。
 *  原来「镜像已存在就跳过构建」会让 Dockerfile 的任何改动（新增命令、装工具）
 *  对老环境永远不生效；改成比对指纹，改了就自动重建镜像。 */
const DOCKERFILE_LABEL = "agent-kit.dockerfile";

async function ensureImage(): Promise<void> {
  if (process.env.GROUP_BASH_IMAGE?.trim()) return;
  if (!imageBuild) imageBuild = (async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const dockerfile = path.join(root, "Dockerfile.group");
    const digest = createHash("sha256").update(await readFile(dockerfile)).digest("hex").slice(0, 16);
    // 镜像不存在时 CLI 非零退出 → 当作指纹不匹配（需要构建）。
    const stamped = await docker(["image", "inspect", "-f", `{{index .Config.Labels "${DOCKERFILE_LABEL}"}}`, DEFAULT_IMAGE])
      .then(text => text.trim(), () => "");
    if (stamped === digest) return;
    await docker(["build", "--quiet", "--label", `${DOCKERFILE_LABEL}=${digest}`, "-t", DEFAULT_IMAGE, "-f", dockerfile, root], 900_000);
  })().catch(error => { imageBuild = undefined; throw error; });
  await imageBuild;
}

/** 群容器是否还跑在旧镜像上：镜像重建后已有容器不会自动跟随，得重建一次容器。 */
async function containerImageStale(name: string): Promise<boolean> {
  const info = await inspectFast(name);
  if (!info?.Image) return false;
  const current = await dockerApi().getImage(image()).inspect().then(img => img.Id, () => "");
  return !!current && current !== info.Image;
}

async function running(name: string): Promise<boolean> {
  const info = await inspectFast(name);
  return info?.State?.Running === true;
}

/** 容器是否已带 /group/terminal-home 挂载（旧容器缺新挂载时需重建一次）。 */
async function hasTerminalHomeMount(name: string): Promise<boolean> {
  const info = await inspectFast(name);
  if (!info) return false;
  return (info.Mounts ?? []).some(mount => mount.Destination === "/group/terminal-home");
}

/** 已执行过 host 阻断的网关（key=容器名 → 该次启动时间）。
 *  同一启动周期内只跑一次 iptables：容器重建（新启动时间）会自动失效，
 *  避免重连/反复 attach 时往 pids 受限的网关狂发 exec。 */
const blockedGateways = new Map<string, string>();

/** The development container has no NET_ADMIN. Only this separate gateway can edit its network namespace. */
async function blockHostAddresses(gateway: string): Promise<void> {
  const started = (await inspectFast(gateway))?.State?.StartedAt ?? "";
  if (started && blockedGateways.get(gateway) === started) return;
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (!entry.internal && isIP(entry.address)) addresses.add(entry.address.split("%")[0]);
  }
  for (const host of ["host.docker.internal", "gateway.docker.internal"]) {
    const { output } = await execCapture(gateway, ["getent", "ahosts", host]).catch(() => ({ output: "", code: 1 }));
    for (const line of output.split(/\r?\n/)) {
      const address = line.trim().split(/\s+/)[0];
      if (isIP(address)) addresses.add(address);
    }
  }
  const { output: routes } = await execCapture(gateway, ["ip", "route", "show", "default"]);
  for (const match of routes.matchAll(/\bvia\s+(\S+)/g)) if (isIP(match[1])) addresses.add(match[1]);
  if (!addresses.size) throw new Error("host_network_addresses_unavailable");
  for (const family of [4, 6] as const) {
    const binary = family === 4 ? "iptables" : "ip6tables";
    const chain = "GROUP_HOST_BLOCK";
    await execCapture(gateway, [binary, "-N", chain]).catch(() => null);
    const exists = await execCapture(gateway, [binary, "-C", "OUTPUT", "-j", chain]).then(result => result.code === 0, () => false);
    if (!exists) await execCapture(gateway, [binary, "-I", "OUTPUT", "1", "-j", chain]);
    await execCapture(gateway, [binary, "-F", chain]);
    await execCapture(gateway, [binary, "-A", chain, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"]);
    for (const address of addresses) if (isIP(address) === family) {
      await execCapture(gateway, [binary, "-A", chain, "-d", address, "-j", "REJECT"]);
    }
  }
  if (started) blockedGateways.set(gateway, started);
}

async function removeByName(name: string): Promise<void> {
  for (const container of [name, gatewayName(name)]) {
    await docker(["rm", "-f", container]).catch(error => {
      const msg = String(error);
      // “No such container” 已不存在；或移除“already in progress / is being deleted”
      // （前一次 rm -f 并发触发，Docker 仍在异步移除）→ 都视为“已移除”，不要抛错中断重建。
      if (!(msg.includes("No such container") || msg.includes("already in progress") || msg.includes("removal of container") || msg.includes("being deleted"))) {
        throw error;
      }
    });
  }
  await docker(["network", "rm", networkName(name)]).catch(error => {
    const msg = String(error);
    if (!(msg.includes("not found") || msg.includes("already in progress"))) throw error;
  });
}

/** 等待容器真正从 Docker 移除完毕，避免 rm -f 异步移除尚未完成时，
 *  紧随其后的 docker run --name 报 “name already in use”。最多等 ~9s。 */
async function waitContainerRemoved(name: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!await inspectFast(name)) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

/** 旧版本容器按（群, AI）命名（agent-group-<hash>-<aiId>），每个 AI 一个；
 *  升级为按群共享后清理遗留的 per-agent 容器。
 *  注意：只匹配带后缀的旧命名，绝不误删当前 `agent-group-<24hex>` 群容器，
 *  也绝不误删配套网关 `agent-group-<24hex>-gateway`（它同样匹配下面的正则）。 */
async function removeStaleGroupContainers(keep: string): Promise<void> {
  let listed: { Names?: string[] }[] = [];
  try { listed = await dockerApi().listContainers({ all: true }); } catch { return; }
  for (const container of listed) {
    const name = (container.Names?.[0] ?? "").replace(/^\//, "");
    if (!name || name === keep) continue;
    // 关键：网关名形如 agent-group-<24hex>-gateway，会被下面的旧命名正则命中；
    // 一旦删掉它，下次 attach 就判定“网关不在”而整容器重建（开终端要等几十秒）。
    if (name === gatewayName(keep) || name.endsWith("-gateway")) continue;
    if (/^agent-group-[0-9a-f]{24}-.+$/.test(name)) await removeByName(name).catch(() => {});
  }
}

export async function ensureGroupContainer(sessionId: string): Promise<void> {
  const name = nameFor(sessionId);
  const gateway = gatewayName(name);
  const uploads = uploadStorageDir(sessionId);
  const artifacts = artifactSessionDir(sessionId);
  const terminalHome = terminalHomeDir(sessionId);
  await Promise.all([
    mkdir(uploads, { recursive: true }),
    mkdir(artifacts, { recursive: true }),
    mkdir(terminalHome, { recursive: true, mode: 0o777 }),
  ]);
  const [uploadPath, artifactPath, terminalHomePath] = await Promise.all([realpath(uploads), realpath(artifacts), realpath(terminalHome)]);
  if (uploadPath !== path.resolve(uploads) || artifactPath !== path.resolve(artifacts) || terminalHomePath !== path.resolve(terminalHome))
    throw new Error("container_mount_symlink");
  // 先确保镜像就绪并比对指纹：容器是否「跑在旧镜像上」要依赖当前 tag 的 id。
  await ensureImage();
  if (await running(name)) {
    // 先做只读检查（docker inspect，不执行 exec）：缺新挂载、网关不在、镜像已重建 → 直接重建；
    // 网关卡死（pids 打满等）时也能走到重建，不会被旧网关的 exec 失败挡住。
    if (!await hasTerminalHomeMount(name) || !await running(gateway)) await removeByName(name);
    else if (await containerImageStale(name)) await removeByName(name);
    else { await blockHostAddresses(gateway); return; }
  }
  await removeByName(name);
  // 等容器（含网关）真正移除完毕，再重建，避免 docker run --name 报 “name already in use”
  await waitContainerRemoved(name);
  await waitContainerRemoved(gatewayName(name));
  await docker(["network", "create", "--driver", "bridge", networkName(name)]);
  try {
    await docker(["run", "-d", "--name", gateway, "--network", networkName(name), "--cap-drop=ALL", "--cap-add=NET_ADMIN",
      "--security-opt=no-new-privileges", "--read-only", "--tmpfs=/run:rw,nosuid,nodev,size=8m",
      "--publish", "127.0.0.1::3000", "--pids-limit=128", "--memory=128m", image(), "sleep", "infinity"]);
    await blockHostAddresses(gateway);
    await docker(["run", "-d", "--name", name, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--network", `container:${gateway}`, "--pids-limit=128", "--memory=1g", "--cpus=1", "--user", `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`,
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m", "--mount", `type=bind,src=${uploadPath},dst=/group/uploads,readonly`,
    "--mount", `type=bind,src=${artifactPath},dst=/group/artifacts`, "--mount", `type=bind,src=${terminalHomePath},dst=/group/terminal-home`,
    "--workdir=/group/artifacts",
    "--env", "HOME=/group/artifacts/.home", "--env", "NPM_CONFIG_CACHE=/group/artifacts/.npm",
    // UTF-8 locale：镜像默认 LANG 为空（POSIX），中文文件名会被 coreutils 转义成
    // `''$'\350\277\224...'` 这种形式，AI 的 bash 工具与终端都会读错路径。
    // 这里给新容器设默认值；已存在的旧容器由各 `docker exec` 单次 `--env` 兜底。
    "--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8",
    image(), "sleep", "infinity"], 120_000);
    await docker(["exec", name, "sh", "-c", "test -r /group/uploads && test -w /group/artifacts && test -w /group/terminal-home && node --version && npm --version"]);
  } catch (error) { await removeByName(name).catch(() => {}); throw error; }
  void removeStaleGroupContainers(name).catch(() => {});
}

export async function execGroupBash(sessionId: string, cmd: string): Promise<string> {
  if (!cmd.trim() || cmd.length > 16_000) throw new Error("invalid_command");
  const name = nameFor(sessionId);
  if (!await running(name) || !await running(gatewayName(name))) await ensureGroupContainer(sessionId);
  await blockHostAddresses(gatewayName(name));
  return docker(["exec", "--workdir", "/group/artifacts", "--env", "LANG=C.UTF-8", name, "timeout", "120", "sh", "-lc", cmd], 125_000);
}

/** 合并 stdout/stderr 并在任意退出码下都返回输出，供 Web 终端使用。 */
function dockerCombined(args: string[], timeoutMs = 30_000): Promise<{ output: string; code: number }> {
  return new Promise((resolve, reject) => {
    const executable = dockerExecutable();
    const env = path.isAbsolute(executable)
      ? { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}` }
      : process.env;
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
    let output = "";
    const cap = 256 * 1024;
    const timer = setTimeout(() => { child.kill(); reject(new Error("container_timeout")); }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      output += String(chunk);
      if (output.length > cap) { child.kill(); reject(new Error("output_limit")); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ output, code: code ?? 0 }); });
  });
}

/** Web 终端：在群共享容器内执行一条 shell 命令。
 *  - 工作目录沿用客户端上一次的 cwd（默认 /group/artifacts，即群 AI 读写目录），实现 cd 跨命令保留；
 *  - 分配 TTY（exec -t）让 ls --color=auto 等输出 ANSI 颜色，并注入 ls/grep 的 auto 颜色包装（Debian 镜像默认无别名）；
 *  - 命令结束后回传 __CWD__ 标记以获取最终工作目录，服务端剥离后再返回给前端。 */
export async function execGroupBashTerminal(sessionId: string, cmd: string, cwd?: string): Promise<{ output: string; code: number; cwd: string }> {
  if (!cmd.trim() || cmd.length > 16_000) throw new Error("invalid_command");
  const name = nameFor(sessionId);
  if (!await running(name) || !await running(gatewayName(name))) await ensureGroupContainer(sessionId);
  await blockHostAddresses(gatewayName(name));
  // 客户端只提供格式合法的绝对路径即可；路径不存在时 docker 会报错并透出。
  const workdir = typeof cwd === "string" && cwd.startsWith("/") && cwd.length <= 4096 && !/[\0\r\n]/.test(cwd) ? cwd : "/group/artifacts";
  const CWD_MARK = "__AGENT_CWD__";
  const script = [
    'ls() { command ls --color=auto "$@"; }',
    'grep() { command grep --color=auto "$@"; }',
    cmd,
    "s=$?",
    `printf '\\n${CWD_MARK}%s' "$(pwd)"`,
    "exit $s",
  ].join("\n");
  // LANG 显式给上：`ls` 在 POSIX locale 下的 tty 输出会把中文名转成 `''$'\350\277\224...'`。
  const { output, code } = await dockerCombined(["exec", "-t", "--env", "LANG=C.UTF-8", "--workdir", workdir, name, "timeout", "120", "sh", "-lc", script], 125_000);
  const text = output.replace(/\r/g, ""); // PTY 会把 \n 变成 \r\n，统一剥掉
  const mark = text.lastIndexOf(CWD_MARK);
  if (mark < 0) return { output: text.replace(/^\n+|\n+$/g, ""), code, cwd: workdir };
  return {
    output: text.slice(0, mark).replace(/\n+$/, ""),
    code,
    cwd: text.slice(mark + CWD_MARK.length).trim() || workdir,
  };
}

/** Web 终端 Tab 补全：命令位用 bash compgen -c（PATH 里的可执行文件），其余按目录 ls -1Ap（目录带 / 结尾）。
 *  容器没跑起来时直接返回空——不为一次补全去冷启动容器（会等镜像构建）。 */
export async function completeGroupBash(sessionId: string, cwd: string, token: string, isCommand: boolean): Promise<string[]> {
  const name = nameFor(sessionId);
  if (!await running(name)) return [];
  const workdir = typeof cwd === "string" && cwd.startsWith("/") && cwd.length <= 4096 && !/[\0\r\n]/.test(cwd) ? cwd : "/group/artifacts";
  const clean = token.replace(/[\0\r\n]/g, "");
  if (clean.startsWith("-")) return [];
  if (isCommand) {
    const out = await docker(["exec", "--workdir", workdir, "--env", "LANG=C.UTF-8", name, "bash", "-lc", 'compgen -c "$1"', "bash", clean], 10_000).catch(() => "");
    return [...new Set(out.split(/\r?\n/).map(item => item.trim()).filter(Boolean))].sort().slice(0, 200);
  }
  const slash = clean.lastIndexOf("/");
  const dirPart = slash >= 0 ? clean.slice(0, slash + 1) : "";
  const base = slash >= 0 ? clean.slice(slash + 1) : clean;
  // 只展开开头的 ~ 为群产物根目录；相对路径交给 --workdir 解析，候选保留用户输入的 dirPart 原样回显。
  const dir = dirPart.startsWith("~") ? `/group/artifacts${dirPart.slice(1)}` : dirPart || ".";
  // Tab 补全的候选列表也走这条非 tty 的 ls：POSIX locale 下中文名会被转义成
  // `''$'\350\277\224...'`（用户看到的就是这串乱码），必须带 LANG。
  const out = await docker(["exec", "--workdir", workdir, "--env", "LANG=C.UTF-8", name, "sh", "-lc", 'exec ls -1Ap "$1"', "sh", dir], 10_000).catch(() => "");
  const lower = base.toLowerCase();
  return out.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
    .filter(entry => (!base || entry.toLowerCase().startsWith(lower)) && (base.startsWith(".") || !entry.startsWith(".")))
    .slice(0, 500)
    .map(entry => `${dirPart}${entry}`);
}

/** 预览应用固定监听容器内 3000（网关把 3000/tcp 映射到宿主 127.0.0.1:<随机端口>）。 */
const PREVIEW_PORT = 3000;
const PREVIEW_LOG = "/group/artifacts/.preview.log";

/** 3000 端口的监听者 pid（无监听返回空串）。
 *  判「应用在不在跑」必须看端口，不能看 fetch：dev server 首次编译时 HTTP 会挂 20-35s，
 *  靠 fetch 超时判断会误判成“没在跑”，于是重复启动第二个实例 → EADDRINUSE（曾真实发生）。 */
async function previewListenerPid(name: string): Promise<string> {
  const { output } = await execCapture(name, ["sh", "-lc",
    `(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':${PREVIEW_PORT} ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`,
  ], 10_000).catch(() => ({ output: "", code: -1 }));
  const pid = (output.trim().split(/\s+/)[0]) ?? "";
  return /^\d+$/.test(pid) ? pid : "";
}

/** 端口是否在监听（拿不到 pid 时也能判断；ss / netstat 都缺则读 /proc/net/tcp）。 */
async function previewPortListening(name: string): Promise<boolean> {
  const { output } = await execCapture(name, ["sh", "-lc",
    `if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -qE ':${PREVIEW_PORT} ' && echo YES; ` +
    `elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | grep -qE ':${PREVIEW_PORT} ' && echo YES; ` +
    `else awk 'NR>1 && $2 ~ /:0BB8$/ && $4 == "0A" { f=1 } END { exit(f?0:1) }' /proc/net/tcp && echo YES; fi`,
  ], 10_000).catch(() => ({ output: "", code: -1 }));
  return output.includes("YES");
}

/** 释放预览端口：杀掉仍占着 3000 的旧进程，并等端口真正空出来。
 *  启动前不做这步，旧实例还活着时再 exec 一次必然 EADDRINUSE。
 *  ⚠️ 只杀监听者及其直接子进程，**绝不要按进程组 kill**：docker exec 出来的进程 pgid 可能就是 1，
 *  `kill -9 -1` 会把容器里所有进程（含用户正在用的终端会话）一起打掉。 */
async function freePreviewPort(name: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pid = await previewListenerPid(name);
    if (!pid) return;
    await execCapture(name, ["sh", "-lc",
      `for c in $(cat /proc/${pid}/task/*/children 2>/dev/null); do kill -9 "$c" 2>/dev/null; done; ` +
      `kill -9 ${pid} 2>/dev/null; true`,
    ], 10_000).catch(() => ({ output: "", code: -1 }));
    for (let i = 0; i < 12; i++) {
      if (!await previewPortListening(name)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

/** 应用是否真的在提供 HTTP。三种结果必须分开：
 *  - ok   有响应（任何状态码都算：设了 basePath 的应用对根路径本来就返回 404）；
 *  - dead 连接被拒/重置：进程已死但端口还没释放，需要清掉重启；
 *  - busy 超时：多半还在首次编译，属于“在跑但慢”，不能当失败。 */
async function probePreview(origin: string, timeoutMs: number): Promise<"ok" | "dead" | "busy"> {
  try { await fetch(origin, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" }); return "ok"; }
  catch (error) {
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET") return "dead";
    return (error as Error)?.name === "TimeoutError" ? "busy" : "dead";
  }
}

async function previewLogTail(name: string, lines = 30): Promise<string> {
  const { output } = await execCapture(name, ["sh", "-lc", `tail -n ${lines} ${PREVIEW_LOG} 2>/dev/null`], 10_000)
    .catch(() => ({ output: "", code: -1 }));
  return output.trim();
}

/** 同一群的启动互斥：代理失败时 `restoreGroupPreview` 会被多个并发请求同时触发，
 *  若不加锁就会有多个 startGroupPreview 在“端口还没开始监听”的窗口里各起一个进程，
 *  再次撞出 EADDRINUSE。 */
const previewStarts = new Map<string, Promise<void>>();

export function startGroupPreview(sessionId: string, cmd: string): Promise<void> {
  const inflight = previewStarts.get(sessionId);
  if (inflight) return inflight;
  const task = doStartGroupPreview(sessionId, cmd).finally(() => previewStarts.delete(sessionId));
  previewStarts.set(sessionId, task);
  return task;
}

async function doStartGroupPreview(sessionId: string, cmd: string): Promise<void> {
  if (!cmd.trim() || cmd.length > 16_000) throw new Error("invalid_preview_command");
  const name = nameFor(sessionId);
  if (!await running(name) || !await running(gatewayName(name))) await ensureGroupContainer(sessionId);
  await blockHostAddresses(gatewayName(name));
  const origin = await groupPreviewOrigin(sessionId);
  // 幂等：同一个群同一时刻只跑一个预览应用。判据是「3000 是否在监听」而不是「fetch 有没有响应」。
  if (await previewPortListening(name)) {
    const state = await probePreview(origin, 30_000);
    // busy（正在编译）与 ok 都算在跑；只有 dead（端口在、进程已死）才清掉重来。
    if (state !== "dead") return;
  }
  await freePreviewPort(name);
  // 每次启动前把日志截到最近 400 行并写一条分隔头：报错时能把「本次」日志尾带上，
  // 不用让用户去 cat 一个混着历次启动的日志。
  await execCapture(name, ["sh", "-lc",
    `tail -n 400 ${PREVIEW_LOG} > ${PREVIEW_LOG}.tmp 2>/dev/null; mv ${PREVIEW_LOG}.tmp ${PREVIEW_LOG} 2>/dev/null; ` +
    `printf '%s\\n' "=== preview start $(date -u +%FT%TZ): $1 ===" >> ${PREVIEW_LOG}`,
    "sh", cmd], 10_000).catch(() => ({ output: "", code: -1 }));
  await docker(["exec", "-d", "--workdir", "/group/artifacts", "--env", "PORT=3000", "--env", "HOST=0.0.0.0", "--env", "LANG=C.UTF-8",
    name, "sh", "-lc", `(${cmd}) >> ${PREVIEW_LOG} 2>&1`]);
  // 就绪判据＝端口开始监听。dev server 在首次请求时才编译路由（实测 25-35s），
  // 等 HTTP 响应会白等；但若立刻拿到「连接被拒」说明进程刚崩，要继续等/重试。
  const deadline = Date.now() + 90_000;
  for (let round = 0; Date.now() < deadline; round++) {
    if (await previewPortListening(name)) {
      if (await probePreview(origin, 3_000) !== "dead") return;
    }
    // 每 5 轮看一眼日志：出现确定的启动失败就立刻报错，别让用户白等 90s。
    if (round > 0 && round % 5 === 0) {
      const tail = await previewLogTail(name, 30);
      if (/EADDRINUSE|Failed to start server|command not found|ENOENT|npm ERR!/i.test(tail)) {
        throw new Error(`preview_did_not_start:\n${tail.slice(-800)}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const tail = await previewLogTail(name, 30);
  throw new Error(`preview_did_not_start; see ${PREVIEW_LOG}\n${tail.slice(-800)}`);
}

export async function removeGroupContainer(sessionId: string): Promise<void> {
  await removeByName(nameFor(sessionId));
}

export async function groupPreviewOrigin(sessionId: string): Promise<string> {
  const gateway = gatewayName(nameFor(sessionId));
  if (!await running(gateway)) await ensureGroupContainer(sessionId);
  const address = (await docker(["port", gateway, "3000/tcp"])).trim().split(/\r?\n/)[0];
  const match = address.match(/^127\.0\.0\.1:(\d+)$/);
  if (!match) throw new Error("preview_port_unavailable");
  return `http://127.0.0.1:${match[1]}`;
}
