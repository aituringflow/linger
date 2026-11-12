"use client";

/**
 * agent-kit · 现代风格模型选择下拉（黑白灰系）
 *
 * 与原生 <select> 的差异：触发按钮 + 向上展开的圆角菜单、列表项 hover/选中态、勾选标记。
 * - 触发按钮显示当前模型名与 chevron，点击展开菜单（向上弹出，避免遮挡输入区）。
 * - 收起状态悬停触发按钮显示选中模型详情；点击按钮展开模型列表
 *   （提供商 / 上下文窗口 / 最大输出 Token / 工具调用 / 图像输入等），但**绝不展示 apiKey**。
 *
 * 模型来源有两种：
 *   - models.json 配置的自定义模型：{ id, name, meta }，界面优先显示 name；
 *   - 已登录的 CodeBuddy SDK 返回的内置模型。
 * 无论哪种，发送给服务端的 model 值始终为 id（name / meta 仅作展示）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useClickOutside } from "../useClickOutside.ts";
import { ModelSelectGlyph01, ModelSelectGlyph02 } from "../icons/PageIcons.tsx";
import { ModelIcon } from "./ModelIcon.tsx";

/** 模型详情（来自 models.json 的条目，已剔除 apiKey）。键为 models.json 原始字段名。 */
export interface ModelMeta {
  vendor?: string;
  url?: string;
  /** CodeBuddy 下发的模型 Logo（远程 SVG/PNG 或 data: 内联）；覆盖率不满，缺省走兜底字形。 */
  iconUrl?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  [key: string]: unknown;
}

/** 模型选项：兼容「纯 id 字符串」与「{id, name, meta} 对象」两种来源。 */
export type ModelOption = string | { id: string; name?: string; meta?: ModelMeta };

/** 归一为 { id, name?, meta? }，并剔除空 id。 */
export function normalizeModelOption(m: ModelOption): { id: string; name?: string; meta?: ModelMeta } {
  if (typeof m === "string") return { id: m.trim() };
  return {
    id: (m.id || "").trim(),
    name: m.name ? m.name.trim() : undefined,
    meta: m.meta,
  };
}

/** 展示字段白名单：这些键不会被渲染；apiKey 永远不显示（双保险）。
 *  iconUrl 必须排除 —— 它已经通过 `<ModelIcon>` 上图了，落进详情表格会变成一坨几 KB 的 data:base64。 */
const HIDDEN_KEYS = new Set(["apiKey", "id", "name", "url", "temperature", "reasoning", "tags", "description", "descriptionEn", "descriptionZh", "iconUrl"]);
const KNOWN_LABELS: Record<string, string> = {
  vendor: "提供商",
  url: "接口地址",
  maxInputTokens: "最大输入 Token",
  maxOutputTokens: "最大输出 Token",
  temperature: "温度",
  supportsToolCall: "工具调用",
  supportsImages: "图像输入",
  supportsReasoning: "深度思考",
  credits: "积分消耗",
  credit: "积分消耗",
};

/** 把 meta 转成可渲染的「标签/值」行（过滤隐藏键与空值，布尔转中文，绝不渲染 apiKey）。 */
function buildMetaRows(meta?: ModelMeta): { label: string; value: string }[] {
  if (!meta) return [];
  const rows: { label: string; value: string }[] = [];
  for (const key of Object.keys(meta)) {
    if (HIDDEN_KEYS.has(key)) continue;
    const raw = (meta as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;
    if (key === "vendor" && /^[a-z]$/i.test(String(raw).trim())) continue;
    const label = KNOWN_LABELS[key] ?? key;
    let value: string;
    if (typeof raw === "boolean") value = raw ? "是" : "否";
    else if (typeof raw === "object") value = JSON.stringify(raw);
    else value = String(raw);
    if (key === "maxInputTokens" || key === "maxOutputTokens") {
      const tokens = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(tokens) && tokens >= 1000) {
        const divisor = tokens >= 1_000_000 ? 1_000_000 : 1000;
        value = `${Number((tokens / divisor).toFixed(2))}${divisor === 1_000_000 ? "M" : "K"}`;
      }
    }
    if (key === "credits" || key === "credit") {
      const amount = value.match(/(?:x|×)?\s*(\d+(?:\.\d+)?)/i);
      if (amount) value = `x${amount[1]}`;
      else value = value.replace(/\s*credits?\s*$/i, "").trim();
    }
    rows.push({ label, value });
  }
  // 优先使用中文专用描述；通用描述只有包含中文时才展示。
  const description = typeof meta.descriptionZh === "string" && meta.descriptionZh.trim()
    ? meta.descriptionZh.trim()
    : typeof meta.description === "string" && /\p{Script=Han}/u.test(meta.description)
      ? meta.description.trim() : "";
  if (description) rows.push({ label: "描述", value: description });
  return rows;
}

