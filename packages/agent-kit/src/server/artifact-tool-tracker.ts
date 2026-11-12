/**
 * Attribute file changes to actual tool executions. Explicit file tools retain a
 * before image; shell tools compare bounded filesystem snapshots around the call.
 * This is deliberately independent of command syntax (Python, redirects, scripts,
 * and PowerShell all work), and never sweeps the server's implicit process.cwd().
 *
 * Shell attribution covers the supplied workspace/cwd and this session's output
 * directories only. Dependencies, builds, caches, logs, staging and symlinks are
 * excluded. Concurrent external writes inside those roots cannot be distinguished
 * from a shell's writes; background commands that finish after flush are likewise
 * outside the observation window. Explicit file tools do not have these scan limits.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  capturePreWriteSnapshot,
  isIntermediateRel,
  isTextDiffable,
  normalizeArtifactAbsPath,
  registerArtifactPath,
  sessionDirCandidates,
  getArtifactDirName,
  type ArtifactStamp,
} from "./artifacts.js";

const FILE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const SKIP_DIRECTORIES = new Set([
  ".agent", ".git", ".hg", ".svn", ".codebuddy", ".workbuddy", ".browser-agent-profile",
  ".web-fetch-profile", ".shots", "node_modules", "vendor", ".venv", "venv", "__pycache__",
  ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".next", ".nuxt", ".turbo",
  ".vite", "coverage", "dist", "build", "out", "target", "bin", "obj", "logs", "log",
  "tmp", "temp", "_tmp", "_drafts", "_intermediate", "attachments", "tool-results", "subagents",
]);
const SKIP_FILES = /(?:\.(?:log|tmp|temp|swp|swo|pid|tsbuildinfo)|(?:^|[.])DS_Store|^Thumbs\.db)$/i;
const CONTENT_LIMIT = 512 * 1024;
const ABSENT: ArtifactStamp = { exists: false, mtimeNs: 0n, size: 0, content: null };

export interface ArtifactScanLimits {
  maxEntries: number;
  maxFiles: number;
  maxDirectories: number;
  maxDepth: number;
  maxTotalContentBytes: number;
  maxDurationMs: number;
}

const DEFAULT_LIMITS: ArtifactScanLimits = {
  maxEntries: 20_000,
  maxFiles: 8_000,
  maxDirectories: 1_500,
  maxDepth: 24,
  maxTotalContentBytes: 32 * 1024 * 1024,
  maxDurationMs: 5_000,
};

export interface ArtifactToolTrackerOptions {
  sessionId: string;
  workspaceDir?: string;
  cwd?: string;
  /** Shared for the whole turn; a missing-file stamp must survive later edits. */
  preWrite: Map<string, ArtifactStamp>;
  onWarning?: (message: string) => void;
  scanLimits?: Partial<ArtifactScanLimits>;
}

interface ScanRoot { abs: string; session: boolean }
interface Snapshot {
  files: Map<string, ArtifactStamp>;
  /** A directory is present here only after its entire listing was read. */
  directories: Map<string, Set<string>>;
  missingRoots: Set<string>;
}
interface PendingTool {
  id?: string;
  name: string;
  fingerprint: string;
  paths: string[];
  before?: Snapshot;
  explicitBefore?: Map<string, ArtifactStamp>;
}

function isWithin(abs: string, root: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep));
}

/** Unknown (unreadable/truncated/excluded) is not the same as absent. */
function snapshotStamp(snapshot: Snapshot, abs: string): ArtifactStamp | undefined {
  const known = snapshot.files.get(abs);
  if (known) return known;
  for (const root of snapshot.missingRoots) if (isWithin(abs, root)) return ABSENT;
  let child = abs;
  for (;;) {
    const parent = path.dirname(child);
    if (child === parent) return undefined;
    const names = snapshot.directories.get(parent);
    if (names && !names.has(path.basename(child))) return ABSENT;
    child = parent;
  }
}

function sameStamp(before: ArtifactStamp, after: ArtifactStamp): boolean {
  if (before.exists === false || after.exists === false) return before.exists === after.exists;
  if (before.digest && after.digest) return before.digest === after.digest;
  if (before.content != null && after.content != null) return before.content === after.content;
  return before.mtimeNs === after.mtimeNs && before.size === after.size;
}

function fingerprint(input: Record<string, unknown>): string {
  try { return JSON.stringify(input); } catch { return ""; }
}

