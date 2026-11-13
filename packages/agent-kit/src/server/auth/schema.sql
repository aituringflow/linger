-- ============================================================================
--  agent-kit · 数据库 schema（PostgreSQL）
--  连接参数见 env：POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD
--
--  本文件是**全新基线**：所有列直接写进 CREATE TABLE，不再保留历史增量（ALTER TABLE /
--  UPDATE 回填 / DO 块迁移）。新仓库从零建库，重复执行只会命中 IF NOT EXISTS。
--  已部署的旧库（表在 public、由增量脚本演进）不在本文件覆盖范围内，需要一次性迁移。
--
--  命名空间：所有对象落在 PostgreSQL schema `linger`（`linger.users`、`linger.agent_sessions` …）。
--  连接池把 search_path 设为 `linger, public`，因此运行期 SQL 里仍是裸表名，不需要改写。
--
--  设计原则
--  ----------
--  1. 认证提供方（钉钉 / 飞书 / 内置账号）只负责"证明你是谁"，用户档案统一收敛到 users 表；
--     业务表（会话 / 分享 / 文件）以**用户主体键** `${provider}:${unionId}` 为归属键
--     （即会话 Cookie 的 sub），不引用自增 users.id。
--  2. 跨应用唯一身份用 union_id（钉钉 unionid / 飞书 union_id），企业内唯一用 open_id；
--     企业内部工号落到 user_code，便于通讯录二次查询。
--  3. raw_profile 以 JSONB 保留原始返回，新字段无需改表即可读取。
--
--  幂等：全部 IF NOT EXISTS，可重复执行（migrate 与 db:migrate 都会多次调用本文件）。
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS linger;
SET search_path TO linger, public;

-- ---------------------------------------------------------------------------
--  users：认证提供方同步过来的成员主数据（内置账号也落这里，provider='builtin'）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id               BIGSERIAL PRIMARY KEY,
  provider         VARCHAR(16)   NOT NULL,               -- 'dingtalk' | 'feishu' | 'builtin'
  union_id         VARCHAR(128)  NOT NULL,               -- 跨应用唯一（钉钉 unionid / 飞书 union_id）
  open_id          VARCHAR(128),                         -- 企业内唯一（钉钉 openId / 飞书 open_id）
  user_code        VARCHAR(128),                         -- 企业内部工号（钉钉 userid / 飞书 employee_id）
  name             VARCHAR(128)  NOT NULL DEFAULT '',
  avatar           TEXT,
  email            VARCHAR(256),
  mobile           VARCHAR(64),
  dept_name        VARCHAR(256),
  raw_profile      JSONB,                                -- 原始档案，便于后续扩展字段
  fs_user_token    TEXT,                                 -- 飞书 user_access_token（约 2h）
  fs_refresh_token TEXT,                                 -- 飞书续期令牌（offline_access）
  memory_public    BOOLEAN       NOT NULL DEFAULT true,   -- 记忆是否可被群聊共享（用户可关）
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_login_at    TIMESTAMPTZ,
  CONSTRAINT uq_users_provider_union_id UNIQUE (provider, union_id)
);

CREATE INDEX IF NOT EXISTS idx_users_provider_open_id   ON users (provider, open_id);
CREATE INDEX IF NOT EXISTS idx_users_provider_user_code ON users (provider, user_code);