/**
 * 元素身份（选中态 / React key 都用它）：`vendor::id` 组合。
 * 不同 provider 可能提供**相同 id** 的模型（如 deepseek 与华为云都叫 deepseek-v4-flash），
 * 若只用 id 作身份，两行会撞 key、且选中态永远命中第一个，导致"选不了第二个"。
 * 无 vendor 时退化为纯 id（与历史值、发送给引擎的模型 id 一致）。
 * 注意：这是**界面身份**；发送给引擎时仍取该条目的纯 `id`（见 AgentWindow 的 selectedModelId）。
 */
export function modelOptionKey(o: { id: string; meta?: ModelMeta }): string {
  const vendor = o.meta?.vendor ? String(o.meta.vendor) : "";
  return vendor ? `${vendor}::${o.id}` : o.id;
}

/** 显示名：优先用 models.json 的 name；无 name 时退化为 id 的 workbuddy 风格首字母大写（hy3 → Hy3）。 */
function displayName(id: string, name?: string): string {
  if (name) return name;
  return id.replace(/(^|[-.])([a-z])/g, (_all, p: string, c: string) => p + c.toUpperCase());
}

export default function ModelSelect({
  options,
  value,
  onChange,
  title = "选择模型：发送后该会话立即使用所选模型（悬停查看模型详情）",
  disabled = false,
  compact = false,
  openOnHover = false,
  iconOnNarrow = false,
  showIcon = true,
  forceUp = false,
  showHoverDetail = true,
  emptyLabel = "暂无可用模型",
}: {
  options: ModelOption[];
  /** 选中项的身份 key（`vendor::id`，见 modelOptionKey）；无 vendor 时即纯 id。 */
  value: string;
  /** 回传被点选条目的身份 key（`vendor::id`）；调用方发送给引擎前再取纯 id。 */
  onChange: (key: string) => void;
  title?: string;
  disabled?: boolean;
  compact?: boolean;
  openOnHover?: boolean;
  /** 工具栏最窄布局时以图标代替模型名称。 */
  iconOnNarrow?: boolean;
  /** 框架选择器只显示名称，不展示模型图标。 */
  showIcon?: boolean;
  /** 强制向上弹出（不做视口感知向下翻转）。 */
  forceUp?: boolean;
  /** 宿主可关闭收起状态下的悬停详情。 */
  showHoverDetail?: boolean;
  /** 没有可用选项时显示静态状态，不提供下拉操作。 */
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [dir, setDir] = useState<"up" | "down">("up");
  const [menuMaxH, setMenuMaxH] = useState<number | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const norm = options.map(normalizeModelOption).filter((o) => o.id);

  /** 视口感知定位：展开时按触发按钮上下剩余空间决定向上/向下弹出，并把菜单高度限制在可视范围内，
   *  避免窄屏（移动端）列表过长时弹出层超出视口、顶部选项无法点到。 */
  const positionPopup = useCallback(() => {
    if (forceUp) { setDir("up"); setMenuMaxH(undefined); return; }
    const btn = ref.current?.querySelector<HTMLElement>(".chat-model-picker-btn");
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const margin = 8;
    const spaceAbove = rect.top - margin;
    const spaceBelow = vh - rect.bottom - margin;
    const desired = 240;
    const useDown = spaceBelow >= spaceAbove && spaceBelow > desired * 0.4;
    setDir(useDown ? "down" : "up");
    const avail = Math.max(spaceAbove, spaceBelow);
    // 仅在可视空间不足时收缩；空间充足时维持桌面默认上限（与 CSS 的 240px 一致）
    setMenuMaxH(Math.max(140, Math.min(desired, avail - margin)));
  }, [forceUp]);

  // 选中态按身份 key 命中：同 id 不同 vendor 的条目各自可选中、各自高亮。
  // 兼容旧值（历史存的是纯 id）：key 未命中时回退按 id 匹配首个条目。
  const current =
    norm.find((o) => modelOptionKey(o) === value) ?? norm.find((o) => o.id === value);
  const selectedIndex = current ? norm.indexOf(current) : -1;
  const detailRowsForHover = buildMetaRows(current?.meta);
  const showDetail = showHoverDetail && hover && !open && !compact;

  useEffect(() => {
    if (norm.length === 0) setOpen(false);
  }, [norm.length]);

  useEffect(() => {
    if (!open) return;
    positionPopup();
    const onReposition = () => positionPopup();
    // 视口尺寸/滚动变化时重新计算弹出方向与安全高度（移动端地址栏收起、键盘弹起等场景）
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, positionPopup]);
  // 下拉菜单：点击组件（按钮+菜单）之外任意处或 Esc 关闭（捕获阶段监听，避免菜单内事件被吞）
  useClickOutside({
    enabled: open,
    refs: [ref],
    capture: true,
    onDismiss: () => setOpen(false),
  });

  if (norm.length === 0) return <span className="chat-model-picker-empty" aria-live="polite">{emptyLabel}</span>;

  return (
    <div className={`chat-model-picker${compact ? " is-compact" : ""}${openOnHover ? " is-hover-open" : ""}${iconOnNarrow ? " has-narrow-icon" : ""}`} ref={ref}
      onMouseEnter={() => { if (!disabled) { setHover(true); if (openOnHover) setOpen(true); } }}
      onMouseLeave={() => { setHover(false); if (openOnHover) setOpen(false); }}>
      {/* 收起时悬停查看当前模型详情。 */}
      {showDetail ? (
        <div className="chat-model-picker-detail" role="tooltip">
          <div className="chat-model-picker-detail-head">
            <span className="chat-model-picker-detail-title">
              {showIcon ? <ModelIcon iconUrl={current?.meta?.iconUrl} modelId={current?.id} name={current?.name} size={18} /> : null}
              <span className="chat-model-picker-detail-name">{displayName(current?.id ?? value, current?.name)}</span>
            </span>
          </div>
          <div className="chat-model-picker-detail-rows">
            {!detailRowsForHover.length ? <span className="chat-model-picker-detail-label">暂无模型详情</span> : null}
            {detailRowsForHover.map((r) => (
              <div className="chat-model-picker-detail-row" key={r.label}>
                <span className="chat-model-picker-detail-label">{r.label}</span>
                <span className="chat-model-picker-detail-value">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {open ? <div className={`chat-model-picker-popup${dir === "down" ? " is-down" : ""}`}>
        <ul className="chat-model-picker-menu" role="listbox" style={menuMaxH != null ? { maxHeight: menuMaxH } : undefined}>
          {norm.map((o, idx) => (
            <li key={modelOptionKey(o)} role="option" aria-selected={idx === selectedIndex}
              className={`chat-model-picker-item${idx === selectedIndex ? " selected" : ""}`}
              tabIndex={0}
              onClick={() => { onChange(modelOptionKey(o)); setOpen(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(modelOptionKey(o)); setOpen(false); } }}>
              {showIcon ? <ModelIcon iconUrl={o.meta?.iconUrl} modelId={o.id} name={o.name} /> : null}
              <span className="chat-model-picker-item-text">
                <span className="chat-model-picker-item-name">{displayName(o.id, o.name)}</span>
              </span>
              <span className="chat-model-picker-item-extra">
                {!compact && o.meta?.modelType !== "enterprise" && (o.meta?.credits != null || o.meta?.credit != null) ? (() => {
                  const amount = String(o.meta.credits ?? o.meta.credit).match(/(?:x|×)?\s*(\d+(?:\.\d+)?)/i);
                  return amount ? <span className="chat-model-picker-item-credits">{amount[1]}x</span> : null;
                })() : null}
                <span className="chat-model-picker-item-selected" aria-hidden="true">{idx === selectedIndex ? "✓" : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      </div> : null}
      <button
        type="button"
        disabled={disabled}
        className={`chat-model-picker-btn${open ? " open" : ""}`}
        onClick={() => setOpen((v) => openOnHover ? true : !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        aria-label={iconOnNarrow ? `选择模型：${displayName(current?.id ?? value, current?.name)}` : undefined}
      >
        {showIcon ? iconOnNarrow ? <ModelSelectGlyph01 /> : <ModelIcon iconUrl={current?.meta?.iconUrl} modelId={current?.id} name={current?.name} /> : null}
        <span className="chat-model-picker-name">{displayName(current?.id ?? value, current?.name)}</span>
        <ModelSelectGlyph02 />
      </button>
    </div>
  );
}
