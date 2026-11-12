import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_HOME_DIR } from "./app-name.js";

// The wrapping key is stored locally alongside the encrypted credential. This
// avoids Keychain prompts, but does not protect against other processes running
// as the same OS user that can read both files.
const dir = () => path.join(APP_HOME_DIR, "credentials");
const keyFile = () => path.join(dir(), "dsh.key");
const credentialFile = () => path.join(dir(), "dsh.json");

function readWrappingKey(): Buffer {
  const key = fs.readFileSync(keyFile());
  if (key.length !== 32) throw new Error("DSH 密钥文件无效");
  return key;
}

function ensureWrappingKey(): Buffer {
  try { return readWrappingKey(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try { fs.writeFileSync(keyFile(), key, { mode: 0o600, flag: "wx" }); return key; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return readWrappingKey(); throw error; }
}

/** Returns no secret to the renderer. A corrupt or missing credential is treated as unconfigured. */
export function readDshKey(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(credentialFile(), "utf8")) as Record<string, unknown>;
    if (data.version !== 1 || typeof data.iv !== "string" || typeof data.tag !== "string" || typeof data.secret !== "string") return null;
    const iv = Buffer.from(data.iv, "base64");
    const tag = Buffer.from(data.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", readWrappingKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(data.secret, "base64")), decipher.final()]).toString("utf8") || null;
  } catch { return null; }
}

export function saveDshKey(value: string): void {
  const key = value.trim();
  if (!key || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error("API Key 格式无效");
  const wrappingKey = ensureWrappingKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  const secret = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  const data = JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), secret: secret.toString("base64") });
  const target = credentialFile();
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch { /* no temporary file */ } }
}

export function deleteDshKey(): void {
  try { fs.unlinkSync(credentialFile()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
