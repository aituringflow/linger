import { useEffect, useRef } from "react";
import { caretPoint } from "./caretPoint";
import { createDragonBreath } from "./dragonBreath";
import { createDragonSpriteRig, DRAGON_BOX, DRAGON_MOUTH } from "./dragonSpriteRig";
import { playDragonFireSound } from "./dragonSound";
import { isDragActive, subscribeDragIdle } from "./dragIdle";

const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

/** 小龙贴输入卡右上角的偏移（CSS px），与火焰的视觉比例一致。 */
const DRAGON_X = 158;
const DRAGON_Y = 90;
/** 一次喷火的动画总时长：mouthOpen 包络 = 170ms 张嘴 + 1080ms 保持 + 240ms 收。 */
const FIRE_MS = 1320;

/**
 * A shared body and head with two separately posed wings and foreground claws.
 *
 * 渲染是**事件驱动**的：空闲时一帧都不排（rAF 完全停摆），只在需要动画时逐帧重绘 ——
 * 喷火、打字展翅、注视点移动后的身体倾斜、输入卡尺寸变化。静止姿态的轻微呼吸摆动
 * 交给 CSS 动画（见 styles.css 的 .dragon-pet.is-idle），由合成器完成，不占 JS 主线程。
 *
 * 为什么值得这么改：这个组件以前每帧都要 querySelector + getBoundingClientRect/offsetWidth
 * 定位、每 45ms 还要跑一次 caretPoint()（造镜像 div + 两次布局测量），约 16 次强制布局读取/帧。
 * 布局不失效时这些读取很便宜，但只要有别的东西在改 DOM（拖拽、流式输出），每次读取都会变成
 * 一次完整的同步重排。现在几何量全部缓存，只在 ResizeObserver / 光标事件时重算。
 */
