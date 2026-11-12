/** Database backed credentials for the built-in provider. */
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ensureMigrated, getPool } from "./db.js";
import type { AuthUser } from "./types.js";

const scrypt = promisify(scryptCallback);
const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = Buffer.alloc(64);

function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(username)) throw new Error("用户名须为 3–128 位英文字母、数字、点、下划线或连字符");
  return username;
}

async function hashPassword(password: string): Promise<string> {
  if (password.length < 6 || Buffer.byteLength(password) > 1024) throw new Error("密码须为 6 位以上，且不超过 1024 字节");
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}

/** Public self-registration. Existing credentials are never overwritten. */
export async function registerBuiltinUser(usernameInput: string, password: string): Promise<AuthUser> {
  const username = normalizeUsername(usernameInput);
  const passwordHash = await hashPassword(password);
  const pool = getPool();
  if (!pool) throw new Error("PostgreSQL 未配置");
  await ensureMigrated();
  const client = await pool.connect();
  const unionId = randomUUID();
  try {
    await client.query("BEGIN");
    const user = await client.query(
      "INSERT INTO users(provider,union_id,open_id,user_code,name) VALUES('builtin',$1,$1,$2,$2) RETURNING id",
      [unionId, username],
    );
    await client.query("INSERT INTO builtin_credentials(user_id,username,password_hash) VALUES($1,$2,$3)",
      [user.rows[0].id, username, passwordHash]);
    await client.query("COMMIT");
    return { provider: "builtin", unionId, openId: unionId, userCode: username, name: username };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

/** Returns the same error for unknown users and wrong passwords. */
export async function verifyBuiltinPassword(usernameInput: string, password: string): Promise<AuthUser | null> {
  let username: string;
  try { username = normalizeUsername(usernameInput); } catch { username = ""; }
  if (Buffer.byteLength(password) > 1024) return null;
  const pool = getPool();
  if (!pool) throw new Error("PostgreSQL 未配置");
  await ensureMigrated();
  const result = await pool.query(
    `SELECT u.union_id, u.user_code, u.name, u.avatar, c.password_hash FROM builtin_credentials c
     JOIN users u ON u.id=c.user_id AND u.provider='builtin' WHERE u.user_code=$1`, [username]);
  const row = result.rows[0];
  const parts = typeof row?.password_hash === "string" ? row.password_hash.split(":") : [];
  const salt = parts[0] === "scrypt" && /^[0-9a-f]{32}$/.test(parts[1] || "") ? parts[1] : DUMMY_SALT;
  const expected = parts[0] === "scrypt" && /^[0-9a-f]{128}$/.test(parts[2] || "") ? Buffer.from(parts[2], "hex") : DUMMY_HASH;
  const actual = await scrypt(password, salt, 64) as Buffer;
  if (!row || !timingSafeEqual(actual, expected)) return null;
  return { provider: "builtin", unionId: String(row.union_id), openId: String(row.union_id), userCode: String(row.user_code), name: String(row.name || row.user_code), avatar: typeof row.avatar === "string" ? row.avatar : undefined };
}
