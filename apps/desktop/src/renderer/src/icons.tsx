/** 内置图标集：主按钮、数域、向前兼容的应用图标，全部内联 SVG，无外部资源 */
import type { WallpaperSkinId } from "./wallpapers";
import { ContactsIcon } from "@turingflow/agent-kit/ui";

export interface IconProps {
  kind: string;
  size?: number;
  skin?: WallpaperSkinId | "light" | "dark";
  /** 语音优先任务正在被大模型处理：正中实心圆切换为空心方块（停止语义）。 */
  running?: boolean;
}

/** 数域/应用的品牌色，用于图标底色 */
export const KIND_COLOR: Record<string, string> = {
  primary: "#0a84ff",
  dingtalk: "#1677ff",
  feishu: "#7b5cff",
  wechat: "#666666",
  contacts: "#4b5563",
  personal: "#6b7280",
  files: "#ff9f0a",
  browser: "#30d158",
  mail: "#64d2ff",
  settings: "#98989d",
};

/** 数域图标源：微信用官方 SVG 源文件（透明底圆形，直接 <img> 加载，不落 PNG），其余数域用 PNG。 */
export function domainIconSrc(id: string): string {
  return id === "wechat" || id === "contacts" ? `icons/${id}.svg` : `icons/${id}.png`;
}

/**
 * 数域图标渲染：
 *  - contacts：kit 内联 SVG（圆形黑白灰徽章，随外观切换配色），精确等大填充，规避溢出网格项的偏移（不居中问题）；
 *  - 其余：按 domainIconSrc 走文件图标（<img>）。
 */
export function DomainIcon({ id, size, skin = "dark" }: { id: string; size: number; skin?: WallpaperSkinId | "light" | "dark" }) {
  if (id === "contacts") return <AppIcon kind="contacts" size={size} skin={skin} />;
  // settings 不是数域（没有图标文件），用内联齿轮 SVG。
  if (id === "settings") return <AppIcon kind="settings" size={size} skin={skin} />;
  // knowledge 知识库图标：书本 + 放大镜
  if (id === "knowledge") return <KnowledgeIcon size={size} skin={skin} />;
  return <img src={domainIconSrc(id)} width={size} height={size} alt="" draggable={false} />;
}

function TextBadge({ text, bg, fg = "#ffffff", size }: { text: string; bg: string; fg?: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <defs>
        <linearGradient id={`bg-${text}-${bg.replace("#", "")}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={bg} />
          <stop offset="100%" stopColor={shade(bg)} />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="11" fill={`url(#bg-${text}-${bg.replace("#", "")})`} />
      <text
        x="24"
        y="31.5"
        textAnchor="middle"
        fontSize="22"
        fontWeight="600"
        fill={fg}
        fontFamily="'PingFang SC', system-ui, sans-serif"
      >
        {text}
      </text>
    </svg>
  );
}

function shade(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + 28);
  const g = Math.min(255, ((n >> 8) & 0xff) + 28);
  const b = Math.min(255, (n & 0xff) + 28);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function PersonIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <rect x="2" y="2" width="44" height="44" rx="11" fill="#6b7280" />
      <circle cx="24" cy="18" r="7" fill="#ffffff" opacity="0.92" />
      <path d="M24 28c-8 0-13 5-13 11h26c0-6-5-11-13-11z" fill="#ffffff" opacity="0.92" />
    </svg>
  );
}

/** 联系人数域徽章配色（黑白灰单色系，随外观切换）：
 *  浅色：浅灰圆底 + 深灰图形；深色：深灰圆底 + 白色图形。 */
