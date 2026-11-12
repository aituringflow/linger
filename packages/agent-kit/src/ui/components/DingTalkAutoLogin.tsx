"use client";

/**
 * agent-kit · 钉钉 App 内 JSAPI 自动免登
 *
 * 在钉钉客户端内打开登录页时自动请求 authCode → POST basePath/api/auth/sso → 跳转回首页。
 * 用法（LoginPage 的 children）：
 *
 *   <LoginPage basePath="/linger" title="AI 助手">
 *     <DingTalkAutoLogin basePath="/linger" clientId="dingxxxx" corpId="dingyyyy" />
 *   </LoginPage>
 *
 * 浏览器（非钉钉）内打开时不渲染任何内容。
 */
import { useEffect, useState } from "react";

const SDK_URL = "https://g.alicdn.com/dingding/dingtalk-jsapi/3.1.0/dingtalk.open.js";

interface DingTalkAutoLoginProps {
  /** API 根路径（决定 sso 端点与回跳路径） */
  basePath: string;
  /** 钉钉微应用 ClientId（AppKey） */
  clientId: string;
  /** 钉钉企业 CorpId */
  corpId: string;
}

function loadDingTalkSdk(): Promise<unknown> {
  if (typeof window !== "undefined" && (window as { dd?: unknown }).dd) {
    return Promise.resolve((window as { dd?: unknown }).dd);
  }
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SDK_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve((window as { dd?: unknown }).dd), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve((window as { dd?: unknown }).dd);
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

export function DingTalkAutoLogin({ basePath, clientId, corpId }: DingTalkAutoLoginProps) {
  const [status, setStatus] = useState("");
  const root = basePath.replace(/\/+$/, "");

  useEffect(() => {
    const inDingTalk = typeof window !== "undefined" && /DingTalk/i.test(window.navigator.userAgent);
    if (!inDingTalk || !clientId || !corpId) return;

    let active = true;
    const fail = () => {
      if (active) setStatus("自动免登未完成，请点击下方按钮登录");
    };

    loadDingTalkSdk()
      .then((dd) => {
        const api = (dd as { runtime?: { permission?: { requestAuthCode?: (opts: unknown) => void } } } | undefined)
          ?.runtime?.permission?.requestAuthCode;
        if (!api) throw new Error("DingTalk JSAPI unavailable");
        if (active) setStatus("正在使用钉钉身份免登…");
        api({
          clientId,
          corpId,
          onSuccess: async ({ code }: { code: string }) => {
            try {
              const response = await fetch(`${root}/api/auth/sso`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ code, next: `${root}/`, provider: "dingtalk" }),
              });
              const result = (await response.json()) as { next?: string; message?: string };
              if (!response.ok) throw new Error(result.message || "免登失败");
              window.location.replace(result.next || `${root}/`);
            } catch {
              fail();
            }
          },
          onFail: fail,
        });
      })
      .catch(fail);

    return () => {
      active = false;
    };
  }, [root, clientId, corpId]);

  if (!status) return null;
  return (
    <div className="login-auto-status" role="status">
      <i aria-hidden="true" />
      {status}
    </div>
  );
}
