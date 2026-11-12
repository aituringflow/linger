import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSessionUser, resolveLoginOptions } from "@turingflow/agent-kit";
import { LoginPage, DingTalkAutoLogin } from "@turingflow/agent-kit/ui";

// 登录页：登录方式清单由「app 通过 URL 参数 ?providers= 传入的 env」决定，优先级高于
// web 服务自身的 AUTH_PROVIDER。不传 ?providers= → 只给 builtin（账号登录）。
//   - ?providers= 取值与 AUTH_PROVIDER 同语法（逗号/竖线分隔，如 builtin,feishu）；
//   - adaptive 会按 UA 展开；未配齐 env 的方式被 isMethodConfigured 过滤掉（安全）；
//   - 只有一个真实登录方式 → 服务端直接 302 到该方式 OAuth，无选择器；
//   - 多个 → 渲染黑白灰登录方式选择器；
//   - 注意：Next basePath=/linger，redirect() 会自动拼 basePath，
//     所以这里的路径不能带 root 前缀（带上了会变成 /linger/linger/... 404）。
export default async function LoginPageRoute({ searchParams }) {
  // Next.js 15+ 的 searchParams 是 Promise，必须先 await（否则读到 undefined，
  // params.next / params.error 静默丢失、安全跳转回落到 /linger/）。
  const params = await searchParams;
  const requestHeaders = await headers();
  // 浏览器返回或直接打开 /login 时，已登录用户始终回到业务页。
  // 在服务端检查，避免先闪现登录界面再由客户端跳走。
  if (getSessionUser(new Request("http://localhost", {
    headers: { cookie: requestHeaders.get("cookie") || "" },
  }))) {
    redirect("/");
  }
  // 登录方式清单：优先用 app 通过 ?providers= 传入的 env；不传则仅 builtin。
  // 必须与登录 API（/api/auth/login|register）用同一套 resolveLoginOptions，否则会出现
  // 「页面显示了账号登录、提交却被拒绝 → 登录方式不可用」的分裂。
  const rawProviders = typeof params.providers === "string" ? params.providers : "";
  const options = resolveLoginOptions(rawProviders);
  const root = options.cookiePath; // = Next basePath，如 /linger

  const rawNext = typeof params.next === "string" ? params.next : "";
  const safeNext = rawNext === root || rawNext.startsWith(`${root.replace(/\/+$/, "")}/`) ? rawNext : `${root}/`;
  const total = options.providers.length;
  const hasDingTalk = options.providers.some((p) => p.id === "dingtalk");
  const hasFeishu = options.providers.some((p) => p.id === "feishu");
  const hasBuiltin = options.providers.some((p) => p.id === "builtin");

  // 注意：Next.js 15+ 的 headers() 是异步 API，必须 await
  const ua = requestHeaders.get("user-agent") || "";
  const inDingTalk = /DingTalk/i.test(ua);
  const inFeishu = /(Lark|Feishu)/i.test(ua);

  // 钉钉 App 内 + 清单含钉钉：渲染登录页让免登组件先跑（adaptive 与单钉钉方式共用）
  const canAutoSso = hasDingTalk && inDingTalk && !inFeishu && !hasBuiltin;
  // 飞书 App 内 + 清单含飞书且非单飞书方式：直接跳飞书 OAuth（adaptive 自动定向）
  const autoFeishu = hasFeishu && inFeishu && !canAutoSso && !hasBuiltin && total > 1;

  if (total === 1 && !canAutoSso && !hasBuiltin) {
    redirect(
      `/api/auth/login?provider=${encodeURIComponent(options.providers[0].id)}&next=${encodeURIComponent(safeNext)}`,
    );
  }
  if (autoFeishu) {
    redirect(
      `/api/auth/login?provider=feishu&next=${encodeURIComponent(safeNext)}`,
    );
  }

  return (
    <LoginPage
      basePath={root}
      title="Agent"
      error={typeof params.error === "string" ? params.error : undefined}
      next={safeNext}
      providers={options.providers}
      loginProviders={rawProviders}
      providerIcons={{ dingtalk: `${root}/icons/dingtalk_rounded.png`, feishu: `${root}/icons/feishu.png` }}
      detected={canAutoSso ? "dingtalk" : "none"}
    >
      {canAutoSso ? (
        <DingTalkAutoLogin
          basePath={root}
          clientId={process.env.DD_CLIENT_ID || ""}
          corpId={process.env.DD_CORP_ID || ""}
        />
      ) : null}
    </LoginPage>
  );
}
