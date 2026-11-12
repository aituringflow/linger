/**
 * 登录窗凭据存储（记住上一次登录的用户）。
 *
 * Electron 里没有浏览器那套密码管理器：Chromium 的「保存密码 / 自动填充」是浏览器外壳
 * 的功能，Electron 既不打包它的 UI，也没有 savePassword 之类的 API，所以登录页在
 * 应用内拿不到任何自动填充——这跟网页端（Chrome / Safari 自己弹「是否保存密码」）不同。
 *
 * 这里用 safeStorage 自己做一层：它在 macOS 走系统钥匙串（"Electron Safe Storage" 条目）、
 * Windows 走 DPAPI、Linux 走 libsecret，密文只落在 userData 里。
 *   - 用户名明文存：即使系统加密不可用，也还能把上次的用户名带出来；
 *   - 密码只存密文，加密不可用时**拒绝保存**（不往磁盘写明文密码）。
 * 仅登录窗（launcher:open-login 创建的那个 webContents）可读写，见 main/index.ts 的 IPC 校验。
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface SavedLoginCredential {
  username: string;
  /** 无密码（只记住了用户名 / 系统加密不可用）时为 "" */
  password: string;
}

interface CredentialFile {
  version: 1;
  username: string;
  /** safeStorage 加密后的密文（base64） */
  secret?: string;
  updatedAt: number;
}

const FILE_NAME = "login-credentials.json";
const filePath = () => path.join(app.getPath("userData"), FILE_NAME);

function readFile(): CredentialFile | null {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CredentialFile>;
    if (!parsed || typeof parsed.username !== "string" || !parsed.username) return null;
    return {
      version: 1,
      username: parsed.username,
      secret: typeof parsed.secret === "string" && parsed.secret ? parsed.secret : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeFile(data: CredentialFile): boolean {
  const target = filePath();
  const temp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 先写临时文件再 rename，避免中途崩溃留下半个 JSON
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temp, target);
    return true;
  } catch {
    try { fs.unlinkSync(temp); } catch { /* ignore */ }
    return false;
  }
}

/** 系统加密是否可用（macOS/Windows 基本恒为 true；部分 Linux 无 keyring 时为 false）。 */
export function isCredentialEncryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

/** 读取上次登录的账号；密码解不出来（换机器 / 钥匙串条目被删）时只返回用户名。 */
export function readSavedLoginCredential(): SavedLoginCredential | null {
  const data = readFile();
  if (!data) return null;
  let password = "";
  if (data.secret) {
    try { password = safeStorage.decryptString(Buffer.from(data.secret, "base64")); } catch { password = ""; }
  }
  return { username: data.username, password };
}

/**
 * 保存/更新上次登录账号。rememberPassword=false 表示只记用户名（用户取消了「记住密码」）。
 * 返回 false 表示没写成功（例如系统加密不可用而这次要存密码）。
 */
export function saveLoginCredential(username: string, password: string): boolean {
  const name = username.trim();
  if (!name) return false;
  if (!password) return writeFile({ version: 1, username: name, updatedAt: Date.now() });
  if (!isCredentialEncryptionAvailable()) return false;
  let secret: string;
  try {
    secret = safeStorage.encryptString(password).toString("base64");
  } catch {
    return false;
  }
  return writeFile({ version: 1, username: name, secret, updatedAt: Date.now() });
}

/** 彻底忘掉（用户取消勾选并登录、或退出登录时清理密码）。 */
export function clearSavedLoginCredential(): boolean {
  try { fs.unlinkSync(filePath()); return true; } catch { return false; }
}