-- 内置账号凭据与 OAuth 档案分离；用户名只在 builtin 命名空间唯一。
CREATE TABLE IF NOT EXISTS builtin_credentials (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username      VARCHAR(128) NOT NULL UNIQUE,
  password_hash TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
--  企业通讯录缓存（按 organization_key 分组，供通讯录搜索）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_contact_sync (
  organization_key TEXT PRIMARY KEY,
  provider         VARCHAR(16) NOT NULL,
  synced_at        TIMESTAMPTZ,
  attempted_at     TIMESTAMPTZ,
  last_error       TEXT
);

CREATE TABLE IF NOT EXISTS company_contacts (
  organization_key TEXT         NOT NULL,
  provider         VARCHAR(16)  NOT NULL,
  contact_id       VARCHAR(128) NOT NULL,
  name             TEXT         NOT NULL,
  department       TEXT         NOT NULL DEFAULT '',
  title            TEXT         NOT NULL DEFAULT '',
  avatar           TEXT         NOT NULL DEFAULT '',
  email            TEXT         NOT NULL DEFAULT '',
  mobile           TEXT         NOT NULL DEFAULT '',
  pinyin           TEXT         NOT NULL DEFAULT '',
  PRIMARY KEY (organization_key, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_company_contacts_search ON company_contacts (organization_key, name);

CREATE TABLE IF NOT EXISTS company_contact_search_results (
  user_key   VARCHAR(160) NOT NULL,
  contact_id VARCHAR(128) NOT NULL,
  name       TEXT         NOT NULL,
  avatar     TEXT         NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ  NOT NULL,
  PRIMARY KEY (user_key, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_company_contact_search_results_expiry ON company_contact_search_results (expires_at);

-- ---------------------------------------------------------------------------
--  agent_sessions：用户的对话会话（会话列表 / 侧边栏 CRUD / 群聊配置）
--  id 与前端、CLI 使用的 sessionId 一致（UUID 文本）。
--  user_id 存**用户主体键** `${provider}:${unionId}`：身份以 provider 侧标识为准，
--  users 表仅作档案存储，故无外键；按 user_id 隔离归属。
--  cowork_* 列是群聊（IM/群 AI）配置；workflows 是会话内的作业实例。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                      TEXT         PRIMARY KEY,
  user_id                 VARCHAR(160) NOT NULL,
  title                   VARCHAR(256) NOT NULL DEFAULT '新对话',
  user_renamed            BOOLEAN      NOT NULL DEFAULT false,      -- 用户手动命名后，自动标题不再覆盖
  workspace_dir           TEXT,                                    -- 本会话工作目录（沙箱范围；NULL=不限）
  project_dir             TEXT,                                    -- 仅跨端显示项目分组，不授予文件访问
  view_layout             VARCHAR(16)  NOT NULL DEFAULT 'single',   -- single / split / compare
  pin_order               INTEGER,                                 -- NULL=未置顶
  workflows               JSONB        NOT NULL DEFAULT '[]'::jsonb,
  cowork_ever_group       BOOLEAN      NOT NULL DEFAULT false,      -- 曾是群聊即永久 true
  ref_group_id            TEXT,                                    -- 1v1 会话接入的群（可读 uploads、读写 artifacts）
  cowork_mode             VARCHAR(16)  NOT NULL DEFAULT 'codebuddy',
  cowork_model            TEXT,
  cowork_codex_model      TEXT,
  cowork_reply_policy     VARCHAR(20)  NOT NULL DEFAULT 'mentions_only',
  cowork_fast_prompt      TEXT,
  cowork_avatar           TEXT         NOT NULL DEFAULT '',
  cowork_start_id         BIGINT       NOT NULL DEFAULT 0,
  cowork_container_enabled BOOLEAN     NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 已有数据库的建表语句不会重新执行列定义，需要单独补齐。
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS user_renamed BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_agent_sessions_user ON agent_sessions (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_session_members (
  session_id TEXT         NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  provider   VARCHAR(16)  NOT NULL,
  contact_id VARCHAR(128) NOT NULL,
  name       VARCHAR(128) NOT NULL DEFAULT '',
  avatar     TEXT         NOT NULL DEFAULT '',
  added_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, provider, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_session_members_identity ON agent_session_members (provider, contact_id);

-- ---------------------------------------------------------------------------
--  agent_messages：会话内的消息（历史恢复 / 会话列表预览 / 群聊事件）
--  steps：助手消息的分步思考（thinking 全文 / 中间小结 text / 工具调用 tool /
--        结构化提问 ask / 每步用时 secs），JSONB 保存，刷新后完整恢复思考胶囊。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_messages (
  id                BIGSERIAL   PRIMARY KEY,
  session_id        TEXT        NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role              VARCHAR(16) NOT NULL,             -- 'user' | 'assistant' | 'system'（群事件）| 'reaction'
  content           TEXT        NOT NULL DEFAULT '',
  images            JSONB,                            -- 图片附件 base64（可选，不用于恢复渲染）
  steps             JSONB,                            -- 分步思考过程（thinking/text/tool/ask/secs）
  thinking_secs     INTEGER,                          -- 助手消息总用时（秒）
  elapsed_secs      INTEGER,                          -- 用户发送 → 本轮答复结束的用时（秒）
  model_info        JSONB,                            -- { usedFallback, fallbackModel, models }
  artifacts         JSONB,                            -- [{id,name,type,size}]
  attachment        JSONB,                            -- 用户上传附件 { url, name, size }
  forwarded_bundle  JSONB,                            -- 合并分享的原消息快照
  voice             JSONB,                            -- 语音消息 { fileId, durationMs, mimeType }
  cost_info         JSONB,                            -- { costUsd, usage: { input_tokens, output_tokens } }
  run_id            TEXT,                             -- 可恢复任务的答复幂等键
  sender_sub        VARCHAR(160),                     -- 群聊发言者主体键
  reply_to_id       BIGINT,                           -- 引用回复的消息 id
  client_message_id TEXT,                             -- 客户端发送幂等键
  cowork_agent_id   TEXT,                             -- 群 AI 发言者
  cowork_agent_name TEXT,
  revoked_at        TIMESTAMPTZ,                       -- 撤回时间
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages (session_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_run
  ON agent_messages (session_id, run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_client_message
  ON agent_messages (session_id, sender_sub, client_message_id) WHERE client_message_id IS NOT NULL;

-- 阅读游标：消息 id 单调递增，跨设备按同一顺序取未读。
CREATE TABLE IF NOT EXISTS agent_session_reads (
  session_id           TEXT        NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  user_sub             VARCHAR(160) NOT NULL,
  last_read_message_id BIGINT      NOT NULL DEFAULT 0,
  muted                BOOLEAN     NOT NULL DEFAULT false,  -- 全量免打扰
  ai_muted             BOOLEAN     NOT NULL DEFAULT false,  -- 仅 AI 消息免打扰
  hidden               BOOLEAN     NOT NULL DEFAULT false,  -- 对本用户软删除
  deleted_through_id   BIGINT      NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_sub)
);

-- ---------------------------------------------------------------------------
--  实时通道（WebSocket 重放：断线后按游标补发，水位线用于跨端重同步）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS realtime_events (
  seq        BIGSERIAL PRIMARY KEY,
  session_id TEXT        NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  event      TEXT        NOT NULL,
  data       JSONB       NOT NULL,
  run_id     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_realtime_events_session ON realtime_events (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_realtime_events_created ON realtime_events (created_at, seq);

CREATE TABLE IF NOT EXISTS realtime_watermarks (
  session_id  TEXT   PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  through_seq BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  endpoint   TEXT         PRIMARY KEY,
  user_sub   VARCHAR(160) NOT NULL,
  p256dh     TEXT         NOT NULL,
  auth       TEXT         NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user ON web_push_subscriptions (user_sub);

-- ---------------------------------------------------------------------------
--  群 AI（cowork）：群里的多个 AI 人格、连接器、管理员、发言记录
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cowork_agents (
  id              TEXT         PRIMARY KEY,
  session_id      TEXT         NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  name            VARCHAR(80)  NOT NULL,
  prompt          TEXT         NOT NULL DEFAULT '',
  enabled         BOOLEAN      NOT NULL DEFAULT true,
  created_by      VARCHAR(160) NOT NULL,
  container_enabled BOOLEAN    NOT NULL DEFAULT false,
  preview_token   TEXT,
  preview_command TEXT,
  reply_policy    VARCHAR(20)  NOT NULL DEFAULT 'mentions_only',
  speaking_prompt TEXT         NOT NULL DEFAULT '',
  prompt_by_policy JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- 每种发言策略各一套提示词
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (session_id, name),
  UNIQUE (session_id, id)                                   -- 供连接器复合外键引用
);

CREATE INDEX IF NOT EXISTS idx_cowork_agents_session ON cowork_agents (session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_agents_name_ci ON cowork_agents (session_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_agents_preview_token
  ON cowork_agents (preview_token) WHERE preview_token IS NOT NULL;

-- 群管理员名单：群主（agent_sessions.user_id）天然是管理员，不入此表。
-- 按成员快照 provider+contact_id 存档，未登录成员也可被设为管理员；对方登录后经 users 表匹配。
CREATE TABLE IF NOT EXISTS cowork_admins (
  session_id  TEXT         NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  provider    VARCHAR(64)  NOT NULL,
  contact_id  VARCHAR(160) NOT NULL,
  name        VARCHAR(160) NOT NULL DEFAULT '',
  avatar      TEXT         NOT NULL DEFAULT '',
  promoted_by VARCHAR(160) NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, provider, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_cowork_admins_session ON cowork_admins (session_id);

CREATE TABLE IF NOT EXISTS cowork_connections (
  id                TEXT         PRIMARY KEY,
  session_id        TEXT         NOT NULL,
  agent_id          TEXT         NOT NULL,
  name              VARCHAR(80)  NOT NULL,
  kind              VARCHAR(32)  NOT NULL,
  target            TEXT         NOT NULL DEFAULT '',
  secret_ciphertext TEXT         NOT NULL,
  owner_sub         VARCHAR(160) NOT NULL,
  enabled           BOOLEAN      NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, agent_id) REFERENCES cowork_agents(session_id, id) ON DELETE CASCADE,
  UNIQUE (agent_id, name)
);

CREATE TABLE IF NOT EXISTS cowork_connection_grants (
  connection_id TEXT         NOT NULL REFERENCES cowork_connections(id) ON DELETE CASCADE,
  user_sub      VARCHAR(160) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, user_sub)
);

CREATE TABLE IF NOT EXISTS cowork_connection_audit (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT        NOT NULL,
  connection_id TEXT        NOT NULL,
  actor_sub     VARCHAR(160) NOT NULL,
  action        VARCHAR(32) NOT NULL,
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cowork_connection_audit ON cowork_connection_audit (session_id, created_at DESC);

-- 一条消息可被多人各打多个表情（v2 表；旧单表情表已废弃，不保留）
CREATE TABLE IF NOT EXISTS cowork_message_reactions (
  message_id BIGINT      NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  user_sub   VARCHAR(160) NOT NULL,
  emoji      VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_sub, emoji)
);

-- 群 AI 的一轮发言（快思考 / 慢思考分开落列，便于中途续写与回放）
CREATE TABLE IF NOT EXISTS cowork_runs (
  id                        TEXT        PRIMARY KEY,
  session_id                TEXT        NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  trigger_message_id        BIGINT      NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  agent_id                  TEXT,
  status                    VARCHAR(16) NOT NULL DEFAULT 'pending',
  content                   TEXT        NOT NULL DEFAULT '',
  steps                     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  elapsed_secs              INTEGER,
  visible                   BOOLEAN     NOT NULL DEFAULT false,
  error                     TEXT,
  fast_content              TEXT        NOT NULL DEFAULT '',
  fast_status               VARCHAR(16) NOT NULL DEFAULT 'pending',
  fast_steps                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  fast_elapsed_secs         INTEGER,
  fast_initial_content      TEXT,
  fast_initial_elapsed_secs INTEGER,
  fast_steers               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_one_active_run
  ON cowork_runs (session_id) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_cowork_runs_session ON cowork_runs (session_id, created_at DESC);

-- AI 伴聊（Chatmate）：针对某条消息给某位用户生成的私密草稿，仅本人可见
CREATE TABLE IF NOT EXISTS cowork_chatmate (
  id                TEXT        PRIMARY KEY,
  session_id        TEXT        NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  message_id        BIGINT      NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  user_sub          VARCHAR(160) NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'running',
  content           TEXT        NOT NULL DEFAULT '',
  draft_text        TEXT,
  steps             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  elapsed_secs      INTEGER,
  error             TEXT,
  sender_name       TEXT,
  reasoning         TEXT,
  model_session_id  TEXT,
  tasks             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  suggested_reaction JSONB,
  blocker           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, message_id, user_sub)
);

CREATE INDEX IF NOT EXISTS idx_cowork_chatmate_user ON cowork_chatmate (session_id, user_sub, message_id DESC);

CREATE TABLE IF NOT EXISTS cowork_chatmate_settings (
  session_id     TEXT        NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  user_sub       VARCHAR(160) NOT NULL,
  enabled        BOOLEAN     NOT NULL DEFAULT false,
  auto_reply     BOOLEAN     NOT NULL DEFAULT false,
  pause_reason   TEXT,
  custom_prompt  TEXT,                                   -- NULL=内置默认提示词
  PRIMARY KEY (session_id, user_sub)
);

-- ---------------------------------------------------------------------------
--  agent_files：统一文件索引（模型产物 output + 用户上传 input + 用户文件区 userfile）
--  id = fileId（全局唯一句柄，URL/分享只用它）；storage_key = 物理分片键 <hh>/<fileId>
--  session_id 不建外键：会话删除后文件仍保留，资料库可列并标注"会话已删除"。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_files (
  id          TEXT         PRIMARY KEY,
  owner_sub   VARCHAR(160) NOT NULL,
  session_id  TEXT,
  kind        VARCHAR(16)  NOT NULL DEFAULT 'output',   -- 'output' | 'input' | 'userfile'
  name        VARCHAR(512) NOT NULL,
  mime        VARCHAR(128),
  size        BIGINT       NOT NULL DEFAULT 0,
  storage_key TEXT         NOT NULL,
  folder      TEXT,                                     -- 仅 userfile：用户相对目录
  deleted_at  TIMESTAMPTZ,                              -- 软删标记（NULL=有效）
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_files_owner   ON agent_files (owner_sub, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_files_session ON agent_files (session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_files_storage ON agent_files (storage_key) WHERE deleted_at IS NULL;

-- 用户长期记忆。文件只引用 agent_files.id，不保存会失效的物理路径。
CREATE TABLE IF NOT EXISTS agent_memories (
  id                TEXT         PRIMARY KEY,
  owner_sub         VARCHAR(160) NOT NULL,
  content           TEXT         NOT NULL,
  category          VARCHAR(16)  NOT NULL DEFAULT 'fact',
  source            VARCHAR(16)  NOT NULL DEFAULT 'user_explicit',
  source_session_id TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT agent_memories_category_check
    CHECK (category IN ('preference', 'fact', 'instruction', 'resource'))
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_owner ON agent_memories (owner_sub, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_memory_files (
  memory_id    TEXT NOT NULL REFERENCES agent_memories(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  mime         TEXT,
  snapshot_key TEXT,
  PRIMARY KEY (memory_id, file_id)
);

-- ---------------------------------------------------------------------------
--  agent_shares：分享（会话级 + 文件级，双粒度 scope）
--  token 为不可枚举随机串，作为分享链接的身份凭证。
--  created_by 存主体键 ${provider}:${unionId}（"仅创建者可发送"校验用）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_shares (
  token       TEXT         PRIMARY KEY,
  session_id  TEXT         REFERENCES agent_sessions(id) ON DELETE CASCADE,  -- 文件级分享可为 NULL
  created_by  VARCHAR(160) NOT NULL,
  scope_type  VARCHAR(16)  NOT NULL DEFAULT 'session',   -- 'session' | 'file'
  scope_id    TEXT         NOT NULL DEFAULT '',          -- session_id 或 file_id
  permission  VARCHAR(16)  NOT NULL DEFAULT 'view',      -- 'view' | 'comment' | 'edit'
  grantee_sub VARCHAR(160),                              -- NULL=公开/任意人
  expires_at  TIMESTAMPTZ,                               -- NULL=不过期
  revoked     BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_shares_session ON agent_shares (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_shares_scope   ON agent_shares (scope_type, scope_id, revoked);

-- 应用内群聊分享：权限与原始消息绑定；撤回时 revoked_at 即时失效。
CREATE TABLE IF NOT EXISTS agent_chat_shares (
  token             VARCHAR(48) PRIMARY KEY,
  source_session_id TEXT        NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  target_session_id TEXT        NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  message_id        BIGINT      NOT NULL UNIQUE REFERENCES agent_messages(id) ON DELETE CASCADE,
  created_by        VARCHAR(160) NOT NULL,
  scope_type        VARCHAR(16) NOT NULL DEFAULT 'session',
  artifact_id       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_chat_shares_target ON agent_chat_shares (target_session_id);

CREATE TABLE IF NOT EXISTS agent_feedback (
  id             BIGSERIAL    PRIMARY KEY,
  user_id        VARCHAR(160) NOT NULL,
  session_id     TEXT         NOT NULL,
  message_id     BIGINT,
  answer_preview TEXT         NOT NULL DEFAULT '',
  vote           VARCHAR(8)   NOT NULL CHECK (vote IN ('up', 'down')),
  categories     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  detail         TEXT         NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_feedback_created ON agent_feedback (created_at DESC);

-- ---------------------------------------------------------------------------
--  admin_settings：管理控制台（基本设置 / 算力统筹）的可配置项。
--  单键 'global' 存整份 JSON，管理员编辑后整份覆盖；普通登录用户可读（供运行时使用）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
--  内置账号好友关系：一对用户只存一行，两个主体键按字典序排列。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builtin_friendships (
  user_a     VARCHAR(160) NOT NULL,
  user_b     VARCHAR(160) NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE INDEX IF NOT EXISTS idx_builtin_friendships_user_b ON builtin_friendships (user_b);

CREATE TABLE IF NOT EXISTS builtin_friend_invitations (
  id            BIGSERIAL   PRIMARY KEY,
  sender_sub    VARCHAR(160) NOT NULL,
  recipient_sub VARCHAR(160) NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  responded_at  TIMESTAMPTZ,
  CHECK (sender_sub <> recipient_sub)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_builtin_friend_invites_pending
  ON builtin_friend_invitations (sender_sub, recipient_sub) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_builtin_friend_invites_recipient
  ON builtin_friend_invitations (recipient_sub, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_builtin_friend_invites_sender
  ON builtin_friend_invitations (sender_sub, status, created_at DESC);
