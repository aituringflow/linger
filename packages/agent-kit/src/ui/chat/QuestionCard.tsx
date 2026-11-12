"use client";

import { useChatTranslation } from "./i18n.tsx";

import { useState, type ReactNode } from "react";
import type { UiQuestion } from "./types.ts";

// 结构化提问卡片（AskUserQuestion）：模型需要用户确认/选择时渲染。
// 交互：始终只显示一张卡片（一个问题）。顶部箭头可自由切换上一题/下一题；
// 底部「下一步」顺序推进到下一题（当前题未作答时禁用），最后一题变为「提交答案」。
// 选择项只在本地位标记选中态（不立即发送）；提交时把整组答案一次性发回模型（resume 同一会话）。
// 已提交过的卡片（answered 非空）渲染为只读态，避免重复提交/历史卡片可点造成"卡死"错觉。
export default function QuestionCard({
  questions,
  answered,
  onSubmit,
}: {
  questions: UiQuestion[];
  answered: string | null;
  onSubmit: (text: string, answers: Record<string, string>) => void;
}): ReactNode {
  const t = useChatTranslation();
  // 当前展示第几题（0-based）；sel/custom 以题索引为 key，切题时已选内容保留
  const [cur, setCur] = useState(0);
  // sel: { [questionIdx]: optionIdx | optionIdx[] }（多选时为数组）；custom: { [questionIdx]: 自由文本 }
  const [sel, setSel] = useState<Record<number, number | number[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  if (answered || questions.length === 0) {
    // ask_user 是中间交互过程：用户已提交答案、模型已继续，整个卡片隐藏。
    // 用户答案本身已作为一条 user 消息入库，历史里能看到；不需要再保留卡片。
    return null;
  }

  const count = questions.length;
  // 题目数量变化（新的 ask_question 替换旧问题组）时防止索引越界
  const safeCur = Math.min(cur, count - 1);
  const q = questions[safeCur];
  const isLast = safeCur === count - 1;

  const pick = (qi: number, oi: number, multi?: boolean) => {
    setSel((curSel) => {
      const next: Record<number, number | number[]> = { ...curSel };
      const prev = next[qi];
      if (multi) {
        const arr = Array.isArray(prev) ? [...prev] : [];
        const pos = arr.indexOf(oi);
        if (pos >= 0) arr.splice(pos, 1);
        else arr.push(oi);
        next[qi] = arr;
      } else {
        next[qi] = oi;
      }
      return next;
    });
    // 单选下选了预设项即清空“其他”自定义文本（二者互斥）
    if (!multi) setCustom((curCustom) => ({ ...curCustom, [qi]: "" }));
  };

  const onCustom = (qi: number, multi: boolean | undefined, val: string) => {
    setCustom((curCustom) => ({ ...curCustom, [qi]: val }));
    // 单选下一旦填写自定义文本，清空已选预设项（自定义优先）
    if (!multi && val.trim()) {
      setSel((curSel) => {
        const next = { ...curSel };
        delete next[qi];
        return next;
      });
    }
  };

  const isPicked = (qi: number, oi: number, multi?: boolean) => {
    const v = sel[qi];
    if (multi) return Array.isArray(v) && v.includes(oi);
    return v === oi;
  };

  // 一道题“已作答”的判据：填了自定义文本，或选了选项
  const isAnswered = (item: UiQuestion, qi: number) => {
    if ((custom[qi] || "").trim()) return true;
    const v = sel[qi];
    if (item.multiSelect) return Array.isArray(v) && v.length > 0;
    return v != null;
  };

  const allPicked = questions.every((item, qi) => isAnswered(item, qi));
  const curAnswered = isAnswered(q, safeCur);
  const answeredCount = questions.filter((item, qi) => isAnswered(item, qi)).length;

  const submit = () => {
    const lines: string[] = [];
    const answers: Record<string, string> = {};
    questions.forEach((item, qi) => {
      const txt = (custom[qi] || "").trim();
      const v = sel[qi];
      const idxs: number[] = item.multiSelect
        ? (Array.isArray(v) ? v : [])
        : (typeof v === "number" ? [v] : []);
      const labels = idxs.map((i) => item.options[i]?.label).filter(Boolean) as string[];
      if (txt) {
        // 自定义答案：单选直接作为答案；多选则与所选预设合并
        if (item.multiSelect) {
          const all = [...labels, txt];
          answers[String(qi)] = all.join(", ");
          lines.push(`「${item.question}」→ ${all.join("、")}`);
        } else {
          answers[String(qi)] = txt;
          lines.push(`「${item.question}」→ ${txt}`);
        }
      } else {
        answers[String(qi)] = item.multiSelect ? labels.join(", ") : labels[0] || "";
        lines.push(`「${item.question}」→ ${labels.join("、")}`);
      }
    });
    onSubmit(lines.join("\n"), answers);
  };

  // 顺序推进：非最后一题要求当前题已作答；最后一题直接提交
  const goNext = () => {
    if (isLast) { submit(); return; }
    if (!curAnswered) return;
    setCur(safeCur + 1);
  };

  return (
    <div className="chat-question-wrap">
      <div className="chat-question-card">
        <div className="chat-question-nav">
          <button
            type="button"
            className="chat-question-nav-arrow"
            disabled={safeCur === 0}
            onClick={() => setCur(safeCur - 1)}
            aria-label={t("previous")}
            title={t("previous")}
          >
            ‹
          </button>
          <span className="chat-question-nav-progress" aria-live="polite">
            {safeCur + 1} / {count}
          </span>
          <button
            type="button"
            className="chat-question-nav-arrow"
            disabled={isLast}
            onClick={() => setCur(safeCur + 1)}
            aria-label={t("nextQuestion")}
            title={t("nextQuestion")}
          >
            ›
          </button>
        </div>
        {q.header ? <div className="chat-question-header">{q.header}</div> : null}
        <div className="chat-question-text">
          {q.question}
          {q.multiSelect ? <span className="chat-question-multi">{t("multi")}</span> : null}
        </div>
        <div className="chat-question-options">
          {q.options.map((opt, oi) => {
            const picked = isPicked(safeCur, oi, q.multiSelect);
            return (
              <button
                key={oi}
                type="button"
                className={`chat-question-opt${picked ? " is-selected" : ""}`}
                aria-pressed={picked}
                onClick={() => pick(safeCur, oi, q.multiSelect)}
              >
                <span className="chat-question-opt-label">{opt.label}</span>
                {opt.description ? (
                  <span className="chat-question-opt-desc">{opt.description}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="chat-question-other">
          <span className="chat-question-other-label">{t("other")}</span>
          <input
            type="text"
            className="chat-question-other-input"
            placeholder={t("otherPlaceholder")}
            value={custom[safeCur] || ""}
            onChange={(e) => onCustom(safeCur, q.multiSelect, e.target.value)}
          />
        </div>
        <div className="chat-question-submit-row">
          <button
            type="button"
            className="chat-question-submit"
            disabled={isLast ? !allPicked : !curAnswered}
            onClick={goNext}
          >
            {isLast
              ? (allPicked ? t("submitAnswers") : t("answerProgress", { answered: answeredCount, count }))
              : (curAnswered ? t("next") : t("answerFirst"))}
          </button>
        </div>
      </div>
    </div>
  );
}
