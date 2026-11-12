import { useEffect, useState, type ComponentPropsWithoutRef } from "react";

/** Resolve persisted knowledge image IDs to the current local server after a restart. */
export function KnowledgeChatImage({ src, alt, ...props }: ComponentPropsWithoutRef<"img">) {
  const match = /^http:\/\/127\.0\.0\.1:\d+\/images\/([a-f0-9]{48})$/.exec(src ?? "");
  const id = match?.[1];
  const snapshot = /^https:\/\/local-knowledge\.invalid\/v1\/chat-image\/([a-zA-Z0-9_-]{1,200})\/([a-zA-Z0-9_-]{1,128})\/([a-f0-9]{64}\.(?:png|jpe?g|webp))$/.exec(src ?? "");
  const api = typeof window === "undefined" ? undefined : (window as Window & { launcher?: { knowledge?: { resolveChatImage?: (id: string) => Promise<string | null>; resolveChatSnapshot?: (owner: string, sessionId: string, name: string) => Promise<string | null> } } }).launcher?.knowledge;
  const [resolved, setResolved] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setResolved(null);
    if (snapshot && api?.resolveChatSnapshot) void api.resolveChatSnapshot(snapshot[1], snapshot[2], snapshot[3]).then(url => { if (active) setResolved(url); }).catch(() => {});
    else if (id && api?.resolveChatImage) void api.resolveChatImage(id).then(url => { if (active) setResolved(url); }).catch(() => {});
    return () => { active = false; };
  }, [id, src, api]);
  if ((!id || !api?.resolveChatImage) && (!snapshot || !api?.resolveChatSnapshot)) return <img {...props} src={src} alt={alt} />;
  return resolved ? <img {...props} src={resolved} alt={alt} /> : <span role="img" aria-label={alt || "图片不可用"}>{alt || "图片不可用"}</span>;
}