const CONTACTS_PALETTE: Record<WallpaperSkinId | "light" | "dark", { bg: string; glyph: string }> = {
  light: { bg: "#d8dbe0", glyph: "#3f4348" },
  dark: { bg: "#4b5563", glyph: "#ffffff" },
  wp1: { bg: "#30343b", glyph: "#adb6c1" },
  wp2: { bg: "#273e52", glyph: "#a3c4dc" },
  wp3: { bg: "#2b4032", glyph: "#a9c9ad" },
  wp4: { bg: "#403026", glyph: "#d7b69a" },
  wp5: { bg: "#193849", glyph: "#abd9e9" },
  wp6: { bg: "#3b3020", glyph: "#ebce8d" },
};

/** 联系人数域徽章：圆形底 + kit ContactsIcon（双人形：UserIcon 本体 + 右后方叠一个，有遮挡，整体居中）。
 *  图形缩放 1.2x、线宽 1.4，四周留约 27% 边距，内容偏小、不贴边。 */
function ContactsBadgeIcon({ size, skin = "dark" }: { size: number; skin?: WallpaperSkinId | "light" | "dark" }) {
  const palette = CONTACTS_PALETTE[skin] ?? CONTACTS_PALETTE.dark;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="24" fill={palette.bg} />
      <g transform="translate(9.6 9.6) scale(1.2)" color={palette.glyph}>
        <ContactsIcon width={24} height={24} strokeWidth={1.4} />
      </g>
    </svg>
  );
}

function FolderIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <path
        d="M6 12h12l4 5h20v22a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V12z"
        fill="#ff9f0a"
        opacity="0.9"
        stroke="#e08c00"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M6 20h36" stroke="#fff" strokeOpacity="0.55" strokeWidth="2" />
    </svg>
  );
}

function GlobeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <rect x="2" y="2" width="44" height="44" rx="11" fill="#30d158" />
      <circle cx="24" cy="24" r="12" fill="none" stroke="#fff" strokeWidth="2.4" />
      <ellipse cx="24" cy="24" rx="5.4" ry="12" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M12 20h24M12 28h24" stroke="#fff" strokeWidth="1.6" opacity="0.75" />
    </svg>
  );
}

function MailIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <rect x="4" y="10" width="40" height="28" rx="6" fill="#64d2ff" />
      <path d="M7 13l17 13 17-13" fill="none" stroke="#ffffff" strokeWidth="2.6" strokeLinejoin="round" />
    </svg>
  );
}

const SETTINGS_PALETTE: Record<WallpaperSkinId | "light" | "dark", { gear: string; surface: string; detail: string; center: string }> = {
  light: { gear: "#929ba5", surface: "#f7f8fa", detail: "#b9c0c7", center: "#76818d" },
  dark: { gear: "#7c8998", surface: "#303740", detail: "#a5afbb", center: "#9ca8b5" },
  wp1: { gear: "#87919f", surface: "#30343b", detail: "#adb6c1", center: "#9faab8" },
  wp2: { gear: "#6995b8", surface: "#273e52", detail: "#a3c4dc", center: "#8db3cf" },
  wp3: { gear: "#729b80", surface: "#2b4032", detail: "#a9c9ad", center: "#91b79a" },
  wp4: { gear: "#b18a70", surface: "#403026", detail: "#d7b69a", center: "#c49e7e" },
  wp5: { gear: "#6ca7bf", surface: "#193849", detail: "#abd9e9", center: "#8bc7dc" },
  wp6: { gear: "#c9a55e", surface: "#3b3020", detail: "#ebce8d", center: "#e1bd72" },
};

/** 设置数域图标：参考圆环齿轮、三段内弧与中心轴，颜色跟随当前外观皮肤。
 *  viewBox 取「齿尖外缘」正好落在画布边界上（中心 24、齿尖半径 21.6 → 2.4 2.4 43.2 43.2）：
 *  Dock 里左右邻居都是满格的圆形底图标（60px），齿轮若留白就会显小一圈，所以这里顶满不出血。 */
