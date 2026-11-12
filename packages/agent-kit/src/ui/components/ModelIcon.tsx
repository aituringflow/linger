"use client";

/**
 * 模型图标：**三级回落** —— SDK 给的图 → 自绘品牌字形 → 通用兜底字形。
 *
 * 1. `meta.iconUrl`（CodeBuddy 下发，远程 SVG/PNG 或 `data:` 内联）：有就用。
 * 2. 没有图但能认出品牌（deepseek / glm / kimi / minimax / step / mimo / bunny）：
 *    用 `ModelBrandIcon` 的自绘单色字形顶上 —— 实测下发覆盖率很低，若全部退化成同一个灰方块，
 *    下拉列表就完全失去辨识度了。
 * 3. 连品牌都认不出：`ModelFallbackIcon` 的中性立方体 + 浅灰方槽。
 *
 * 为什么要包一层组件而不是各处手写 `<img src={meta.iconUrl}>`：
 * - 三种形态（remote / data: / 无）和三种回落分支不该在每个调用点重复；
 * - `<img>` 会被宿主 CSP、断网、404 打死，`onError` 后必须能退回字形，否则列表里是破图或高度塌陷；
 * - 三种分支共用同一个方形槽（`--model-icon-size`），列表行高与基线永远一致。
 *
 * 注意：外部 SVG 里的 `currentColor` 在 `<img>` 语境下**不会**继承宿主的 `color`（实测恒为黑），
 * 所以不做染色，logo 保持原样；只有我们自绘的字形才跟随主题。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { ModelFallbackIcon } from "../icons/SharedIcons.tsx";
import { ModelBrandIcon, modelBrandOf, type ModelBrand } from "../icons/ModelBrandIcons.tsx";

export type ModelIconProps = {
  /** CodeBuddy 下发的模型图标地址（https 远程资源或 data: 内联 SVG/PNG）。 */
  iconUrl?: string;
  /** 模型 id（如 `deepseek-v4.1-flash`）：没有 iconUrl 时用它匹配自绘品牌字形。 */
  modelId?: string;
  /** 展示名：id 匹配不到品牌时用它兜一层（如 `Kimi K3`）。 */
  name?: string;
  /** 直接指定品牌；传 `null` 表示强制走通用兜底（跳过品牌匹配）。不传则按 id/name 自动匹配。 */
  brand?: ModelBrand | null;
  /** 方形槽边长（px），默认 16。字形大小由 `.chat-model-icon` 的样式控制。 */
  size?: number;
  /** 追加类名，用于宿主微调（外层槽的定位/外边距）。 */
  className?: string;
  /** 无障碍名称；默认不朗读（图标后面通常紧跟模型名文本，重复朗读反而吵）。 */
  label?: string;
};

export function ModelIcon({ iconUrl, modelId, name, brand, size = 16, className, label }: ModelIconProps) {
  // 记录「这一张图加载失败」，换图时重置（列表复用同一个组件实例的场景）。
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [iconUrl]);

  const src = (iconUrl || "").trim();
  const hasImage = Boolean(src) && !failed;
  const resolvedBrand = hasImage ? null : brand !== undefined ? brand : modelBrandOf(modelId, name);
  const kind = hasImage ? "image" : resolvedBrand ? "brand" : "fallback";
  const cls = ["chat-model-icon", kind === "brand" ? "is-brand" : "", kind === "fallback" ? "is-fallback" : "", className || ""]
    .filter(Boolean)
    .join(" ");
  const style = { "--model-icon-size": `${size}px` } as CSSProperties;

  return (
    <span
      className={cls}
      style={style}
      data-model-icon={kind}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
    >
      {hasImage ? (
        <img
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : resolvedBrand ? <ModelBrandIcon brand={resolvedBrand} /> : <ModelFallbackIcon />}
    </span>
  );
}

export default ModelIcon;
