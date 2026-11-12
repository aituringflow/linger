import { apiFetch } from "./apiFetch.ts";
import { realtimeClient } from "./realtime.ts";

const pending = new Map<string, Promise<void>>();
/** 注册失败的 SW 地址：会话内不再重试，避免每次组件挂载都打一次 404 */
const failedUrls = new Set<string>();

function publicKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const binary = atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface WebPushOptions {
  /**
   * Service Worker 脚本地址。默认 `${basePath}/api/sw`（agent-kit 自带并自托管，
   * 见 kit-api 的 /api/sw 端点），宿主无需再在 public/ 中放 sw.js。
   * 若想用宿主自己的脚本，可显式传入，例如 `${basePath}/sw.js`。
   */
  serviceWorkerUrl?: string;
}

export function ensureWebPushSubscription(basePath: string, options: WebPushOptions = {}): Promise<void> {
  if (typeof window === "undefined" || !window.isSecureContext || !("serviceWorker" in navigator)
    || !("PushManager" in window) || Notification.permission !== "granted") return Promise.resolve();
  const current = pending.get(basePath);
  if (current) return current;
  const swUrl = options.serviceWorkerUrl ?? `${basePath}/api/sw`;
  if (failedUrls.has(swUrl)) return Promise.resolve();
  const task = (async () => {
    const response = await apiFetch(`${basePath}/api/push`, { cache: "no-store" });
    if (!response.ok) return;
    const { publicKey } = await response.json() as { publicKey?: string | null };
    if (!publicKey) return;
    const registration = await navigator.serviceWorker.register(swUrl, { scope: `${basePath}/` });
    failedUrls.delete(swUrl);
    const applicationServerKey = publicKeyBytes(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription?.options.applicationServerKey
      && !applicationServerKey.every((byte, index) => new Uint8Array(subscription!.options.applicationServerKey!)[index] === byte)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    const saved = await apiFetch(`${basePath}/api/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription) });
    if (!saved.ok) throw new Error(`subscription rejected: HTTP ${saved.status}`);
  })().catch(error => {
    failedUrls.add(swUrl);
    console.error("[web-push] subscription failed", error);
  }).finally(() => pending.delete(basePath));
  pending.set(basePath, task);
  return task;
}

export function installPushProbe(basePath: string): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === "agent-push-probe" && !document.hidden && document.hasFocus() && realtimeClient(basePath).isConnected())
      event.ports[0]?.postMessage("active");
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

export async function removeWebPushSubscription(basePath: string): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration(`${basePath}/`);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await apiFetch(`${basePath}/api/push`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}
