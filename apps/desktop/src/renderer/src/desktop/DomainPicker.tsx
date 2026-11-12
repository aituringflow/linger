import { useTranslation } from "../i18n";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useLauncher } from "../state";
import { wallpaperSkinId, type WallpaperSkinId } from "../wallpapers";
import WindowFrame from "../dock/WindowFrame";
import { DomainIcon } from "../icons";

/** 选择数域弹窗里展示的应用。 */
const DOMAIN_APPS = ["wechat", "contacts", "knowledge"] as const;
/** 第一行（系统区）：联系人 + 设置；第二行（数域区）：其余数域。两行之间一条水平分割线。 */
const TOP_ROW_APPS = ["contacts", "knowledge"] as const;
const BOTTOM_ROW_APPS = DOMAIN_APPS.filter((id) => !(TOP_ROW_APPS as readonly string[]).includes(id));

/** 弹窗高度（顶栏 38 + 内容区 18 上下内距 + 102 图标块×2 + 分隔线约 29 + 1px 描边×2）：只用来把它摆在屏幕正中。 */
const DIALOG_HEIGHT = 310;

/** 指针落在 Dock 的哪个半边（决定固定到 Home 左侧还是右侧）；离 Dock 太远返回 null。 */
function dockDropSide(x: number, y: number, primaryX: number): "left" | "right" | null {
  const dock = document.querySelector(".dock")?.getBoundingClientRect();
  if (!dock || y < dock.top - 54 || y > dock.bottom + 20 || x < dock.left - 90 || x > dock.right + 90) return null;
  return x < primaryX ? "left" : "right";
}

/**
 * 「选择数域」窗口。
 *
 * 它是和 Home / 数域窗口同一套 **WindowFrame** 渲染出来的真窗口（可以拖动、有红绿灯），
 * 只是能力被参数裁到最小：只有关闭按钮（最小化 / 全屏都关掉）、不可拖边框改尺寸、
 * 不记忆位置（每次都在屏幕正中出现）。
 *
 * 交互：
 *  · 点图标 = 打开对应数域应用；
 *  · 把图标拖到 Dock = 固定成常驻图标（拖动时的幽灵图标由 Dock 渲染）；
 *  · Esc / 左上角关闭按钮 = 收起。
 */
