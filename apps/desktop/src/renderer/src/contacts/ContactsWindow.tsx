import { useCallback, useEffect, useRef, useState } from "react";
import { useLauncher } from "../state";
import WindowFrame from "../dock/WindowFrame";
import { wallpaperSkinId } from "../wallpapers";

type Person = { id: string; username: string; name: string; avatar?: string | null; friend?: boolean; requested?: boolean };
type Invite = { id: string; username: string; name: string; avatar?: string | null; created_at: string };
type ContactState = { friends: Person[]; incoming: Invite[]; outgoing: Invite[] };
const empty: ContactState = { friends: [], incoming: [], outgoing: [] };

/**
 * 好友头像：有 avatar 就显示图片（可能是 http(s) URL 或 data:image/webp 的 data URL），
 * 没有或加载失败才退回名字首字母。图片加载失败要能回落——头像本质上只是装饰。
 */
function ContactAvatar({ name, src }: { name: string; src?: string | null }) {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement | null>(null);
  // 换人 / 换图时重置失败状态，否则一次失败会连带后续所有头像都变成字母。
  // 另外要主动查一次：data URL 解码失败时 error 事件可能在 React 挂上 onError 之前就发完了，
  // 那种情况只能靠挂载后看 naturalWidth 补一刀。
  useEffect(() => {
    setFailed(false);
    const element = image.current;
    if (element && element.complete && element.naturalWidth === 0) setFailed(true);
  }, [src]);
  if (src && !failed) {
    return <img ref={image} className="contacts-avatar contacts-avatar--photo" src={src} alt="" draggable={false} onError={() => setFailed(true)} />;
  }
  return <span className="contacts-avatar">{name.slice(0, 1).toUpperCase()}</span>;
}