function GearIcon({ size, skin }: { size: number; skin: WallpaperSkinId | "light" | "dark" }) {
  const palette = SETTINGS_PALETTE[skin];
  const teeth = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg width={size} height={size} viewBox="2.4 2.4 43.2 43.2" aria-hidden="true">
      <g fill={palette.gear}>
        {teeth.map((a) => (
          <rect
            key={a}
            x="21.1"
            y="2.4"
            width="5.8"
            height="9"
            rx="1.4"
            transform={`rotate(${a} 24 24)`}
          />
        ))}
        <circle cx="24" cy="24" r="19.2" />
      </g>
      <circle cx="24" cy="24" r="14.8" fill={palette.surface} />
      <g fill="none" stroke={palette.detail} strokeWidth="1.35" strokeLinecap="round">
        <path d="M20.5 13.1A11.4 11.4 0 0 0 13.1 27.5" />
        <path d="M27.6 13.2A11.4 11.4 0 0 1 34.5 29" />
        <path d="M17.3 33.2A11.4 11.4 0 0 0 30.7 32.9" />
      </g>
      <circle cx="24" cy="24" r="3.6" fill={palette.center} />
    </svg>
  );
}

/** 「关于」入口图标：圆圈 + i（kit 里没有 info 图标），描边风格与 kit 的 SettingsIcon 一致。 */
export function AboutGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6h.01" />
    </svg>
  );
}

export function UpdateGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

/** 「删除账号」入口图标：描边垃圾桶，风格与 kit 的 LogoutIcon 一致。 */
export function TrashGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M9 7V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7" />
      <path d="M6.2 7l.9 12.2a1 1 0 0 0 1 .8h7.8a1 1 0 0 0 1-.8L17.8 7" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

const ASK_SKINS: Record<WallpaperSkinId | "light" | "dark", { surface: string; core: string; stroke: string }> = {
  light: { surface: "#e9e9e8", core: "#343538", stroke: "#343538" },
  dark: { surface: "#292a2d", core: "#eeeeef", stroke: "#eeeeef" },
  wp1: { surface: "#2a2c32", core: "#f1f2f4", stroke: "#e8e9ed" },
  wp2: { surface: "#244a6b", core: "#f1f9ff", stroke: "#e4f3ff" },
  wp3: { surface: "#284a35", core: "#f1f9ed", stroke: "#e7f5df" },
  wp4: { surface: "#35221b", core: "#ffd183", stroke: "#f69b3d" },
  wp5: { surface: "#173b50", core: "#d9f5ff", stroke: "#78bdd8" },
  wp6: { surface: "#30271d", core: "#f8df9b", stroke: "#d6ad62" },
};

/** Home 图标配色：叠加层（录音声波等）需要与图标同色系时取它。 */
export function askIconPalette(skin: WallpaperSkinId | "light" | "dark") {
  return ASK_SKINS[skin];
}

function AskIcon({ size, skin, running = false }: { size: number; skin: WallpaperSkinId | "light" | "dark"; running?: boolean }) {
  const palette = ASK_SKINS[skin];
  return (
    <svg className="ask-icon" width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={running ? "停止当前语音优先任务" : "Agent"}>
      <circle cx="24" cy="24" r="24" fill={palette.surface} />
      <circle className="ask-orbit-outer" cx="24" cy="24" r="12" fill="none" stroke={palette.stroke} strokeWidth="2" strokeLinecap="round" strokeDasharray="18.85 18.85" strokeOpacity=".88" />
      {running
        ? <rect className="ask-stop-core" x="19.6" y="19.6" width="8.8" height="8.8" rx="1.6" fill={palette.core} />
        : <circle className="ask-core" cx="24" cy="24" r="3.6" fill={palette.core} />}
    </svg>
  );
}