export default function DomainPicker() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const skinId = wallpaperSkinId(launcher.wallpaper);
  // 外观映射同 Dock：浅色/深色即皮肤本身，静态/动态走壁纸皮肤，让联系人徽章随外观切换配色。
  const skin: WallpaperSkinId | "light" | "dark" = launcher.appearance === "light" || launcher.appearance === "dark"
    ? launcher.appearance
    : skinId;
  const domains = launcher.domains ?? [];
  const close = () => dispatch({ type: "SET_DOMAIN_PICKER", open: false });

  // —— 把数域图标从弹窗拖到 Dock 上固定成常驻图标（macOS 从 Launchpad 拖进 Dock 的手感）——
  const dragStartRef = useRef<{ id: string; x: number; y: number; primaryX: number; active: boolean } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const draggedRef = useRef(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ type: "SET_DOMAIN_PICKER", open: false });
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [dispatch]);

  useEffect(() => {
    // modalless：点击弹窗外的任意位置直接收起（含聊天区域、Dock、桌面等一切）。capture 阶段
    // 监听避免被其他处理抢先拦截；仅弹窗自身（data-window-id="domain-picker"）除外。
    const onDocPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-window-id="domain-picker"]')) return;
      dispatch({ type: "SET_DOMAIN_PICKER", open: false });
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [dispatch]);

  useEffect(() => {
    function onWindowPointerUp(event: PointerEvent) { finishDomainDragAt(event.clientX, event.clientY); }
    function onWindowPointerCancel() { finishDomainDragAt(0, 0, true); }
    window.addEventListener("pointerup", onWindowPointerUp, true);
    window.addEventListener("pointercancel", onWindowPointerCancel, true);
    window.addEventListener("blur", onWindowPointerCancel);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp, true);
      window.removeEventListener("pointercancel", onWindowPointerCancel, true);
      window.removeEventListener("blur", onWindowPointerCancel);
      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    };
  }, []);

  function onDomainPointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) return;
    draggedRef.current = false;
    // 记录 Home 图标中心：Drop 时按落在它左边还是右边决定插到左侧还是右侧。
    const primary = document.querySelector(".dock-primary-icon")?.getBoundingClientRect();
    dragStartRef.current = {
      id, x: event.clientX, y: event.clientY,
      primaryX: primary ? primary.left + primary.width / 2 : window.innerWidth / 2,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onDomainPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragStartRef.current;
    if (!drag) return;
    // 小位移当点击处理，避免手抖就把图标拖走。
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 7) return;
    drag.active = true;
    event.preventDefault();
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    const { clientX: x, clientY: y } = event;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      dispatch({ type: "SET_DOMAIN_DRAG", drag: { id: drag.id, x, y, side: dockDropSide(x, y, drag.primaryX), source: "sidebar" } });
    });
  }

  function finishDomainDragAt(x: number, y: number, cancelled = false) {
    const drag = dragStartRef.current;
    if (!drag) return;
    dragStartRef.current = null;
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
    if (!drag.active) return;
    draggedRef.current = true;
    const side = cancelled ? null : dockDropSide(x, y, drag.primaryX);
    if (side) {
      dispatch({ type: "PIN_DOCK_DOMAIN", domainId: drag.id, side });
      close();
    } else {
      dispatch({ type: "SET_DOMAIN_DRAG", drag: null });
    }
    // 清掉"刚拖过"的标记要等本轮点击事件走完，否则 pointerup 后的 click 会把图标当成点击打开。
    window.setTimeout(() => { draggedRef.current = false; }, 0);
  }

  // 竖直居中：窗口的 top = 12 + offsetY，所以 offsetY 要扣掉这 12px 的基准。
  const centeredY = Math.max(0, Math.round((window.innerHeight - DIALOG_HEIGHT) / 2) - 12);

  return (
    <>
      {/* 非 modal：点击弹窗外的任何区域（含 Dock）自然收起。透明 backdrop 拦在弹窗之下。 */}
      <div className="domain-picker-backdrop" aria-hidden="true" onClick={close} />
      <WindowFrame
        id="domain-picker"
        skinId={skinId}
        className="is-dialog"
        style={{ zIndex: 950 }}
        ariaLabel={t("domains.choose")}
        header={<strong className="window-frame-title">{t("domains.choose")}</strong>}
        headerAlign="center"
        controls={{ close: true, minimize: false, maximize: false }}
        resizable={false}
        rememberGeometry={false}
        /* 对话框的高度由内容撑开：不传 fitContent 时长宽会走 .quick-input.focus-mode 的
           「视口高 − 106px」默认值，一个只有两个图标的弹窗被拉成几乎全屏。 */
        fitContent
        initialSize={{ width: 420 }}
        initialOffset={{ x: 0, y: centeredY }}
        onClose={close}
      >
      <div className="launcher-domain-apps">
        {/* 第一行：系统区（联系人 + 设置），两者均可拖进 Dock。 */}
        <div className="launcher-domain-row">
          {TOP_ROW_APPS.map((id) => {
            const item = domains.find((candidate) => candidate.id === id);
            return (
              <button
                key={id}
                type="button"
                onPointerDown={(event) => onDomainPointerDown(event, id)}
                onPointerMove={onDomainPointerMove}
                onPointerUp={(event) => finishDomainDragAt(event.clientX, event.clientY)}
                onPointerCancel={() => finishDomainDragAt(0, 0, true)}
                onDragStart={(event) => event.preventDefault()}
                onClick={() => {
                  if (draggedRef.current) return;
                  close();
                  dispatch({ type: "OPEN_DOMAIN_FOCUS_CHAT", domainId: id });
                }}
                title={t("domains.openPin")}
              >
                <DomainIcon id={id} size={50} skin={skin} />
                <span>{id === "contacts" ? t("common.contacts") : id === "knowledge" ? t("common.knowledge") : id === "wechat" ? t("common.wechat") : item?.name ?? id}</span>
              </button>
            );
          })}
          <button
            type="button"
            className="is-action"
            onPointerDown={(event) => onDomainPointerDown(event, "settings")}
            onPointerMove={onDomainPointerMove}
            onPointerUp={(event) => finishDomainDragAt(event.clientX, event.clientY)}
            onPointerCancel={() => finishDomainDragAt(0, 0, true)}
            onDragStart={(event) => event.preventDefault()}
            onClick={() => {
              if (draggedRef.current) return;
              close();
              dispatch({ type: "OPEN_DOMAIN_FOCUS_CHAT", domainId: "settings" });
            }}
            title={t("domains.openPin")}
          >
            <DomainIcon id="settings" size={50} skin={skin} />
            <span>{t("common.settings")}</span>
          </button>
        </div>
        <hr className="launcher-domain-sep" aria-hidden="true" />
        {/* 第二行：数域区（微信）。与第一行一样左对齐，起排位置对齐内容左边缘。 */}
        <div className="launcher-domain-row">
          {BOTTOM_ROW_APPS.map((id) => {
            const item = domains.find((candidate) => candidate.id === id);
            return (
              <button
                key={id}
                type="button"
                onPointerDown={(event) => onDomainPointerDown(event, id)}
                onPointerMove={onDomainPointerMove}
                onPointerUp={(event) => finishDomainDragAt(event.clientX, event.clientY)}
                onPointerCancel={() => finishDomainDragAt(0, 0, true)}
                onDragStart={(event) => event.preventDefault()}
                onClick={() => {
                  if (draggedRef.current) return;
                  close();
                  if (id === "wechat") {
                    void window.launcher.openWechatPoc(launcher.appearance === "light" ? "light" : "dark").then((result) => {
                      if (result.ok) dispatch({ type: "OPEN_DOMAIN_FOCUS_CHAT", domainId: id });
                      else window.alert(result.error ?? t("domains.wechatError"));
                    });
                  } else dispatch({ type: "OPEN_DOMAIN_FOCUS_CHAT", domainId: id });
                }}
                title={t("domains.openPin")}
              >
                <DomainIcon id={id} size={50} skin={skin} />
                <span>{id === "contacts" ? t("common.contacts") : id === "knowledge" ? t("common.knowledge") : id === "wechat" ? t("common.wechat") : item?.name ?? id}</span>
              </button>
            );
          })}
        </div>
      </div>
    </WindowFrame>
    </>
  );
}