export default function ContactsWindow({ layer, minimized, focused = false }: { layer: number; minimized: boolean; focused?: boolean }) {
  const { state, dispatch } = useLauncher();
  const skinId = wallpaperSkinId(state.launcher?.wallpaper ?? "");
  const [user, setUser] = useState<Awaited<ReturnType<typeof window.launcher.getWebSession>>>(null);
  const [data, setData] = useState<ContactState>(empty);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Person[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const refresh = useCallback(async () => {
    const current = await window.launcher.getWebSession();
    setUser(current);
    if (!current || current.provider !== "builtin") { setData(empty); return; }
    const response = await window.launcher.contactsApi("GET", "");
    if (response.ok) setData(response.data as ContactState);
    else setError(response.data.error || "联系人加载失败");
  }, []);
  useEffect(() => {
    void refresh();
    const off = window.launcher.onWebSessionChanged(() => { void refresh(); });
    const event = () => { void refresh(); };
    window.addEventListener("launcher:contacts-event", event);
    return () => { off(); window.removeEventListener("launcher:contacts-event", event); };
  }, [refresh]);
  useEffect(() => {
    if (!user || query.trim().length < 2) { setResults([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void window.launcher.contactsApi("GET", `users?q=${encodeURIComponent(query.trim())}`).then(response => {
        if (active) setResults(response.ok ? response.data.users as Person[] : []);
      });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, user, data]);
  async function invite(person: Person) {
    setBusy(person.id); setError("");
    const response = await window.launcher.contactsApi("POST", "invitations", { userId: person.id });
    if (!response.ok) setError(response.data.error || "邀请发送失败");
    await refresh(); setBusy("");
  }
  async function respond(invitation: Invite, accept: boolean) {
    setBusy(invitation.id); setError("");
    const response = await window.launcher.contactsApi("POST", `invitations/${invitation.id}/respond`, { accept });
    if (!response.ok) setError(response.data.error || "处理邀请失败");
    await refresh(); setBusy("");
  }
  /**
   * 发消息：复用 home chat 的「@联系人」流程 —— 打开主聊天窗口，把该联系人预选进输入框
   * （输入框顶部出现头像 chip + 关闭按钮），有历史 1v1 则直接打开历史会话，无历史进入新建对话
   * 空态并预选该联系人（首条消息发送时才建会话落库）。不在此处创建会话、不发送消息。
   */
  function startChat(person: Person) {
    setError("");
    // 极简模式（语音优先极简窗）下点「发消息」：退出全部极简态、恢复完整窗口，
    // 再打开主 home chat 并预选联系人（发消息目标固定是主窗口 primary）。
    for (const id of state.voiceFirstMinimal) {
      dispatch({ type: "SET_VOICE_FIRST_MINIMAL", windowId: id, value: false });
    }
    // PROMOTE_PRIMARY：打开/前置主 home chat 窗口且不设 sessionRequest（避免跳到未读会话，干扰下面的 @ 预选跳转）。
    dispatch({ type: "PROMOTE_PRIMARY" });
    dispatch({ type: "QUEUE_MENTION_REQUEST", windowId: "primary", person: { id: person.id, name: person.name, avatar: person.avatar || "" } });
  }
  /** 删除好友：删除后对方发来的消息将不再收到。 */
  async function removeFriend(person: Person) {
    if (!window.confirm(`确定删除好友 ${person.name} 吗？删除后对方发来的消息将不再收到。`)) return;
    setBusy(person.id); setError("");
    const response = await window.launcher.contactsApi("DELETE", `friends/${person.id}`);
    if (!response.ok) setError(response.data.error || "删除好友失败");
    await refresh(); setBusy("");
  }
  const isBuiltin = user?.provider === "builtin";
  return <WindowFrame id="contacts" skinId={skinId} className="contacts-window" style={{ zIndex: layer }}
    header={<span>联系人</span>} headerAlign="center" initialSize={{ width: 720, height: 580 }} minWidth={490} minHeight={400}
    onFocus={() => dispatch({ type: "FOCUS_CHAT_WINDOW", windowId: "contacts" })}
    onClose={() => dispatch({ type: "CLOSE_CHAT", windowId: "contacts" })}
    onMinimize={() => dispatch({ type: "MINIMIZE_CHAT", windowId: "contacts" })} minimized={minimized} focused={focused}>
    <div className="contacts-app">
      {!user ? <div className="contacts-empty"><h2>登录后管理联系人</h2><p>使用内置账号登录，即可搜索用户并添加好友。</p><button onClick={() => void window.launcher.openLogin(document.documentElement.dataset.theme === "dark" ? "dark" : "light")}>登录</button></div>
      : !isBuiltin ? <div className="contacts-empty"><h2>请使用内置账号</h2><p>当前好友功能支持通过内置方式注册的用户。</p></div>
      : <>
        <input id="contacts-search" className="contacts-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="输入至少两个字符搜索用户名" />
        {error && <div className="contacts-error" role="alert">{error}</div>}
        {query.trim().length >= 2 && <section className="contacts-section"><h3>搜索结果</h3>
          {results.length ? results.map(person => <div className="contacts-row" key={person.id}>
            <ContactAvatar name={person.name} src={person.avatar} /><span className="contacts-person"><strong>{person.name}</strong><small>@{person.username}</small></span>
            <button disabled={person.friend || person.requested || busy === person.id} onClick={() => void invite(person)}>{person.friend ? "已添加" : person.requested ? "已邀请" : "添加"}</button>
          </div>) : <p className="contacts-muted">没有找到用户</p>}
        </section>}
        {data.incoming.length > 0 && <section className="contacts-section"><h3>好友邀请 <em>{data.incoming.length}</em></h3>
          {data.incoming.map(invite => <div className="contacts-row" key={invite.id}>
            <ContactAvatar name={invite.name} src={invite.avatar} /><span className="contacts-person"><strong>{invite.name}</strong><small>@{invite.username} 请求添加你为好友</small></span>
            <button disabled={busy === invite.id} onClick={() => void respond(invite, true)}>同意</button><button className="secondary" disabled={busy === invite.id} onClick={() => void respond(invite, false)}>拒绝</button>
          </div>)}
        </section>}
        <section className="contacts-section"><h3>好友 {data.friends.length}</h3>
          {data.friends.length ? data.friends.map(person => <div className="contacts-row" key={person.id}><ContactAvatar name={person.name} src={person.avatar} /><span className="contacts-person"><strong>{person.name}</strong><small>@{person.username}</small></span>
            <button disabled={busy === person.id} onClick={() => void startChat(person)}>发消息</button><button className="secondary danger" disabled={busy === person.id} onClick={() => void removeFriend(person)}>删除</button>
          </div>) : <p className="contacts-muted">还没有好友，搜索用户并发送邀请吧</p>}
        </section>
        {data.outgoing.length > 0 && <section className="contacts-section"><h3>已发送邀请</h3>{data.outgoing.map(invite => <div className="contacts-row" key={invite.id}><span className="contacts-person"><strong>{invite.name}</strong><small>@{invite.username}</small></span><span className="contacts-muted">等待对方处理</span></div>)}</section>}
      </>}
    </div>
  </WindowFrame>;
}
