import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export interface OtaRelease {
  platform: string;
  version: string;
  filename: string;
  size: number;
  sha256: string;
  url: string;
  appId?: string;
}

export interface OtaClientOptions {
  baseUrl: string | URL;
  platform: "win32" | "darwin";
  version: string;
  downloadDir: string;
  /**
   * 应用通道 ID（包名）。不指定时服务端使用默认通道，行为与单应用模式一致。
   */
  appId?: string;
  onAvailable?: (release: OtaRelease | null) => void;
  onDownloadState?: (state: OtaDownloadState) => void;
  installArtifact: (file: string, release: OtaRelease) => Promise<void>;
  fetch?: typeof fetch;
}

export type OtaDownloadState = { phase: "idle" | "downloading" | "ready" | "error"; downloaded: number; total: number; error?: string };

export function isNewerOtaVersion(remote: string, current: string): boolean {
  const parse = (value: string) => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const a = parse(remote), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export class OtaClient {
  private release: OtaRelease | null = null;
  private checking: Promise<{ version: string; release: OtaRelease | null }> | null = null;
  private download: Promise<string> | null = null;
  private readyFile: string | null = null;
  private downloadState: OtaDownloadState = { phase: "idle", downloaded: 0, total: 0 };
  private installing: Promise<{ ok: boolean; error?: string }> | null = null;
  private readonly base: URL;
  private readonly request: typeof fetch;

  constructor(private readonly options: OtaClientOptions) {
    this.base = new URL(options.baseUrl);
    this.request = options.fetch ?? fetch;
  }

  status() { return { version: this.options.version, release: this.release, download: this.downloadState }; }

  private setDownloadState(state: OtaDownloadState) {
    this.downloadState = state;
    this.options.onDownloadState?.(state);
  }

  check(): Promise<{ version: string; release: OtaRelease | null }> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const endpoint = new URL("api/updates", this.base);
      endpoint.searchParams.set("platform", this.options.platform);
      if (this.options.appId) endpoint.searchParams.set("appId", this.options.appId);
      const response = await this.request(endpoint, { signal: AbortSignal.timeout(15000), cache: "no-store" });
      if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
      const data = await response.json() as Partial<OtaRelease> | { release: null };
      const remote = "version" in data && typeof data.version === "string" &&
        isNewerOtaVersion(data.version, this.options.version) &&
        data.platform === this.options.platform &&
        typeof data.filename === "string" && typeof data.url === "string" &&
        typeof data.sha256 === "string" && /^[a-f0-9]{64}$/i.test(data.sha256) &&
        typeof data.size === "number" && Number.isSafeInteger(data.size) && data.size > 0
        ? data as OtaRelease : null;
      // 校验应用通道一致（如果客户端指定了 appId）
      if (remote && this.options.appId && remote.appId && remote.appId !== this.options.appId) {
        throw new Error(`更新通道不匹配：期望 ${this.options.appId}，实际 ${remote.appId}`);
      }
      if (remote?.sha256 !== this.release?.sha256) {
        this.readyFile = null;
        this.download = null;
        this.setDownloadState({ phase: "idle", downloaded: 0, total: remote?.size ?? 0 });
      }
      this.release = remote;
      this.options.onAvailable?.(remote);
      if (remote && !this.readyFile && !this.download) void this.prepare(remote).catch(() => {});
      return this.status();
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  private prepare(release: OtaRelease): Promise<string> {
    if (this.download) return this.download;
    const task = this.downloadRelease(release);
    this.download = task;
    void task.then((file) => {
      if (this.release?.sha256 === release.sha256) {
        this.readyFile = file;
        this.setDownloadState({ phase: "ready", downloaded: release.size, total: release.size });
      }
    }, (error) => {
      if (this.release?.sha256 === release.sha256) {
        this.setDownloadState({ phase: "error", downloaded: 0, total: release.size, error: error instanceof Error ? error.message : String(error) });
      }
    }).finally(() => { if (this.download === task) this.download = null; });
    return task;
  }

  install(): Promise<{ ok: boolean; error?: string }> {
    if (this.installing) return this.installing;
    const task = this.installReady().finally(() => { this.installing = null; });
    this.installing = task;
    return task;
  }

  private async installReady(): Promise<{ ok: boolean; error?: string }> {
    const release = this.release;
    if (!release) return { ok: false, error: "没有可用更新" };
    try {
      const file = this.readyFile ?? await this.prepare(release);
      if (this.release?.sha256 !== release.sha256) throw new Error("更新版本已变化，请重新检查更新");
      await this.options.installArtifact(file, release);
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  private async downloadRelease(release: OtaRelease): Promise<string> {
      const url = new URL(release.url, this.base);
      // 安全校验：确保下载地址同源且路径以 api/updates/ 开头
      if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname + "api/updates/")) throw new Error("更新地址不可信");
      const response = await this.request(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
      const total = Number(response.headers.get("content-length")) || release.size;
      this.setDownloadState({ phase: "downloading", downloaded: 0, total });
      await fs.promises.mkdir(this.options.downloadDir, { recursive: true });
      // 临时落地文件名：产品名-版本-随机码（如 Agent-0.1.6-<sha256前12位>.exe）
      const fileBase = path.basename(release.filename);
      const fileExt = path.extname(fileBase);
      const nameWithoutExt = fileBase.slice(0, fileBase.length - fileExt.length);
      const destination = path.join(this.options.downloadDir, `${nameWithoutExt}-${release.sha256.slice(0, 12)}${fileExt}`);
      const temporary = `${destination}.download`;
      let downloaded = 0;
      try {
        const writeStream = fs.createWriteStream(temporary);
        for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)) {
          if (!writeStream.write(chunk)) await new Promise<void>((resolve) => writeStream.once("drain", resolve));
          downloaded += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk as Buffer);
          if (this.release?.sha256 === release.sha256) this.setDownloadState({ phase: "downloading", downloaded, total });
        }
        await new Promise<void>((resolve, reject) => writeStream.end((err?: Error | null) => (err ? reject(err) : resolve())));
        const hash = createHash("sha256");
        for await (const chunk of fs.createReadStream(temporary)) hash.update(chunk);
        if (hash.digest("hex").toLowerCase() !== release.sha256.toLowerCase() ||
          (await fs.promises.stat(temporary)).size !== release.size) throw new Error("安装包校验失败");
        await fs.promises.rename(temporary, destination);
      } catch (error) {
        await fs.promises.rm(temporary, { force: true });
        throw error;
      }
      return destination;
  }
}
