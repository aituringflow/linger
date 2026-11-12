'use client';

import { useMemo, useState } from 'react';
import { RotateCcw } from './icons';

// 虚构示例。五份家常材料，同一周落在两个"妈"身上。
// 材料不自动到达：用户接入一份，系统从中抽出实体与关系，才拆封下一份。
const day = value => Date.parse(value + 'T00:00:00Z');

const nodes = {
  self: { name: '我', x: 310, y: 218, r: 34 },
  mom: { name: '妈', x: 148, y: 104, r: 36 },
  wife: { name: '妻子', x: 310, y: 86, r: 30 },
  mil: { name: '妈·张桂芳', x: 472, y: 104, r: 36 },
  hometown: { name: '老家', x: 108, y: 300, r: 33 },
  city: { name: '城里', x: 512, y: 300, r: 33 },
  hospital: { name: '医院', x: 356, y: 348, r: 28 },
};

const materials = [
  {
    id: 'group', date: '2024-11-20', source: '微信 · 家庭群', title: '「今年过年回不回来？」',
    quote: '妈：今年过年回不回来？腊肉都腌好了。',
    delta: '+3 实体 · +2 关系', entities: ['mom', 'hometown'],
    edges: ['self-mom', 'mom-hometown'], requires: [],
  },
  {
    id: 'transfer', date: '2024-12-08', source: '手机银行 · 转账', title: '备注里写着「妈 生活费」',
    quote: '收款人 王秀兰 · 备注：妈 生活费。',
    delta: '0 新增 · 称呼落到人', entities: [],
    edges: [], requires: ['group'],
  },
  {
    id: 'photo', date: '2023-05-06', source: '相册 · 婚礼照', title: '照片背面写着「岳母张桂芳」',
    quote: '2023.05.06 婚礼。背面：岳母张桂芳。',
    delta: '+2 实体 · +2 关系', entities: ['wife', 'mil'],
    edges: ['self-wife', 'wife-mil'], requires: ['group'],
  },
  {
    id: 'hospital', date: '2025-01-22', source: '医院 · 挂号单', title: '岳母在城里的医院',
    quote: '患者 张桂芳，陪护 我，市一医院。',
    delta: '+2 实体 · +3 关系', entities: ['hospital', 'city'],
    edges: ['mil-hospital', 'hospital-city', 'self-mil'], requires: ['photo'],
  },
  {
    id: 'ticket', date: '2025-01-26', source: '出行 App · 行程', title: '除夕只有一天',
    quote: '除夕前一天：回老家的票，还是留在城里？',
    delta: '0 新增 · 1 处冲突', entities: [],
    edges: [], requires: ['hospital'],
  },
].map((material, index) => ({ ...material, time: day(material.date), order: index }));

const edges = {
  'self-mom': { from: 'self', to: 'mom', label: '母亲', detail: '群里她只被叫「妈」，没有名字。', when: '2024.11.20 · 聊天时间', evidence: '家庭群聊截图' },
  'mom-hometown': { from: 'mom', to: 'hometown', label: '住在', detail: '转账备注写着「妈 生活费」，收款人王秀兰，地址在老家。', when: '2024.12.08 · 转账时间', evidence: '转账记录 + 群聊里的「腊肉都腌好了」' },
  'self-wife': { from: 'self', to: 'wife', label: '妻子', detail: '婚礼合照背面写着日期与在场的人。', when: '2023.05.06 · 拍摄时间', evidence: '婚礼合照' },
  'wife-mil': { from: 'wife', to: 'mil', label: '母亲', detail: '照片背面写明岳母是张桂芳——她也被我喊「妈」。', when: '2023.05.06 · 拍摄时间', evidence: '婚礼合照' },
  'mil-hospital': { from: 'mil', to: 'hospital', label: '住院', detail: '挂号单上的患者是张桂芳。', when: '2025.01.22 · 就诊时间', evidence: '挂号单' },
  'hospital-city': { from: 'hospital', to: 'city', label: '在', detail: '市一医院在城里，离老家八百公里。', when: '2025.01.22 · 就诊时间', evidence: '挂号单上的地址' },
  'self-mil': { from: 'self', to: 'mil', label: '陪护', detail: '挂号单的陪护人写的是我。', when: '2025.01.22 · 就诊时间', evidence: '挂号单' },
  'newyear-home': { from: 'self', to: 'hometown', label: '除夕？', detail: '老家的妈在等这顿年夜饭。除夕只有一天。', when: '2025.01.26 · 尚未排定', evidence: '群聊 + 抢票提醒', pending: true },
  'newyear-city': { from: 'self', to: 'city', label: '除夕？', detail: '城里的岳母还在住院，除夕也没法离开。', when: '2025.01.26 · 尚未排定', evidence: '挂号单 + 抢票提醒', pending: true },
};

