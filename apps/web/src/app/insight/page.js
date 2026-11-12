import SiteHeader from "../../components/site-header";
import TokenSpace from './token-space';
import LifeJourney from './life-journey';
import StorageModel from './storage-model';
import ConsumerModel from './consumer-model';
import './datainsight.css';
import './journey.css';
import './storage.css';
import './page-tweaks.css';
import './consumer.css';

const domains = [
  { number: '01', title: '实体', english: '实体', desc: '识别信息中反复出现的人、组织、项目与事物，让不同来源的同一对象逐渐显现。', tags: ['人', '组织', '项目', '事物'] },
  { number: '02', title: '关系', english: '关系', desc: '以证据连接实体、事件与事实，保留关系发生的时间和语境，呈现事物之间的联系。', tags: ['关联', '角色', '证据', '有效时间'] },
];

function Mark() { return <span className="brand-symbol" aria-hidden="true"><i/><i/><i/><i/></span>; }
function ProblemVisual() { return <div className="problem-visual" aria-label="分散的数据与大模型之间缺少上下文"><div className="problem-visual-grid"/><div className="problem-sources"><div><img src="/linger/icons/wechat.png" alt="" width={34} height={34}/><span>微信</span></div><div><img src="/linger/icons/feishu.png" alt="" width={34} height={34}/><span>飞书</span></div><div><img src="/linger/icons/dingtalk_rounded.png" alt="" width={34} height={34}/><span>钉钉</span></div><div><span className="source-file" aria-hidden="true">文</span><span>文档</span></div></div><div className="problem-lines" aria-hidden="true"><span/><span/><span/><span/></div><div className="problem-gap"><span>上下文</span><strong>?</strong></div><div className="problem-model"><span>智能</span><strong>大模型</strong><small>推理与理解</small></div><div className="problem-visual-foot"><span>分散的数据</span><span>缺失的上下文</span><span>未被充分释放的能力</span></div></div> }
/* 首屏门禁：样式/字体/三维就绪前只显示纸底载入态，避免露出未排版的原始样式 */
const BOOT_CSS = `
#boot-veil{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;gap:10px;background:#f5f5f2;color:#6f6f67;font:500 13px/1 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;letter-spacing:.08em;transition:opacity .3s ease}
.boot-veil-dot{width:6px;height:6px;border-radius:50%;background:#2f6b5e;animation:bootVeilPulse 1.1s ease-in-out infinite}
@keyframes bootVeilPulse{0%,100%{opacity:.22;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion: reduce){.boot-veil-dot{animation:none}}
html:not([data-insight-ready]) main.ds-scope{visibility:hidden}
html:not([data-insight-ready]) body>header{visibility:hidden}
html[data-insight-ready] #boot-veil{opacity:0;pointer-events:none;visibility:hidden}
`;

// 载入门禁：不等 React hydration，解析期就检查「样式是否已生效」，就绪后揭开纸底遮罩。
// 这样既不会露出未排版的默认样式，也不会为了等 JS 白白多挡一两秒。
const BOOT_SCRIPT = `(function(){var d=document,done=false;function reveal(){if(done)return;done=true;d.documentElement.setAttribute('data-insight-ready','true');setTimeout(function(){var v=d.getElementById('boot-veil');if(v&&v.parentNode)v.parentNode.removeChild(v);},420);}function styled(){var h=d.querySelector('main h1');return !!h&&getComputedStyle(h).fontSize!=='32px';}var tries=0;function tick(){tries++;if(styled()){requestAnimationFrame(function(){requestAnimationFrame(reveal);});return;}if(tries>55){reveal();return;}setTimeout(tick,60);}setTimeout(tick,60);})();`;

export const metadata = {
  title: "DataInsight · 智能体时代的数据底座",
  description: "一种基于时空的统一数据组织方法，让分散的信息成为可理解、可追溯、可行动的知识。",
};

export default function Home() { return <>
  <style dangerouslySetInnerHTML={{ __html: BOOT_CSS }} />
  <SiteHeader active="context"/><main id="top" className="ds-scope">
  <section className="hero shell"><div className="hero-copy"><p className="hero-kicker">智能体时代的数据底座</p><h1>时空上下文</h1><p className="hero-description">一种基于时空的统一数据组织方法</p></div></section>
  <section className="section shell perspective" id="perspective"><div className="section-intro"><div className="intro-copy"><h2>当前痛点：大模型很聪明，却看不见完整的世界</h2><p>大模型具备强大的理解与推理能力，但真正与我们相关的数据，散落在对话、邮件、文档和业务系统中。缺少准确、全面的上下文，再强的智能也难以作出贴近现实的判断。</p><p>当信息无法相互连接，智能体便难以理解事情的来龙去脉，更无法充分发挥它的潜力。</p></div></div><ProblemVisual/><div className="figure-caption"><span>数据 · 智能</span><span>从分散的信息，到可被理解的上下文</span></div></section>
  <section className="intelligence-section" id="intelligence"><div className="shell"><div className="intelligence-heading"><div className="intelligence-intro"><h2>大模型的智力，<br/><em>从空间中的关系开始。</em></h2><p>在模型内部，语言首先被转化为向量。随着上下文经过一层层计算，向量表征不断变化，模型由此形成对当前语境的判断，并预测下一个词元。</p></div></div>
    <TokenSpace/>
    <div className="private-bridge"><p>借鉴大模型的空间化表达，我们提出时空上下文组织方式，为智能体构建有上下文的数据底座。</p></div></div></section>
  <section className="model-section" id="model"><div className="shell"><div className="model-heading"><h2>时空上下文 = 时间 + 空间（实体和关系）</h2></div>
   <LifeJourney/>
   <StorageModel/>
    <ConsumerModel/></div></section>
  
  
  
  <section className="closing"><div className="shell closing-inner"><div><h2>你的 Agent，需要你的时空上下文。</h2><p>大模型有的是通用智力，缺的是属于你的时间、空间和关系。</p></div></div></section><footer className="footer shell"><p>© 2026 图灵环流</p></footer>
 </main>
  <div id="boot-veil" aria-hidden="true"><span className="boot-veil-dot"/><span>灵儿 · 载入中</span></div>
  <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
  <noscript><style>{`html:not([data-insight-ready]) main.ds-scope{visibility:visible}html:not([data-insight-ready]) body>header{visibility:visible}#boot-veil{display:none}`}</style></noscript>
</> }
