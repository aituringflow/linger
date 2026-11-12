/** Reusable UI icons. Keep SVG geometry here so callers only choose semantics and styling. */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function ReplyBubbleIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path fill="currentColor" stroke="none" d="M5 3h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-5l-4 3v-3H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"/><g fill="var(--field-bg)" stroke="none"><circle cx="7" cy="11" r="1.3"/><circle cx="12" cy="11" r="1.3"/><circle cx="17" cy="11" r="1.3"/></g></svg>;
}

export function CloseIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M6 6l12 12M18 6L6 18" /></svg>;
}

export function CheckIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M20 6 9 17l-5-5" /></svg>;
}

export function MultiSelectIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="m2.5 5.5 1.5 1.5 2.5-3M2.5 12l1.5 1.5L6.5 10M2.5 18.5 4 20l2.5-3M9 5.5h12M9 12h12M9 18.5h12" /></svg>;
}

export function CopyIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
}

/** 带三点的聊天气泡，供分享菜单使用。 */
export function SendToChatIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d="M12 3.5c-5.1 0-9 3.4-9 7.9 0 2.2.9 4.1 2.6 5.5L4.7 21l5.1-1.5c.7.2 1.4.3 2.2.3 5.1 0 9-3.4 9-8.4s-3.9-7.9-9-7.9Z"/><circle cx="8.2" cy="11.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="11.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.8" cy="11.6" r="1.1" fill="currentColor" stroke="none"/></svg>;
}

/** 右侧面板与分享菜单共用的浏览器图标。 */
export function BrowserGlobeIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9M12 3c-2.5 2.5-3.8 5.5-3.8 9s1.3 6.5 3.8 9" /></svg>;
}

export function SearchIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" /></svg>;
}

export function MoreIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>;
}

export function ChevronRightIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><polyline points="9 6 15 12 9 18" /></svg>;
}

export function NavigationChevronIcon({ direction, ...props }: IconProps & { direction: "left" | "right" }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d={direction === "left" ? "m14 5-7 7 7 7" : "m10 5 7 7-7 7"} />
  </svg>;
}

export function ErrorMarkIcon() {
  return <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.5v4" /><circle cx="6" cy="9" r="0.75" /></svg>;
}

export function ImageIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>;
}

export function CameraIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 8a2 2 0 0 1 2-2h2l1.2-2h7.6L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.6" />
  </svg>;
}

export function FileIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>;
}

export function FolderIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2.1 2.2h6.9A2.5 2.5 0 0 1 21 9.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5z" />
    <path d="M3 9.7h18" />
  </svg>;
}

/** 在系统文件管理器中定位文件或文件夹。 */
export function RevealInFolderIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2.1 2.2h6.9A2.5 2.5 0 0 1 21 9.7v4" />
    <path d="M3 9.7h18M3 9.7v8.8A2.5 2.5 0 0 0 5.5 21h6" />
    <circle cx="16" cy="16" r="3" />
    <path d="m18.3 18.3 2.2 2.2" />
  </svg>;
}

/** 视频文件（矩形 + 播放三角），与 ImageIcon 同款线框风格。 */
export function VideoIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="5" width="14" height="14" rx="3" />
    <path d="M17 10l4-2.5v9L17 14" />
  </svg>;
}

/** 音频文件（扬声器 + 声波），与 ImageIcon 同款线框风格。 */
export function AudioIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>;
}

export function PinIcon({ filled = false }: { filled?: boolean }) {
  return filled
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.7 2.8 21.2 8.3l-2.4 1.2-2.1 4.6 1.1 2.5-1.2 1.2-4.5-4.5-7.3 7.3-.9-.9 7.3-7.3-4.5-4.5 1.2-1.2 2.5 1.1 4.6-2.1z" fill="currentColor" stroke="none" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15.7 3 5.3 5.3-2.6 1.3-2 4.5 1.1 2.4-1.1 1.1-4.5-4.5-7.5 7.5m3-13.1 2.4 1.1 4.5-2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function MicIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
  </svg>;
}

/** 表情入口（笑脸），与「+」等线框图标同款描边风格：直径略大于「+」以取得视觉均衡。 */
export function SmileIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M9.5 9.7h.01M14.5 9.7h.01" />
      <path d="M8.8 14a3.9 3.9 0 0 0 6.4 0" />
    </svg>
  );
}

