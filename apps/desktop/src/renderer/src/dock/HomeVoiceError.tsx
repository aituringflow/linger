"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Home 上方的语音错误条。
 *
 * 为什么挂在 Home 上而不是弹窗 / 系统通知：用户是「按住 Option（Windows 右 Alt）」这个动作失败的，
 * 视线就在 Dock 上那块会播声波的位置。错误出现在声波该出现的地方，因果最直观；
 * 而 showErrorBox 那种模态框会打断输入，系统通知在开发机上大概率被静音掉。
 *
 * 位置与 .dock-tooltip 同一套口径：portal 到 body（Dock 溢出时 overflow-x:auto 会把浮层裁掉），
 * fixed 定位 + translate(-50%, -100%) 悬在 Home 图标正上方。
 */
export interface HomeVoiceErrorProps {
  message: string;
  detail?: string;
  /** 需要用户执行的动作：目前只有 "login"（显示登录按钮）。 */
  action?: "login";
  /** 点掉 / Esc（由宿主统一处理自动消失的定时器）。 */
  onDismiss: () => void;
  /** 点击动作按钮（如「去登录」）。 */
  onAction?: () => void;
}

export default function HomeVoiceError({ message, detail, action, onDismiss, onAction }: HomeVoiceErrorProps) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const home = document.querySelector<HTMLElement>(".dock-home-item");
    if (!home) return;
    const measure = () => {
      const rect = home.getBoundingClientRect();
      // top 用「Home 图标上沿 - 14px」，配合 translate(-50%, -100%) 让气泡底边贴在图标上方。
      setAnchor({ left: rect.left + rect.width / 2, top: Math.max(8, rect.top - 14) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  if (!anchor) return null;
  return createPortal(
    <div
      className="home-voice-error"
      role="alert"
      style={{ left: anchor.left, top: anchor.top }}
    >
      <span className="home-voice-error-mark" aria-hidden="true">!</span>
      <div className="home-voice-error-text">
        <p className="home-voice-error-message">{message}</p>
        {detail ? <p className="home-voice-error-detail">{detail}</p> : null}
        {action === "login" && onAction ? (
          <button
            type="button"
            className="home-voice-error-action"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
              onAction();
            }}
          >
            去登录
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="home-voice-error-close"
        aria-label="关闭"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