export function AppIcon({ kind, size = 48, skin = "wp1", running = false }: IconProps) {
  switch (kind) {
    case "primary":
      return <AskIcon size={size} skin={skin} running={running} />;
    case "dingtalk":
      return <TextBadge text="钉" bg="#1677ff" size={size} />;
    case "feishu":
      return <TextBadge text="飞" bg="#7b5cff" size={size} />;
    case "wechat":
      return <TextBadge text="微" bg="#666666" size={size} />;
    case "contacts":
      return <ContactsBadgeIcon size={size} skin={skin} />;
    case "personal":
      return <PersonIcon size={size} />;
    case "files":
      return <FolderIcon size={size} />;
    case "browser":
      return <GlobeIcon size={size} />;
    case "mail":
      return <MailIcon size={size} />;
    case "settings":
      return <GearIcon size={size} skin={skin} />;
    default:
      return <TextBadge text={kind.slice(0, 1).toUpperCase()} bg="#98989d" size={size} />;
  }
}

/** 知识库徽章配色（黑白灰单色系，随外观切换）：
 *  浅色：浅灰圆底 + 深灰图形；深色：深灰圆底 + 浅灰图形。
 *  wp1–wp6 取各壁纸同色系灰调，与 ContactsBadgeIcon 保持一致。 */
const KNOWLEDGE_PALETTE: Record<WallpaperSkinId | "light" | "dark", { bg: string; glyph: string }> = {
  light: { bg: "#d8dbe0", glyph: "#3f4348" },
  dark: { bg: "#4b5563", glyph: "#ffffff" },
  wp1: { bg: "#30343b", glyph: "#adb6c1" },
  wp2: { bg: "#273e52", glyph: "#a3c4dc" },
  wp3: { bg: "#2b4032", glyph: "#a9c9ad" },
  wp4: { bg: "#403026", glyph: "#d7b69a" },
  wp5: { bg: "#193849", glyph: "#abd9e9" },
  wp6: { bg: "#3b3020", glyph: "#ebce8d" },
};

