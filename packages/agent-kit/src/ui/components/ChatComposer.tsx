"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { imeCompositionEnd, imeCompositionStart, isImeConfirmKey } from "../shared/ime.ts";
import { ARTIFACT_FILE_MIME } from "../shared/artifactFileDrag.ts";
import { isVoiceHoldKey } from "../shared/platform.ts";
import type { UiAttachment } from "../AgentWindow.tsx";

const MIN_TEXTAREA_HEIGHT = 60;
const MAX_TEXTAREA_HEIGHT = 180;

// 纯触控设备（手机/平板，无实体回车键）：其系统输入法的动作键默认标"换行"，
// 此时回车应插入换行而非发送；发送统一走右下角发送按钮。
const IS_TOUCH_ONLY =
  typeof window !== "undefined" &&
  window.matchMedia("(hover: none) and (pointer: coarse)").matches;

// ==================== ChatComposer：聊天输入框 ====================
// 独立管理 input state + textarea + autoGrow + IME 组合 + 草稿文字防抖上报。
// 打字（setInput）只触发本组件重渲染，AgentWindow 主组件（消息列表/侧栏/工具栏）完全不动——
// 根治「输入卡顿」：不再每次按键全量重建消息列表的 vdom 与 Markdown 解析。
// 父组件经 ref 桥接：setText（草稿恢复/编辑队列回填）、appendText（语音转写）、
// sendNow（发送按钮）、focus（空态自动聚焦）；草稿文字经 onDraftSave 防抖回传（父组件写 localStorage，含附件快照）。
export interface ChatComposerHandle {
  /** 回填文字；caret 省略时把光标放到文末 */
  setText: (t: string, caret?: number) => void;
  /** 读取当前输入框文字（提示词增强等功能在点击时刻取原文用） */
  getText: () => string;
  appendText: (t: string) => void;
  sendNow: () => void;
  focus: () => void;
  flushDraft: () => void;
  discardDraft: () => void;
}

export interface ChatComposerProps {
  activeSid: string;
  busy: boolean;
  booting: boolean;
  uploading: boolean;
  /** 模型列表加载中（仅自动拉取时为真）：占位提示用，不阻断编辑 */
  modelLoading: boolean;
  /** 发送被模型状态阻断（加载中或加载失败无可用模型）：Enter 提交也直接忽略，
   *  避免 send() 静默早退造成的"发了没反应"。文本框依旧可编辑。 */
  modelBlocked: boolean;
  attachments: UiAttachment[];
  recording: boolean;
  transcribing: boolean;
  onSend: (text: string) => void;
  onDraftSave: (text: string) => void;
  /** 输入内容存在性变化回调（空 ↔ 非空翻转时触发一次；打字过程中不触发，父级不重渲染）。
   *  父组件用它控制发送按钮 disabled：无文字且无附件时不可发送。 */
  onHasInputChange: (has: boolean) => void;
  onHasTextChange: (has: boolean) => void;
  /**
   * 「有内容」回调（文字**或**附件任一非空）。与 onHasInputChange 同义，
   * 单独给一个是为了让宿主能区分「只有文字」与「文字+附件」——
   * 例如宿主的 home 悬浮输入框：只挂了附件时浮层不能自动收起。
   */
  onHasContentChange?: (has: boolean) => void;
  mobileVoiceMode: boolean;
  appName?: string;
  /** 显式传入空字符串可隐藏占位文案；省略时继续使用 kit 的默认文案。 */
  placeholder?: string;
  /** 外部（如群聊 @ 提及）需要实时读取输入值与光标位置时回调（输入/光标移动/IME 结束触发） */
  onValueChange?: (value: string, selectionStart: number) => void;
  /** 仅用户直接编辑文字时触发；程序回填草稿和发送后的清空不会触发。 */
  onUserValueChange?: (value: string, selectionStart: number) => void;
  /** 回车前的拦截钩子：返回 true 则阻止默认发送（例如用回车选择 @ 提及项）。
   *  仅在非 IME 组合态、未按下 Shift 时调用。 */
  onEnter?: () => boolean;
  /** 按键拦截钩子：返回 true 则阻止该按键的默认行为（上下键选 @ 成员、Tab 选中、Esc 关闭）。
   *  仅在非 IME 组合态调用。 */
  onKeyDownIntercept?: (key: string) => boolean;
  onVoiceHoldStart?: () => boolean;
  onVoiceHoldEnd?: (cancelled?: boolean) => void;
  /** 从系统剪贴板粘贴图片（截图等）：拿到 File[] 后作为附件上传。纯文本粘贴不触发。 */
  onPasteFiles?: (files: File[]) => void;
}