export default function DragonPet({ active, preview, minimized = false, fireSound = true, windowId, onHideDragon }: { active: boolean; preview?: boolean; minimized?: boolean; fireSound?: boolean; windowId: string; onHideDragon?: () => void }) {
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const minimizedRef = useRef(minimized);
  minimizedRef.current = minimized;
  const fireSoundRef = useRef(fireSound);
  fireSoundRef.current = fireSound;
  /** 循环空闲时不会自己发现预览/最小化状态变了，必须由外部叫醒。 */
  const wakeRef = useRef<() => void>(() => {});

  useEffect(() => {
    wakeRef.current();
  }, [preview, minimized]);

  useEffect(() => {
    if (!active) return;
    const back = document.createElement("div");
    back.className = "dragon-pet dragon-pet-back";
    back.setAttribute("aria-hidden", "true");
    const front = document.createElement("button");
    front.type = "button";
    front.className = "dragon-pet dragon-pet-front";
    front.setAttribute("aria-label", "让小龙向输入框喷火");
    front.title = "点击小龙喷火";
    const rig = createDragonSpriteRig(back, front);
    // 初始姿态：flutter 关掉，保证首帧就是确定的静止帧（循环停摆期间不会再画）。
    rig.draw(0, 0, performance.now(), true);
    const gaze = document.createElement("span");
    gaze.className = "dragon-pet-gaze";
    back.append(gaze);
    const canvas = document.createElement("canvas");
    canvas.className = "dragon-pet-breath";
    canvas.setAttribute("aria-hidden", "true");
    const breath = createDragonBreath(canvas);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let frameId = 0;
    let retryTimer: number | undefined;
    let planted = false;
    let visible = false;
    let breathDirty = false;
    let geoStale = true;
    let targetStale = true;
    let fireStarted = -Infinity;
    let lastTyping = -Infinity;
    let wingSpread = 0;
    let lean = 0;
    let lastFrame = performance.now();
    let ratio = Math.min(window.devicePixelRatio || 1, 2);
    let frameEl: HTMLElement | null = null;
    let composerEl: HTMLElement | null = null;
    let observer: ResizeObserver | undefined;
    // 缓存几何（布局 px，不受输入卡 appearing 动画的 transform 影响）
    let composerLeft = 0, composerTop = 0, composerWidth = 0, composerHeight = 0;
    let target = { x: 0, y: 0 };

    function locate() {
      if (frameEl && composerEl && composerEl.isConnected) return true;
      frameEl = [...document.querySelectorAll<HTMLElement>(".quick-input.skin-wp4")]
        .find((element) => element.dataset.windowId === windowId) ?? null;
      composerEl = frameEl?.querySelector<HTMLElement>(".chat-composer-stack") ?? null;
      observer?.disconnect();
      observer = undefined;
      if (!frameEl || !composerEl) return false;
      observer = new ResizeObserver(() => { geoStale = true; wake(); });
      observer.observe(frameEl);
      observer.observe(composerEl);
      geoStale = true;
      return true;
    }

    function measure() {
      const frame = frameEl, composer = composerEl;
      if (!frame || !composer) return;
      composerWidth = composer.offsetWidth;
      composerHeight = composer.offsetHeight;
      // 输入卡的居中 translateX(-50%) 不体现在 offsetLeft 中。龙跟着输入卡一起
      // 位移，喷火画布却挂在 frame 上，因此必须用实际位置换算到 frame 坐标。
      const outer = frame.getBoundingClientRect(), inner = composer.getBoundingClientRect();
      const scale = outer.width / (frame.offsetWidth || outer.width) || 1;
      composerLeft = (inner.left - outer.left) / scale;
      composerTop = (inner.top - outer.top) / scale;
      back.style.left = front.style.left = `${composerWidth - DRAGON_X}px`;
      back.style.top = front.style.top = `${-DRAGON_Y}px`;
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.ceil(frame.offsetWidth * ratio), height = Math.ceil(frame.offsetHeight * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${frame.offsetWidth}px`;
        canvas.style.height = `${frame.offsetHeight}px`;
        breathDirty = false; // 改 canvas 尺寸会清空内容
      }
      geoStale = false;
      targetStale = true;
    }

    function updateTarget() {
      const frame = frameEl, composer = composerEl;
      if (!frame || !composer) return;
      targetStale = false;
      const outer = frame.getBoundingClientRect();
      const scale = outer.width / (frame.offsetWidth || outer.width) || 1;
      const input = composer.querySelector<HTMLTextAreaElement>("textarea:not([disabled])");
      const point = input
        ? caretPoint(input)
        : { x: outer.left + (composerLeft + 90) * scale, y: outer.top + (composerTop + 35) * scale };
      const x = (point.x - outer.left) / scale, y = (point.y - outer.top) / scale;
      target = {
        x: Math.max(composerLeft + 24, Math.min(composerLeft + composerWidth - 24, x)),
        y: Math.max(composerTop + 16, Math.min(composerTop + composerHeight - 18, y)),
      };
    }

    function requestFrame() {
      if (frameId) return;
      frameId = window.requestAnimationFrame(tick);
    }

    /** 叫醒循环（空闲时它已经彻底停了）。 */
    function wake() {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      requestFrame();
    }

    let menuEl: HTMLElement | null = null;
    let menuCleanup: Array<() => void> = [];

    function closeDragonMenu() {
      if (!menuEl) return;
      menuEl.remove();
      menuEl = null;
      for (const off of menuCleanup) off();
      menuCleanup = [];
    }

    /** 右键小龙 → 「隐藏火龙」上下文菜单。挂到 body 上避免被输入卡裁切，位置贴近光标并收进视口。 */
    function openDragonMenu(clientX: number, clientY: number) {
      closeDragonMenu();
      const menu = document.createElement("div");
      menu.className = "dragon-context-menu";
      menu.setAttribute("role", "menu");
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.textContent = "隐藏火龙";
      item.addEventListener("click", () => {
        closeDragonMenu();
        onHideDragon?.();
      });
      menu.append(item);
      // 先挂载拿到实际尺寸，再把菜单收进视口；visibility 先藏起来，避免定位时闪一下。
      menu.style.left = "0px";
      menu.style.top = "0px";
      menu.style.visibility = "hidden";
      document.body.append(menu);
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(clientX + 6, window.innerWidth - rect.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(clientY + 6, window.innerHeight - rect.height - 8))}px`;
      menu.style.visibility = "";
      menuEl = menu;

      const onPointerDown = (event: PointerEvent) => {
        // 点在菜单内（含刚点的「隐藏火龙」按钮）不关；外部任意按下关闭。
        if (menu.contains(event.target as Node)) return;
        closeDragonMenu();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") { event.preventDefault(); closeDragonMenu(); }
      };
      const onViewportChange = () => closeDragonMenu();
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("resize", onViewportChange);
      window.addEventListener("blur", onViewportChange);
      menuCleanup = [
        () => document.removeEventListener("pointerdown", onPointerDown, true),
        () => document.removeEventListener("keydown", onKeyDown, true),
        () => window.removeEventListener("resize", onViewportChange),
        () => window.removeEventListener("blur", onViewportChange),
      ];
    }

    function hide() {
      if (visible) {
        back.style.visibility = front.style.visibility = "hidden";
        canvas.style.visibility = "hidden";
        visible = false;
      }
      back.classList.remove("is-idle");
      front.classList.remove("is-idle");
      back.style.transform = front.style.transform = "";
      if (breathDirty) {
        breath?.clear();
        breathDirty = false;
      }
      fireStarted = -Infinity;
      planted = false;
    }

    function tick(now: number) {
      frameId = 0;
      // 拖拽期间整帧跳过（此时 home 窗口 opacity: 0，龙不可见）；dragend 订阅会叫醒。
      if (isDragActive()) return;
      if (!locate()) {
        /**
         * 输入卡还没挂上（窗口刚打开 / 会话还在加载骨架屏）。**必须一直重试**：
         * 以前是「40 次 × 50ms 之后就放弃」，一旦会话加载超过 2 秒就直接停摆，
         * 之后再没有任何事件能把它叫醒 —— 现象是窗口一切正常，但桌面上根本没有小龙。
         * 现在改成 200ms 低频长轮询，找到就自然停下（locate 成功即不再排重试）。
         */
        if (retryTimer === undefined) {
          retryTimer = window.setTimeout(() => { retryTimer = undefined; requestFrame(); }, 200);
        }
        return;
      }
      const frame = frameEl!;
      const composer = composerEl!;
      if (previewRef.current || minimizedRef.current) {
        hide();
        return;
      }
      if (back.parentElement !== composer) composer.append(back, front);
      if (canvas.parentElement !== frame) frame.append(canvas);
      if (geoStale || !planted) measure();
      planted = true;
      if (targetStale) updateTarget();

      const dt = Math.min(64, Math.max(1, now - lastFrame));
      lastFrame = now;

      // 打字 → 展翅；最后一次按键后 1250ms 收回（指数逼近，收敛即停帧）
      const wantsSpread = now - lastTyping < 1250 ? 1 : 0;
      wingSpread += (wantsSpread - wingSpread) * (1 - Math.exp(-dt / (wantsSpread ? 360 : 560)));
      if (Math.abs(wantsSpread - wingSpread) < .002) wingSpread = wantsSpread;

      // 注视点 → 身体倾斜（约 167ms 时间常数，与原来固定 .1/帧 @60fps 等效）
      const caretFraction = Math.max(0, Math.min(1, (target.x - composerLeft) / (composerWidth || 1)));
      const wantLean = (caretFraction - .5) * 3.8;
      lean += (wantLean - lean) * (1 - Math.exp(-dt / 167));
      if (Math.abs(wantLean - lean) < .02) lean = wantLean;

      const fireAge = now - fireStarted;
      const firing = fireAge >= 0 && fireAge < FIRE_MS;
      const mouthOpen = firing ? smooth(fireAge / 170) * (1 - smooth((fireAge - 1080) / 240)) : 0;
      const animating = firing || wingSpread !== wantsSpread || lean !== wantLean;

      const dragonX = composerLeft + composerWidth - DRAGON_X;
      const dragonY = composerTop - DRAGON_Y;

      // 静止时把姿态交给 CSS 呼吸动画（合成器驱动，零 JS）；需要动画时才逐帧写 transform。
      // --dragon-lean 一直同步，让两条路径的起始角衔接，切换时不会跳一下。
      back.style.setProperty("--dragon-lean", `${lean}deg`);
      front.style.setProperty("--dragon-lean", `${lean}deg`);
      back.classList.toggle("is-idle", !animating);
      front.classList.toggle("is-idle", !animating);
      back.style.transform = front.style.transform = animating ? `rotate(${lean}deg)` : "";

      // 静止帧也画一次，把翅膀/头部收到确定姿态；之后不再排帧。
      rig.draw(wingSpread, mouthOpen, now, reducedMotion.matches || !animating);

      const eyeX = dragonX + 60, eyeY = dragonY + 34;
      const angle = Math.atan2(target.y - eyeY, target.x - eyeX);
      gaze.style.transform = `translate(${Math.cos(angle) * 2.4}px, ${Math.sin(angle) * 2.4}px)`;

      if (!visible) {
        back.style.visibility = front.style.visibility = "visible";
        canvas.style.visibility = "visible";
        visible = true;
      }

      if (firing) {
        /**
         * 喷口 = 小龙盒子里 mouth-open 精灵图上「上下颚之间」的那个点，再跟着身体倾斜一起转。
         * 盒子整体的 transform-origin 是 50% 100%（见 styles.css 的 .dragon-pet），
         * 所以旋转要绕盒子底部中点做，否则输入框偏左/偏右时（lean ≠ 0）火焰会从脸颊侧面出来。
         */
        const radians = (lean * Math.PI) / 180;
        const originX = DRAGON_BOX.width / 2;
        const originY = DRAGON_BOX.height;
        const localX = DRAGON_MOUTH.x - originX;
        const localY = DRAGON_MOUTH.y - originY;
        const mouth = {
          x: dragonX + originX + localX * Math.cos(radians) - localY * Math.sin(radians),
          y: dragonY + originY + localX * Math.sin(radians) + localY * Math.cos(radians),
        };
        const dx = target.x - mouth.x, dy = target.y - mouth.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const shorten = Math.min(32, distance * .1);
        breath?.draw(now, mouth, { x: target.x - dx / distance * shorten, y: target.y - dy / distance * shorten }, fireAge - 170, ratio);
        breathDirty = true;
      } else if (breathDirty) {
        breath?.clear();
        breathDirty = false;
      }

      if (animating) requestFrame();
    }
    wakeRef.current = wake;

    const inputOf = (el: EventTarget | null) => {
      if (!(el instanceof HTMLTextAreaElement)) return null;
      return composerEl?.contains(el) ? el : null;
    };
    const markTyping = (event: Event) => {
      if (!inputOf(event.target)) return;
      if (event instanceof KeyboardEvent && event.key.length !== 1 && !["Backspace", "Delete", "Enter"].includes(event.key)) return;
      lastTyping = performance.now();
      wake();
    };
    // 光标/选区变化（方向键、点击、换行重排）→ 喷火落点失效，重算一次
    const onSelectionChange = () => {
      if (inputOf(document.activeElement)) {
        targetStale = true;
        requestFrame();
      }
    };
    // 输入框内部滚动（长文本）同理
    const onScroll = (event: Event) => {
      const el = event.target;
      if (el instanceof Node && composerEl?.contains(el)) {
        targetStale = true;
        requestFrame();
      }
    };
    const onResize = () => {
      geoStale = true;
      wake();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
    };

    document.addEventListener("input", markTyping, true);
    document.addEventListener("keydown", markTyping, true);
    document.addEventListener("compositionupdate", markTyping, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    const unsubscribeDrag = subscribeDragIdle(() => { geoStale = true; wake(); });

    front.addEventListener("pointerdown", (event) => event.preventDefault());
    front.addEventListener("click", (event) => {
      event.stopPropagation();
      // 预览态/最小化时 tick 不会画帧，火焰根本不会出现；这时也不该出声。
      if (previewRef.current || minimizedRef.current) return;
      fireStarted = performance.now();
      lastFrame = fireStarted;
      geoStale = true;
      targetStale = true;
      playDragonFireSound(fireSoundRef.current);
      wake();
    });
    // 右键小龙 → 弹出「隐藏火龙」菜单（预览/最小化态不弹：这时 tick 不画帧，龙本身不可见）。
    front.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (previewRef.current || minimizedRef.current) return;
      openDragonMenu(event.clientX, event.clientY);
    });
    requestFrame();

    return () => {
      wakeRef.current = () => {};
      window.cancelAnimationFrame(frameId);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      observer?.disconnect();
      unsubscribeDrag();
      document.removeEventListener("input", markTyping, true);
      document.removeEventListener("keydown", markTyping, true);
      document.removeEventListener("compositionupdate", markTyping, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      back.remove(); front.remove(); canvas.remove(); breath?.destroy();
      closeDragonMenu();
    };
  }, [active, windowId]);
  return null;
}