/** 知识库图标：圆形底 + 书本（填充）+ 放大镜（描边），配色跟随当前外观皮肤。 */
function KnowledgeIcon({ size, skin = "dark" }: { size: number; skin?: WallpaperSkinId | "light" | "dark" }) {
  const palette = KNOWLEDGE_PALETTE[skin] ?? KNOWLEDGE_PALETTE.dark;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="24" fill={palette.bg} />
      {/* 书本 */}
      <path
        d="M14 12h12a2 2 0 0 1 2 2v18a2 2 0 0 0-2-2H14a2 2 0 0 1-2-2V14a2 2 0 0 1 2-2z"
        fill={palette.glyph}
        opacity="0.9"
      />
      <path d="M16 16h10M16 20h10M16 24h7" stroke={palette.bg} strokeWidth="1.5" strokeLinecap="round" />
      {/* 放大镜 */}
      <circle cx="32" cy="30" r="6" fill="none" stroke={palette.glyph} strokeWidth="2" />
      <line x1="36.5" y1="34.5" x2="40" y2="38" stroke={palette.glyph} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** 数域入口图标的 8 套配色：浅/深外观 + 6 种壁纸皮肤，圆形底、搜索条、格子的色全部取自各主题的色系，
 *  和 Home / 数域图标待在同一条 Dock 上不会跳出主题。 */
const DOMAIN_ENTRY_PALETTE: Record<WallpaperSkinId | "light" | "dark", {
  card: string;
  card2: string;
  line: string;
  bar: string;
  glyph: string;
  tiles: [string, string, string, string, string, string];
}> = {
  light: { card: "#f9f9fa", card2: "#e9ebef", line: "rgba(0,0,0,0.10)", bar: "#dcdee3", glyph: "#6e7076",
    tiles: ["#3f4247", "#565a61", "#6f747c", "#90959d", "#b1b6bd", "#d2d6db"] },
  dark: { card: "#31343a", card2: "#25272b", line: "rgba(255,255,255,0.12)", bar: "#404349", glyph: "#a8acb2",
    tiles: ["#4b525c", "#5e6672", "#747d8b", "#909aa9", "#aeb8c6", "#ccd5e0"] },
  wp1: { card: "#2a2d33", card2: "#202226", line: "rgba(255,255,255,0.10)", bar: "#393d43", glyph: "#a3aab3",
    tiles: ["#58697c", "#6a7c90", "#7f92a5", "#97a9ba", "#b0c0ce", "#cbd8e2"] },
  wp2: { card: "#f6fafd", card2: "#e4eef7", line: "rgba(28,39,51,0.11)", bar: "#d6e2ee", glyph: "#5b7b99",
    tiles: ["#2f5d86", "#447ba6", "#5f99c1", "#8fbcd8", "#b9d6e8", "#dcebf4"] },
  wp3: { card: "#22322a", card2: "#18231c", line: "rgba(255,255,255,0.10)", bar: "#2e3f34", glyph: "#93b19d",
    tiles: ["#3c6b4f", "#4f8463", "#66a07c", "#8dbf9f", "#b4d6c1", "#d9ebdf"] },
  wp4: { card: "#2e221b", card2: "#221913", line: "rgba(255,255,255,0.10)", bar: "#3d2c22", glyph: "#c9a17f",
    tiles: ["#8a4a2a", "#a85c33", "#c27343", "#d99a6c", "#ecc39c", "#f7e0c8"] },
  wp5: { card: "#182b36", card2: "#0f1e26", line: "rgba(255,255,255,0.10)", bar: "#213c47", glyph: "#8ec4d4",
    tiles: ["#1f5568", "#2b6d83", "#3e8ba0", "#6cb2c6", "#a0cfe0", "#d0ebf4"] },
  wp6: { card: "#2e2619", card2: "#221b12", line: "rgba(255,255,255,0.10)", bar: "#3d321f", glyph: "#d9bd84",
    tiles: ["#7a5c26", "#9b7631", "#bc9445", "#d9b465", "#ecd28f", "#f8ecc4"] },
};

/**
 * 「数域」入口图标：构图照 macOS 启动台（顶部搜索条 + 两行三列格子），
 * 但外形是圆形（Dock 上所有图标都是圆的），配色全部走当前主题的 8 套 skin。
 * 只在 Dock 的数域入口用它，不参与 DomainIcon 的分发（数域本身仍用各自品牌图标）。
 */
export function DomainEntryIcon({ size, skin = "dark" }: { size: number; skin?: WallpaperSkinId | "light" | "dark" }) {
  const palette = DOMAIN_ENTRY_PALETTE[skin] ?? DOMAIN_ENTRY_PALETTE.dark;
  const gradientId = `domains-entry-${skin}`;
  // 圆内可用：3 列 × 6.4 + 2 个 2.4 的缝 = 24，居中落在 12–36 之间。
  const positions: Array<[number, number]> = [
    [12, 20.4], [20.8, 20.4], [29.6, 20.4],
    [12, 28.4], [20.8, 28.4], [29.6, 28.4],
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.card} />
          <stop offset="100%" stopColor={palette.card2} />
        </linearGradient>
      </defs>
      {/* 圆形底 */}
      <circle cx="24" cy="24" r="24" fill={`url(#${gradientId})`} />
      <circle cx="24" cy="24" r="23.6" fill="none" stroke={palette.line} strokeWidth="0.8" />
      {/* 顶部搜索条 + 放大镜 */}
      <rect x="12" y="11.2" width="24" height="6" rx="3" fill={palette.bar} />
      <circle cx="15.2" cy="14.2" r="1.6" fill="none" stroke={palette.glyph} strokeWidth="0.9" />
      <path d="M16.4 15.5l1.2 1.2" stroke={palette.glyph} strokeWidth="0.9" strokeLinecap="round" />
      {/* 两行三列：每个格子 = 一个数域，颜色是同一主题里由深到浅的一串 */}
      {positions.map(([x, y], index) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="6.4" height="6.4" rx="1.7" fill={palette.tiles[index]} />
      ))}
    </svg>
  );
}