/** 占位「用户」头像图标：圆形头部 + 肩部剪影，用于未登录等无头像场景。
 *  与项目其它线框图标同款描边风格，几何与 UserMenu 紧凑模式的内联人形图标保持一致。 */
export function UserIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20v-1.5a7 7 0 0 1 14 0V20" />
    </svg>
  );
}

/** 联系人图标：UserIcon 人形 + 右后方叠一个同款人形（偏移 +3.2/-2.6，被前方人形遮挡），
 *  双人作为整体居中。与 UserIcon 的区别 = 多一个在后面的人，表达「通讯录/联系人」。
 *  遮挡用纯黑白 mask 实现（与当前底色无关）：后方人形穿过前方人形剪影的线条会被遮掉，
 *  任何背景色下都呈现「前人在前、后人在后」的干净效果。 */
export function ContactsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <defs>
        <mask id="agent-kit-contacts-mask">
          <rect width="24" height="24" fill="#fff" />
          {/* 前方人形剪影（头部 + 肩部），用于遮掉后方人形重叠的线条 */}
          <circle cx="10.4" cy="9.05" r="3.5" fill="#000" stroke="none" />
          <path d="M3.4 21.05v-1.5a7 7 0 0 1 14 0V21.05Z" fill="#000" stroke="none" />
        </mask>
      </defs>
      {/* 右后方的人：露出头与右肩，被前方人形遮挡 */}
      <g mask="url(#agent-kit-contacts-mask)">
        <g transform="translate(3.2 -2.6)">
          <circle cx="10.4" cy="9.05" r="3.5" />
          <path d="M3.4 21.05v-1.5a7 7 0 0 1 14 0V21.05" />
        </g>
      </g>
      {/* 前方的人（即 UserIcon 本体，左移后与后方人形整体居中） */}
      <circle cx="10.4" cy="9.05" r="3.5" />
      <path d="M3.4 21.05v-1.5a7 7 0 0 1 14 0V21.05" />
    </svg>
  );
}

/** 在会话中添加用户（人形 + 加号），与项目其他线框图标同款描边风格。 */
export function AddUserIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0-8 0m8 12h6m-3-3v6M6 21v-2a4 4 0 0 1 4-4h4" />
    </svg>
  );
}

/** 群设置（标准齿轮），描边风格与顶栏其它图标一致。 */
export function SettingsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * 兜底「模型」图标：等距立方体（package / model 的通用隐喻）。
 *
 * 用途：模型列表里绝大多数模型没有 Brand logo（CodeBuddy 下发的 meta.iconUrl 覆盖率并不满），
 * 缺图时不能留空、也不该显示首字母（中文名模型会变成一堆重复的字），统一用这个中性字形。
 * 由 `<ModelIcon>` 提供浅灰圆角方槽背景，所以这里只画线条、不填充，靠 currentColor 跟随主题。
 * 几何：六边形外轮廓（2.6~21.4 竖向居中）+ 顶面两条棱 + 前面竖棱。
 * 描边取 2.2（比常规图标 1.8 略粗）：它实际只按 16px 槽宽的 ~78% 渲染（约 12.5px），
 * 细描边在小尺寸下会糊成一团灰。
 */
export function ModelFallbackIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 2.6 21 7.6v8.8L12 21.4 3 16.4V7.6z" />
      <path d="m3 7.6 9 5 9-5M12 12.6v8.8" />
    </svg>
  );
}

/** 「新建文件夹」图标：描边线框文件夹 + 中央加号，与项目其它线框图标同款描边风格。
 *  图形原画在 y=5~21（视觉中心 y≈13），比 24×24 viewBox 中心低 1，用 <g transform="translate(0 -1)"> 整体上移 1 个单位使其垂直居中。 */
export function NewFolderIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <g transform="translate(0 -1)">
        <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2.1 2.2h6.9A2.5 2.5 0 0 1 21 9.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5z" />
        <path d="M3 9.7h18" />
        <path d="M12 12v6M9 15h6" />
      </g>
    </svg>
  );
}