const start = Math.min(...materials.map(material => material.time));
const end = Math.max(...materials.map(material => material.time));

function labelDate(time) {
  const d = new Date(time);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function build(integrated, choice) {
  const arrived = materials.filter(material => integrated.includes(material.id));
  const active = new Set(['self']);
  arrived.forEach(material => material.entities.forEach(id => active.add(id)));
  const named = integrated.includes('transfer');

  const links = [];
  arrived.forEach(material => material.edges.forEach(id => {
    const spec = edges[id];
    if (!spec) return;
    if (!active.has(spec.from) || !active.has(spec.to)) return;
    links.push({ id, ...spec });
  }));

  let pending = 0;
  if (integrated.includes('ticket') && !choice) {
    links.push({ id: 'newyear-home', ...edges['newyear-home'] }, { id: 'newyear-city', ...edges['newyear-city'] });
    pending = 1;
  }
  if (choice === 'hometown') links.push({ id: 'newyear-home', ...edges['newyear-home'], label: '除夕在', pending: false });
  if (choice === 'city') links.push({ id: 'newyear-city', ...edges['newyear-city'], label: '除夕在', pending: false });

  const about = {};
  active.forEach(id => {
    const first = arrived.find(material => material.entities.includes(id));
    about[id] = {
      links: links.filter(link => link.from === id || link.to === id).length,
      when: first ? first.date.replace(/-/g, '.') : '始终在场',
      from: first ? first.source + ' · ' + first.title : '网络的中心',
    };
  });

  return { arrived, active, links, pending, named, about };
}

function position(edge) {
  const a = nodes[edge.from], b = nodes[edge.to];
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  const sx = a.x + dx / length * (a.r + 2), sy = a.y + dy / length * (a.r + 2);
  const tx = b.x - dx / length * (b.r + 2), ty = b.y - dy / length * (b.r + 2);
  return { sx, sy, tx, ty, lx: sx + (tx - sx) * 0.42 - dy / length * 9, ly: sy + (ty - sy) * 0.42 + dx / length * 9 };
}

function Network({ graph }) {
  const [inspect, setInspect] = useState(null);
  return <div className="journey-canvas">
    <svg className="journey-graph" viewBox="0 0 620 420" role="img" aria-label={'关系网络，当前有 ' + graph.active.size + ' 个实体、' + graph.links.length + ' 条关系'}>
    <defs>
      <radialGradient id="brain-wash"><stop stopColor="#e7e7e3"/><stop offset="1" stopColor="#f8f8f6"/></radialGradient>
      <marker id="edge-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#929292"/></marker>
      <marker id="edge-tip-pending" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#b08968"/></marker>
    </defs>
    <path className="brain-wash" d="M310 61 C280 22 227 33 208 56 C167 27 120 57 119 95 C76 92 58 130 68 164 C28 183 38 233 68 244 C56 282 82 314 116 313 C125 350 165 365 199 350 C226 380 269 365 288 352 C300 366 320 366 332 352 C359 371 400 377 423 350 C456 365 497 350 504 313 C540 314 565 282 552 244 C584 227 589 185 552 164 C562 129 544 93 503 95 C497 57 453 27 412 56 C388 29 340 24 310 61Z"/>
    <g className="brain-folds" fill="none"><path d="M310 61 C296 109 322 135 307 180 S321 245 310 352"/><path d="M118 95 Q157 103 165 137 T208 165 M68 164 Q112 150 126 190 T186 217 M68 244 Q119 227 139 269 T199 291 M208 56 Q203 93 240 103 T272 145 M116 313 Q155 290 191 320"/><path d="M503 95 Q464 103 455 137 T412 165 M552 164 Q508 150 494 190 T434 217 M552 244 Q501 227 481 269 T421 291 M412 56 Q417 93 380 103 T348 145 M504 313 Q465 290 429 320"/></g>
    <g>{graph.links.map(link => {
      const q = position(link);
      return <g key={link.id} className={'journey-edge visible journey-appear journey-edge-interactive' + (link.pending ? ' journey-edge-pending' : '')} tabIndex={0} role="button" aria-label={link.detail + ' ' + link.when} onMouseEnter={() => setInspect({ type: 'edge', link })} onMouseLeave={() => setInspect(null)} onFocus={() => setInspect({ type: 'edge', link })} onBlur={() => setInspect(null)}>
        <line x1={q.sx} y1={q.sy} x2={q.tx} y2={q.ty} markerEnd={link.pending ? 'url(#edge-tip-pending)' : 'url(#edge-tip)'}/>
        <line className="edge-hit" x1={q.sx} y1={q.sy} x2={q.tx} y2={q.ty}/>
        <text x={q.lx} y={q.ly} textAnchor="middle">{link.label}</text>
      </g>;
    })}</g>
    <g>{Object.entries(nodes).filter(([id]) => graph.active.has(id)).map(([id, node]) => <g key={id} className="journey-node visible journey-appear" transform={`translate(${node.x} ${node.y})`} tabIndex={0} role="button" aria-label={node.name + '，首次出现 ' + graph.about[id].when} onMouseEnter={() => setInspect({ type: 'node', id })} onMouseLeave={() => setInspect(null)} onFocus={() => setInspect({ type: 'node', id })} onBlur={() => setInspect(null)}><circle className={id === 'self' ? 'node-self' : ''} r={node.r}/><text textAnchor="middle" dominantBaseline="central" className="node-title">{id === 'mom' && graph.named ? '妈·王秀兰' : node.name}</text></g>)}</g>
    </svg>
    {inspect && <div className="journey-inspect" aria-live="polite">
      <strong>{inspect.type === 'edge' ? nodes[inspect.link.from].name + ' · ' + nodes[inspect.link.to].name : (inspect.id === 'mom' && graph.named ? '妈·王秀兰' : nodes[inspect.id].name)}</strong>
      <p>{inspect.type === 'edge' ? inspect.link.detail : graph.about[inspect.id].from}</p>
      <span>{inspect.type === 'edge' ? '时间：' + inspect.link.when : '首次出现：' + graph.about[inspect.id].when}</span>
      <span>{inspect.type === 'edge' ? '依据：' + inspect.link.evidence : '关系：' + graph.about[inspect.id].links + ' 条'}</span>
    </div>}
  </div>;
}

export default function LifeJourney() {
  const [integrated, setIntegrated] = useState([]);
  const [choice, setChoice] = useState(null);
  const graph = useMemo(() => build(integrated, choice), [integrated, choice]);

  const unlocked = material => material.requires.every(id => integrated.includes(id));
  const latest = graph.arrived[graph.arrived.length - 1];
  const remaining = materials.length - integrated.length;
  const named = graph.named;

  function connect(material) {
    if (!unlocked(material) || integrated.includes(material.id)) return;
    setIntegrated(current => [...current, material.id]);
  }
  function reset() { setIntegrated([]); setChoice(null); }

  return <section className="journey-demo" aria-label="时空上下文互动演示">
    <div className="journey-layout">
      <div className="journey-main">
        <div className="journey-graph-head">
          <div>
            <span>关系空间</span>
            <strong>{latest ? '最新接入 · ' + labelDate(latest.time) + ' · ' + latest.title : '还没有资料进入 · 从右侧第一份开始'}</strong>
          </div>
          <span className="journey-count">{graph.active.size} 个实体<i/> {graph.links.length} 条关系{graph.pending ? <><i/> {graph.pending} 处冲突</> : null}</span>
        </div>
        <div className="journey-stage"><Network graph={graph}/></div>
        {integrated.length > 0 && <div className="journey-notes">
          {integrated.includes('group') && !named && <div className="journey-note"><span>称呼</span><p>群里只有「妈」两个字。系统知道有这么一个人，但不知道她叫什么、住在哪。</p></div>}
          {named && <div className="journey-note"><span>对齐</span><p>转账备注写着「妈 生活费」，收款人是王秀兰，地址在老家——称呼落到了一个具体的人。</p></div>}
          {integrated.includes('photo') && <div className="journey-note"><span>同名</span><p>照片背面写明岳母张桂芳，我也喊她「妈」。两个「妈」不是同一个人，保留两个实体，不合并。</p></div>}
          {integrated.includes('photo') && <div className="journey-note"><span>旧材料</span><p>这张照片拍于 2023.05，今天才到。系统按拍摄时间把它放进 2023，而不是按到达顺序排最后。把鼠标停在「妻子」或「妈·张桂芳」上，能看到它们首次出现写的是 2023.05。</p></div>}
          {integrated.includes('hospital') && <div className="journey-note"><span>空间</span><p>岳母在城里的医院；老家的妈在等年夜饭。两个「家」，同一个星期。</p></div>}
          {integrated.includes('ticket') && <div className="journey-ask">
            <span className="journey-ask-tag">{choice ? '已排定' : '冲突'}</span>
            <p>除夕只有一天，两座城相距八百公里。回老家，还是留在城里陪护？</p>
            <div className="journey-ask-actions">
              <button type="button" className={choice === 'hometown' ? 'selected' : ''} onClick={() => setChoice(current => current === 'hometown' ? null : 'hometown')}>回老家</button>
              <button type="button" className={choice === 'city' ? 'selected' : ''} onClick={() => setChoice(current => current === 'city' ? null : 'city')}>留在城里</button>
            </div>
            {choice && <small>{choice === 'hometown' ? '除夕在老家 · 城里的陪护改到初一上午' : '除夕留在城里 · 老家的年改到初五'}</small>}
          </div>}
        </div>}
        <div className="journey-time">
          <div className="journey-time-head">
            <div className="journey-time-title"><span>已接入</span><strong>{integrated.length} / {materials.length} · {labelDate(start)} — {labelDate(end)}</strong></div>
            <button type="button" className="journey-reset" onClick={reset} aria-label="全部拆封重来"><RotateCcw size={15}/></button>
          </div>
          <div className="journey-progress">
            {materials.map(material => <span key={material.id} className={'journey-progress-dot' + (integrated.includes(material.id) ? ' on' : '')} style={{ left: `${(material.time - start) / (end - start) * 100}%` }} title={integrated.includes(material.id) ? material.title : '未拆封'}/>)}
          </div>
          <div className="journey-years"><span>{labelDate(start)}</span><span>{labelDate(end)}</span></div>
        </div>
      </div>
      <aside className="journey-records">
        <div className="journey-records-head">
          <div><strong>手边的资料</strong><span>接入一份，拆封下一份</span></div>
          <small>{integrated.length} / {materials.length}</small>
        </div>
        <div className="journey-record-list">
          {materials.map(material => {
            const done = integrated.includes(material.id);
            const ready = unlocked(material);
            if (!done && !ready) {
              return <div key={material.id} className="journey-record sealed" aria-disabled="true">
                <span className="journey-check" aria-hidden="true">·</span>
                <span className="journey-record-content">
                  <span className="journey-record-date">未拆封 · 资料 {String(material.order + 1).padStart(2, '0')}</span>
                  <span className="journey-record-quote">接入上一份后解锁</span>
                </span>
              </div>;
            }
            return <div key={material.id} role="button" tabIndex={0} className={'journey-record ' + (done ? 'checked' : 'available') + (latest && latest.id === material.id ? ' current' : '')} onClick={() => connect(material)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); connect(material); } }}>
              <span className="journey-check" aria-hidden="true">{done ? '✓' : '+'}</span>
              <span className="journey-record-content">
                <span className="journey-record-date"><em>来源</em>{material.source}<i/>{labelDate(material.time)}</span>
                <strong>{material.title}</strong>
                <span className="journey-record-quote">「{material.quote}」</span>
                {done
                  ? <span className="journey-record-body">{material.delta}</span>
                  : <span className="material-cta">接入这份资料</span>}
              </span>
            </div>;
          })}
        </div>
      </aside>
    </div>
    {choice && <div className="journey-verdict">
      <div>
        <h3>两个「妈」，两座城，一个除夕</h3>
        <p>五份材料来自五个日常来源：微信家庭群、手机银行、相册、医院挂号、出行 App。可「妈」这个字在这里指向两个人——一个在老家等年夜饭，一个在城里住院。只读文本，这是矛盾；到了实体和关系里，它是两个妈妈、两座城、同一个除夕。</p>
      </div>
    </div>}
  </section>;
}
