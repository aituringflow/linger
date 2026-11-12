// 一次性迁移运行器（测试 / 运维用，非公共代码）。
// 读取 web/.env → 连接 Postgres → 执行 agent-kit 的 schema.sql（幂等建表）。
// 用法：node scripts/migrate-db.mjs [--env path/to/.env]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

// 简单 .env 解析：仅补充尚未存在的变量（不覆盖已设的环境变量）。
function loadEnv(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.warn(`[migrate] 未找到 env 文件：${file}（将仅使用已设置的环境变量）`);
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const envArg = process.argv.includes("--env")
  ? process.argv[process.argv.indexOf("--env") + 1]
  : null;
loadEnv(envArg || path.resolve(here, "../.env"));

const schemaPath = path.resolve(here, "../../../packages/agent-kit/src/server/auth/schema.sql");
const ddl = readFileSync(schemaPath, "utf8");

if (!process.env.POSTGRES_HOST || !process.env.POSTGRES_DB) {
  console.error("[migrate] 缺少 POSTGRES_HOST / POSTGRES_DB，无法连接数据库。");
  process.exit(1);
}

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD || "",
  database: process.env.POSTGRES_DB,
  connectionTimeoutMillis: 10_000,
});

try {
  await pool.query(ddl);
  console.log("✅ schema linger 已就绪（表与索引，幂等）。");
} catch (e) {
  console.error("[migrate] 建表失败：", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