function extractPaths(input: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  const add = (record: Record<string, unknown>) => {
    for (const key of ["file_path", "path", "notebook_path"]) {
      if (typeof record[key] === "string" && record[key].trim()) paths.add(record[key]);
    }
  };
  // MultiEdit normally has ONE top-level file_path, with only replacement pairs
  // inside edits; some providers instead supply a path on every edit.
  add(input);
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) if (edit && typeof edit === "object") add(edit as Record<string, unknown>);
  }
  return [...paths];
}

export function createArtifactToolTracker(options: ArtifactToolTrackerOptions) {
  const { sessionId, workspaceDir, cwd, preWrite } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.scanLimits };
  const warnings = new Set<string>();
  const warn = (reason: string) => {
    if (warnings.has(reason)) return;
    warnings.add(reason);
    const message = `[artifacts] ${reason}`;
    try { (options.onWarning ?? console.warn)(message); } catch { /* Observability must not stop a tool. */ }
  };
  const roots: ScanRoot[] = [];
  for (const supplied of [workspaceDir, cwd]) {
    if (!supplied?.trim()) continue;
    const abs = path.resolve(supplied.trim());
    // Even an explicitly configured drive root is not a useful scan boundary.
    if (abs === path.parse(abs).root) {
      warn("Shell artifact scanning skipped a filesystem root; use a specific workspace directory.");
      continue;
    }
    if (!roots.some((root) => root.abs === abs)) roots.push({ abs, session: false });
  }
  // The normal workspace walk skips all .agent directories. Add only this
  // session's roots explicitly, including nested documents and sandbox outputs.
  for (const candidate of sessionDirCandidates(sessionId, workspaceDir)) {
    const abs = path.resolve(candidate);
    const existing = roots.find((root) => root.abs === abs);
    if (existing) existing.session = true;
    else roots.push({ abs, session: true });
  }

  const scan = async (): Promise<Snapshot> => {
    const result: Snapshot = { files: new Map(), directories: new Map(), missingRoots: new Set() };
    const started = Date.now();
    let entries = 0;
    let directories = 0;
    let contentBytes = 0;
    let exhausted = false;
    const atLimit = () => {
      if (exhausted) return true;
      if (entries >= limits.maxEntries || result.files.size >= limits.maxFiles ||
          directories >= limits.maxDirectories || Date.now() - started >= limits.maxDurationMs) {
        exhausted = true;
        warn("Shell artifact scan reached its entry/file/directory/time limit; some changes may be untracked. Narrow the workspace or use explicit file tools.");
      }
      return exhausted;
    };
    const visit = async (abs: string, root: ScanRoot, depth: number): Promise<void> => {
      if (result.directories.has(abs) || atLimit()) return;
      if (depth > limits.maxDepth) {
        warn("Shell artifact scan reached its directory depth limit; deeper files may be untracked.");
        return;
      }
      const names = new Set<string>();
      const children: string[] = [];
      try {
        // opendir bounds memory even when a directory contains many entries.
        const dir = await fs.opendir(abs);
        directories++;
        let complete = true;
        for await (const entry of dir) {
          if (atLimit()) { complete = false; break; }
          entries++;
          names.add(entry.name);
          const child = path.join(abs, entry.name);
          if (entry.isSymbolicLink()) continue;
          const rel = path.relative(root.abs, child);
          if (root.session && isIntermediateRel(rel)) continue;
          if (entry.isDirectory()) {
            // 跳过内置产物目录：用 SKIP_DIRECTORIES 兜底默认名，再用 getArtifactDirName() 覆盖自定义名，
            // 避免其他会话的产物目录被当作用户文件扫进快照造成泄漏。
            if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase()) && entry.name !== getArtifactDirName()) children.push(child);
            continue;
          }
          if (!entry.isFile() || SKIP_FILES.test(entry.name)) continue;
          try {
            const stat = await fs.lstat(child, { bigint: true });
            if (!stat.isFile()) continue;
            const size = Number(stat.size);
            let data: Buffer | undefined;
            if (size <= CONTENT_LIMIT) {
              if (contentBytes + size <= limits.maxTotalContentBytes) {
                contentBytes += size;
                data = await fs.readFile(child).catch(() => undefined);
              } else {
                warn("Shell artifact snapshots reached their content budget; additional files retain metadata but may have no text diff.");
              }
            }
            result.files.set(child, {
              exists: true,
              mtimeNs: stat.mtimeNs,
              size,
              content: data && isTextDiffable(child) && !data.includes(0) ? data.toString("utf8") : null,
              digest: data ? createHash("sha256").update(data).digest("hex") : undefined,
            });
          } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
              warn("Shell artifact scan could not read some files; their changes may be untracked.");
            }
          }
        }
        if (complete) result.directories.set(abs, names);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (depth === 0 && (code === "ENOENT" || code === "ENOTDIR")) result.missingRoots.add(abs);
        else if (code !== "ENOENT" && code !== "ENOTDIR") warn("Shell artifact scan could not read some directories; their changes may be untracked.");
        return;
      }
      for (const child of children) {
        if (atLimit()) break;
        await visit(child, root, depth + 1);
      }
    };
    // User-facing session documents get priority over a potentially large repo.
    for (const root of [...roots].sort((a, b) => Number(b.session) - Number(a.session))) {
      if (atLimit()) break;
      try {
        const stat = await fs.lstat(root.abs);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) result.missingRoots.add(root.abs);
        else warn("Shell artifact scan could not inspect one of its roots; some changes may be untracked.");
        continue;
      }
      await visit(root.abs, root, 0);
    }
    return result;
  };

  const pending: PendingTool[] = [];
  let queue = Promise.resolve();
  const serialized = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work);
    queue = next.catch((error: unknown) => { warn(`Artifact tool tracking failed: ${error instanceof Error ? error.message : String(error)}`); });
    return queue;
  };
  const remember = (abs: string, stamp: ArtifactStamp) => {
    if (preWrite.has(abs)) return;
    // When tools overlap, an earlier shell may already have written this path
    // before a later explicit tool captures it. Preserve the earliest observation.
    for (const tool of pending) {
      const earlier = tool.before && snapshotStamp(tool.before, abs);
      if (earlier) { preWrite.set(abs, earlier); return; }
    }
    preWrite.set(abs, stamp);
  };
  const register = async (abs: string, before: ArtifactStamp) => {
    remember(abs, before);
    await registerArtifactPath(sessionId, abs, workspaceDir, cwd, "model", preWrite.get(abs));
  };
  const complete = async (tool: PendingTool, shellAfter?: Snapshot) => {
    if (tool.before) {
      const after = shellAfter ?? await scan();
      const paths = new Set([...tool.before.files.keys(), ...after.files.keys()]);
      for (const abs of paths) {
        const beforeStamp = snapshotStamp(tool.before, abs);
        const afterStamp = snapshotStamp(after, abs);
        // A partial scan cannot establish absence. Never turn its omissions into
        // fabricated additions or deletions.
        if (beforeStamp && afterStamp && !sameStamp(beforeStamp, afterStamp)) await register(abs, beforeStamp);
      }
    } else {
      const current = new Map<string, ArtifactStamp>();
      for (const abs of tool.paths) {
        await capturePreWriteSnapshot(abs, current);
        const before = tool.explicitBefore?.get(abs);
        const after = current.get(abs);
        if (before && after && !sameStamp(before, after)) await register(abs, before);
      }
    }
  };

  return {
    before(toolName: string, input: Record<string, unknown>, toolUseId?: string): Promise<void> {
      return serialized(async () => {
        const name = toolName.toLowerCase();
        if (!FILE_TOOLS.has(name) && !SHELL_TOOLS.has(name)) return;
        if (toolUseId && pending.some((tool) => tool.id === toolUseId)) return;
        const tool: PendingTool = { id: toolUseId, name, fingerprint: fingerprint(input), paths: [] };
        if (SHELL_TOOLS.has(name)) {
          tool.before = await scan();
        } else {
          tool.paths = [...new Set(extractPaths(input).map((raw) => normalizeArtifactAbsPath(raw, workspaceDir, cwd)).filter((abs): abs is string => !!abs))];
          tool.explicitBefore = new Map();
          for (const abs of tool.paths) {
            await capturePreWriteSnapshot(abs, tool.explicitBefore);
            const stamp = tool.explicitBefore.get(abs);
            if (stamp) remember(abs, stamp);
          }
        }
        pending.push(tool);
      });
    },
    after(toolName: string, input: Record<string, unknown>, toolUseId?: string): Promise<void> {
      return serialized(async () => {
        const name = toolName.toLowerCase();
        const index = pending.findIndex((tool) => toolUseId ? tool.id === toolUseId : tool.name === name && tool.fingerprint === fingerprint(input));
        if (index === -1) return;
        const tool = pending[index];
        // Keep this snapshot available to remember() until its changed paths have
        // been registered. This also handles missing-file stamps for new outputs.
        await complete(tool);
        pending.splice(index, 1);
      });
    },
    /** Called at turn end/abort, including partial writes from failed tools. */
    flush(): Promise<void> {
      return serialized(async () => {
        const after = pending.some((tool) => tool.before) ? await scan() : undefined;
        while (pending.length) {
          await complete(pending[0], after);
          pending.shift();
        }
      });
    },
  };
}
