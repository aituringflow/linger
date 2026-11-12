"use client";
import { useEffect, useMemo, useState } from "react";
import { useContacts, type CompanyContactUi } from "../shared/useContacts.ts";
import { Avatar } from "../shared/AvatarView.tsx";

/** 联系人头像：无图时用蓝底姓名文字（≤2 字全名，否则后两字），与搜索结果、选人弹窗一致 */
function ContactAvatar({ person }: { person: CompanyContactUi }) {
  return <Avatar name={person.name} src={person.avatar || undefined} className="contacts-avatar" />;
}

type DepartmentNode = {
  key: string;
  name: string;
  parentKey: string | null;
  children: Set<string>;
  directPeople: Set<string>;
  allPeople: Set<string>;
};

const ROOT = "";
const keyFor = (parts: string[]) => parts.join("\u001f");

function buildDepartments(contacts: CompanyContactUi[]) {
  const nodes = new Map<string, DepartmentNode>();
  nodes.set(ROOT, { key: ROOT, name: "组织架构", parentKey: null, children: new Set(), directPeople: new Set(), allPeople: new Set() });
  for (const contact of contacts) {
    nodes.get(ROOT)!.allPeople.add(contact.id);
    const paths = contact.department.split("、").map(path => path.split(/\s+\/\s+/).map(name => name.trim()).filter(Boolean));
    for (const parts of paths) {
      if (!parts.length) { nodes.get(ROOT)!.directPeople.add(contact.id); continue; }
      let parentKey = ROOT;
      for (let index = 0; index < parts.length; index++) {
        const key = keyFor(parts.slice(0, index + 1));
        if (!nodes.has(key)) nodes.set(key, { key, name: parts[index], parentKey, children: new Set(), directPeople: new Set(), allPeople: new Set() });
        nodes.get(parentKey)!.children.add(key);
        nodes.get(key)!.allPeople.add(contact.id);
        parentKey = key;
      }
      nodes.get(parentKey)!.directPeople.add(contact.id);
    }
  }
  return nodes;
}

export default function ContactsView({ basePath }: { basePath: string }) {
  const { contacts, loading, error, reload } = useContacts(basePath);
  const [departmentKey, setDepartmentKey] = useState(ROOT);
  const [visibleCount, setVisibleCount] = useState(100);
  const [query, setQuery] = useState("");
  const nodes = useMemo(() => buildDepartments(contacts), [contacts]);
  const peopleById = useMemo(() => new Map(contacts.map(person => [person.id, person])), [contacts]);
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return contacts.filter(person =>
      person.name.toLowerCase().includes(q) ||
      person.department.toLowerCase().includes(q) ||
      (person.title ?? "").toLowerCase().includes(q) ||
      (person.email ?? "").toLowerCase().includes(q)
    );
  }, [query, contacts]);
  const current = nodes.get(departmentKey) ?? nodes.get(ROOT)!;
  const departments = useMemo(() => [...current.children].map(key => nodes.get(key)!).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")), [current, nodes]);
  const people = useMemo(() => [...current.directPeople].map(id => peopleById.get(id)).filter((person): person is CompanyContactUi => Boolean(person)), [current, peopleById]);
  const breadcrumbs: DepartmentNode[] = [];
  for (let node: DepartmentNode | undefined = current; node; node = node.parentKey === null ? undefined : nodes.get(node.parentKey)) breadcrumbs.unshift(node);
  useEffect(() => setVisibleCount(100), [departmentKey]);
  useEffect(() => { if (!nodes.has(departmentKey)) setDepartmentKey(ROOT); }, [departmentKey, nodes]);

  return <main className="agent-navigation-page contacts-page">
    <header className="agent-navigation-page-head contacts-head"><span>通讯录</span></header>
    <div className="agent-navigation-page-body contacts-body">
      {loading && !contacts.length ? <div className="contacts-state">正在读取企业通讯录…</div> : error ? <div className="contacts-state contacts-error" role="alert"><strong>{error.title}</strong><p>{error.detail}</p><p>{error.suggestion}</p><button type="button" onClick={reload}>重试</button></div> : <>
        <div className="contacts-search">
          <input
            type="search"
            className="contacts-search-input"
            placeholder="搜索姓名、部门、职位或邮箱"
            value={query}
            onChange={event => { setQuery(event.target.value); setVisibleCount(100); }}
            aria-label="搜索通讯录"
          />
        </div>
        {searchResults ? (
          <>
            <p className="contacts-count">{searchResults.length ? `找到 ${searchResults.length} 位联系人` : "未找到匹配的联系人"}</p>
            {searchResults.length ? <div className="contacts-list">{searchResults.slice(0, visibleCount).map(person => <div className="contacts-row" key={`${person.provider}:${person.id}`}>
              <ContactAvatar person={person} />
              <div className="contacts-primary"><strong>{person.name}</strong><span>{person.department}{person.title ? ` · ${person.title}` : ""}</span></div>
              <div className="contacts-details">{person.email && <a href={`mailto:${person.email}`}>{person.email}</a>}</div>
            </div>)}{visibleCount < searchResults.length ? <button type="button" className="contacts-load-more" onClick={() => setVisibleCount(count => count + 100)}>显示更多（剩余 {searchResults.length - visibleCount} 人）</button> : null}</div> : null}
          </>
        ) : (
          <>
        <div className="contacts-hierarchy-head"><strong>{current.name}</strong><span>{current.allPeople.size} 人</span></div>
        {departmentKey !== ROOT ? <nav className="contacts-breadcrumbs" aria-label="部门路径">{breadcrumbs.map((node, index) => <span key={node.key}>{index ? <span aria-hidden="true"> / </span> : null}<button type="button" onClick={() => setDepartmentKey(node.key)} aria-current={node.key === departmentKey ? "page" : undefined}>{node.name}</button></span>)}</nav> : null}
        {departments.length ? <div className="contacts-list contacts-departments">{departments.map(node => <button type="button" className="contacts-department-row" key={node.key} onClick={() => setDepartmentKey(node.key)}>
          <span className="contacts-primary"><strong>{node.name}</strong><span>{node.allPeople.size} 人</span></span><span className="contacts-department-count">{node.allPeople.size}</span><span className="contacts-department-arrow" aria-hidden="true">›</span>
        </button>)}</div> : null}
        {people.length ? <><p className="contacts-count">{departments.length ? "本部门成员" : `${people.length} 位联系人`}</p><div className="contacts-list">{people.slice(0, visibleCount).map(person => <div className="contacts-row" key={`${person.provider}:${person.id}`}>
          <ContactAvatar person={person} />
          <div className="contacts-primary"><strong>{person.name}</strong><span>{person.department}{person.title ? ` · ${person.title}` : ""}</span></div>
          <div className="contacts-details">{person.email && <a href={`mailto:${person.email}`}>{person.email}</a>}</div>
        </div>)}{visibleCount < people.length ? <button type="button" className="contacts-load-more" onClick={() => setVisibleCount(count => count + 100)}>显示更多（剩余 {people.length - visibleCount} 人）</button> : null}</div></> : !departments.length ? <div className="contacts-state">{contacts.length ? "这个部门暂无成员" : "暂无可见联系人，请检查应用通讯录可见范围"}</div> : null}
          </>
        )}
      </>}
    </div>
  </main>;
}