const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  { activeSid, busy, booting, uploading, modelLoading, modelBlocked, attachments, recording, transcribing, onSend, onDraftSave, onHasInputChange, onHasTextChange, onHasContentChange, mobileVoiceMode, appName, placeholder, onValueChange, onUserValueChange, onEnter, onKeyDownIntercept, onVoiceHoldStart, onVoiceHoldEnd, onPasteFiles },
  ref,
) {
  const t = useChatTranslation();
  const [input, setInput] = useState("");
  const [compactPlaceholder, setCompactPlaceholder] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 语音按住键（平台相关）：Windows=右侧 Alt；macOS=Option（左右均可）。
  // 检测逻辑在 shared/platform.ts 的 isVoiceHoldKey，这里只管按住/松开的状态机。
  const voiceHoldKeyHeldRef = useRef(false);
  const voiceHoldStartedAtRef = useRef(0);
  const voiceHoldCancelledRef = useRef(false);
  const voiceHoldStartRef = useRef(onVoiceHoldStart);
  voiceHoldStartRef.current = onVoiceHoldStart;
  const onVoiceHoldEndRef = useRef(onVoiceHoldEnd);
  onVoiceHoldEndRef.current = onVoiceHoldEnd;
  const voiceHoldBlockedRef = useRef(booting || recording || transcribing);
  voiceHoldBlockedRef.current = booting || recording || transcribing;
  const pressVoiceHoldKey = (event: Pick<globalThis.KeyboardEvent, "key" | "code" | "location">) => {
    if (!isVoiceHoldKey(event) || voiceHoldKeyHeldRef.current || voiceHoldBlockedRef.current || !document.hasFocus()) return;
    if (voiceHoldStartRef.current?.()) {
      voiceHoldKeyHeldRef.current = true;
      voiceHoldStartedAtRef.current = performance.now();
      voiceHoldCancelledRef.current = false;
    }
  };
  const pressVoiceHoldKeyRef = useRef(pressVoiceHoldKey);
  pressVoiceHoldKeyRef.current = pressVoiceHoldKey;
  useEffect(() => {
    const press = (event: globalThis.KeyboardEvent) => {
      if (voiceHoldKeyHeldRef.current && !isVoiceHoldKey(event)) {
        voiceHoldCancelledRef.current = true;
        voiceHoldKeyHeldRef.current = false;
        onVoiceHoldEndRef.current?.(true);
        return;
      }
      pressVoiceHoldKeyRef.current(event);
    };
    const release = (event?: Event) => {
      if (!voiceHoldKeyHeldRef.current || (event instanceof KeyboardEvent && !isVoiceHoldKey(event))) return;
      voiceHoldKeyHeldRef.current = false;
      onVoiceHoldEndRef.current?.(voiceHoldCancelledRef.current || performance.now() - voiceHoldStartedAtRef.current < 1000);
    };
    window.addEventListener("keydown", press, true);
    window.addEventListener("keyup", release, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", press, true);
      window.removeEventListener("keyup", release, true);
      window.removeEventListener("blur", release);
      release();
    };
  }, []);
  // input 的 ref 镜像：cleanup（卸载/切会话）里读最新值，避免闭包过期
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  // 草稿保存的防抖定时器：尾值在卸载/切会话时由 cleanup 兜底写回
  const draftTimerRef = useRef<number | null>(null);
  const lastDraftInputRef = useRef(input);
  const onDraftSaveRef = useRef(onDraftSave);
  onDraftSaveRef.current = onDraftSave;

  // 把当前输入值与光标位置同步给外部（群聊 @ 提及需要光标所在处的上下文）。
  // 除输入外，点击/方向键移动光标也会触发，否则 @ 列表无法在句中重新出现。
  const emitValue = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    onValueChange?.(el.value, el.selectionStart ?? el.value.length);
  }, [onValueChange]);

  // 输入内容存在性上报：仅空↔非空翻转时通知父组件（父组件用它禁用/启用发送按钮）。
  // 打字过程连续变化不触发（与草稿防抖同理，父级不随打字重渲染）。
  useEffect(() => {
    const has = input.trim().length > 0 || attachments.length > 0;
    onHasInputChange(has);
    onHasContentChange?.(has);
  }, [input, attachments, onHasInputChange, onHasContentChange]);
  useEffect(() => {
    onHasTextChange(input.trim().length > 0);
  }, [input, onHasTextChange]);

  // 输入框随内容自适应高度，最高 MAX，超过再出滚动条。
  // 附件位于输入框上方时仍需保留完整的一行文字高度和内边距。
  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const isMobile = window.matchMedia("(max-width: 767.98px)").matches;
    // 移动端：行高 28px = 框高、上下内边距 0（与 styles.css 里 textarea 的 height:28px、
    // padding:0 2px、line-height:28px 对齐），单行文字精确垂直居中；超长内容仍按 scrollHeight 增高。
    const minH = isMobile ? 28 : MIN_TEXTAREA_HEIGHT;
    // 空输入不按 placeholder 的换行高度增长。
    // 浏览器对 textarea 的 scrollHeight 可能把最小高度与小数行高向上取整 1–2px。
    // 单行输入仍保持原始卡片高度，直到内容真正超过最小高度。
    const measured = el.scrollHeight;
    const next = inputRef.current && measured > minH + 3
      ? Math.min(measured, MAX_TEXTAREA_HEIGHT)
      : minH;
    el.style.height = `${next}px`;
    el.style.overflowY = measured > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }

  useEffect(() => {
    autoGrow();
  }, [input, attachments]);

  // 按输入框实际宽度响应：窗口缩放、侧栏拖拽都可能缩窄输入区。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setCompactPlaceholder(el.clientWidth < 480);
      setMobileLayout(window.matchMedia("(max-width: 767.98px)").matches);
      autoGrow();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 草稿文字变化：防抖 400ms 后经 onDraftSave 回传父组件（父组件写 localStorage 含附件快照，
  // 不触发父组件 setState → 打字时父级不重渲染）。
  useEffect(() => {
    // 首次挂载没有用户改动。StrictMode 会重放挂载 effect，不能因此把空输入写回草稿。
    if (lastDraftInputRef.current === input) return;
    lastDraftInputRef.current = input;
    if (draftTimerRef.current != null) window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      onDraftSaveRef.current(inputRef.current);
    }, 400);
  }, [input]);
  // 卸载 / 切会话：只在仍有未完成的文字防抖时写回。
  // 附件变化会更新 onDraftSave 回调，但不能因此执行旧回调：旧回调持有变化前的附件，
  // 会把刚恢复或刚上传的附件从草稿中覆盖掉。
  useEffect(() => {
    return () => {
      if (draftTimerRef.current != null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
        onDraftSave(inputRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSid]);

  // 提交：文字 + 附件任一非空即可发送（busy 时父组件 send 会转入待发队列）；
  // 发送动作即清空输入框（与旧行为一致）。模型未就绪（modelBlocked）时直接忽略——
  // 此时不应静默掉发送（send 会早退），也不应清空已输入的文字，让用户继续编辑、等模型就绪再发。
  const submit = () => {
    const text = input.trim();
    if ((!text && !attachments.length) || uploading || booting || modelBlocked) return;
    inputRef.current = "";
    setInput("");
    onSend(text);
  };

  useImperativeHandle(ref, () => ({
    setText: (t: string, caret?: number) => {
      inputRef.current = t;
      setInput(t);
      // 回填后把光标落到指定位置（群聊在句中选择 @ 成员时用），默认文末。
      const position = caret ?? t.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.setSelectionRange(position, position);
        onValueChange?.(t, position);
      });
    },
    appendText: (t: string) => {
      const trimmed = (t || "").trim();
      if (!trimmed) return;
      const el = textareaRef.current;
      const cur = inputRef.current;
      const start = el ? (el.selectionStart ?? cur.length) : cur.length;
      const end = el ? (el.selectionEnd ?? start) : start;
      // 插入语义：无选中且光标在文末时与「追加」等价；选中/光标在句中时插入到该处。
      // 前文以非空白结尾时补一个空格隔开，保持转写文字的可读性。
      const before = cur.slice(0, start);
      const sep = before && !/\s$/.test(before) ? " " : "";
      const next = `${before}${sep}${trimmed}${cur.slice(end)}`;
      const caret = start + sep.length + trimmed.length;
      inputRef.current = next;
      setInput(next);
      // 转写插入后：光标落到插入文字末尾并聚焦，用户可继续手动输入或再次按住语音键继续追加。
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(caret, caret);
      });
      onValueChange?.(next, caret);
    },
    getText: () => inputRef.current,
    sendNow: () => submit(),
    focus: () => textareaRef.current?.focus(),
    flushDraft: () => {
      if (draftTimerRef.current != null) window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
      onDraftSave(inputRef.current);
    },
    discardDraft: () => {
      if (draftTimerRef.current != null) window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    },
  }));

  // 中文输入法组合输入中（拼音候选态/直接打英文）按回车：应先把内容放入输入框，不触发发送。
  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    pressVoiceHoldKey(e.nativeEvent);
    // 纯触控设备（手机/平板）：系统输入法的动作键标"换行"，按它应插入换行而不是发送。
    // 仅当输入法正在组词（拼音候选态，isComposing 为真）时拦截回车——确认候选词，
    // 既不插入换行也不发送；其余情况（含非组词时点击"换行"动作键）保留 textarea 默认换行行为。
    if (IS_TOUCH_ONLY) {
      if (e.nativeEvent.isComposing) e.preventDefault();
      return;
    }
    if (isImeConfirmKey(e)) {
      if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (onEnter?.() === true) return;
      submit();
      return;
    }
    // 其余按键（↑↓ 选择 @ 成员、Tab 选中、Esc 关闭）交给外部拦截。
    if (onKeyDownIntercept?.(e.key) === true) e.preventDefault();
  }

  // 剪贴板粘贴：系统截图（Win+Shift+S 等）会把 PNG 放进剪贴板，
  // 复制网页/微信图片同理。这里只拦截「含文件」的粘贴，取出 File 交给上传链路，
  // 纯文本/富文本粘贴原样放行（不拦截），不影响正常打字粘贴文字。
  function handlePaste(e: ReactClipboardEvent<HTMLTextAreaElement>) {
    const dt = e.clipboardData;
    if (!dt) return;
    const pasted: File[] = [];
    // 优先 clipboardData.files（最直接）；某些场景只有 items 里带文件，再兜底扫一遍。
    if (dt.files && dt.files.length) {
      for (const file of Array.from(dt.files)) if (file) pasted.push(file);
    }
    if (!pasted.length && dt.items && dt.items.length) {
      for (const item of Array.from(dt.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) pasted.push(file);
      }
    }
    if (!pasted.length) return;
    e.preventDefault();
    // 系统截图经剪贴板传入时通常没有文件名：补一个默认名，避免附件名空缺。
    const named = pasted.map((file) => {
      if (file.name) return file;
      const ext = (file.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
      return new File([file], `pasted-image-${Date.now()}-${Math.round(Math.random() * 1e4)}.${ext || "png"}`, { type: file.type });
    });
    void onPasteFiles?.(named);
  }

  return (
    <textarea
      ref={textareaRef}
      className={mobileVoiceMode ? "chat-composer-textarea--voice" : undefined}
      rows={1}
      placeholder={placeholder ?? (mobileLayout ? t("mobilePlaceholder") : (
        uploading ? t("uploadPlaceholder")
          : modelLoading ? t("modelPlaceholder")
          : busy ? t("busyPlaceholder")
          : t("workWith", { name: appName ?? t("assistant") })
      ))}
      value={input}
      onChange={(e) => {
        inputRef.current = e.target.value;
        setInput(e.target.value);
        onValueChange?.(e.target.value, e.target.selectionStart ?? e.target.value.length);
        onUserValueChange?.(e.target.value, e.target.selectionStart ?? e.target.value.length);
      }}
      onKeyDown={onKeyDown}
      onPaste={handlePaste}
      // 点击、方向键、Home/End 移动光标后同步位置，供群聊 @ 提及判断「光标处是否正在输入 @」
      onKeyUp={emitValue}
      onSelect={emitValue}
      // 拖拽文件经过/落在输入框时阻止浏览器原生插入文件路径，避免输入框高度被撑大
      onDragOver={(e) => {
        const types = Array.from(e.dataTransfer?.types || []);
        // 文件管理器的自定义载荷也带了一份 text/plain（rel 列表），
        // 不拦的话浏览器会把 rel 文本直接插进输入框，必须一并 preventDefault。
        if (types.includes("Files") || types.includes(ARTIFACT_FILE_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const types = Array.from(e.dataTransfer?.types || []);
        if (types.includes("Files") || types.includes(ARTIFACT_FILE_MIME)) e.preventDefault();
      }}
      onCompositionStart={imeCompositionStart}
      onCompositionEnd={(e) => {
        imeCompositionEnd(e);
        setInput(e.currentTarget.value);
        onValueChange?.(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
        onUserValueChange?.(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
      }}
      disabled={booting}
      readOnly={recording || transcribing}
      aria-busy={recording || transcribing}
    />
  );
});

export default ChatComposer;
