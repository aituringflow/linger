import Link from "next/link";
import SiteHeader from "../../components/site-header";
import styles from "./collaboration.module.css";

export const metadata = {
  title: "协同 · 人与 AI，一起把事情推进",
  description: "让 AI 参与群聊，理解讨论上下文、回应问题，并为每个人提供私密的回复建议。",
};

function Conversation() {
  return <div className={styles.conversation} aria-label="群聊协同示意">
    <div className={styles.windowBar}><span className={styles.dots}>● ● ●</span><span>项目讨论</span><span className={styles.live}>协同中</span></div>
    <div className={styles.messages}>
      <div className={styles.message}><span className={styles.avatar}>林</span><div><small>林 · 产品</small><p>上线时间定在下周五，大家看看还有什么需要确认的？</p></div></div>
      <div className={styles.message}><span className={`${styles.avatar} ${styles.blue}`}>周</span><div><small>周 · 开发</small><p>接口这周可以完成，不过数据迁移需要再预留一天。</p></div></div>
      <div className={`${styles.message} ${styles.aiMessage}`}><span className={`${styles.avatar} ${styles.aiAvatar}`}>✳</span><div><small>灵儿 · 群 AI</small><p>目前上线时间与数据迁移的安排可能有冲突。要不要先确认迁移窗口，再定最终发布时间？</p></div></div>
      <div className={styles.compose}>输入消息，或 @灵儿 提问 <span>↗</span></div>
    </div>
    <div className={styles.demoLabel}>情景示意 · 对话内容为示例</div>
  </div>;
}

export default function CollaborationPage() {
  return <div className={styles.page}><SiteHeader active="collaboration"/><main>
    <section className={styles.hero}>
      <div className={styles.heroCopy}><p className={styles.eyebrow}><span/> 人与 AI 的协同</p><h1>一起讨论，<br/><em>一起推进。</em></h1><p className={styles.lede}>让灵儿加入团队的讨论。它听懂上下文，在需要时回应、提醒遗漏；你也可以随时找它商量，再决定怎么说。</p><a className={styles.heroLink} href="#how">看看如何协同 <span>↓</span></a></div>
      <Conversation />
    </section>
    <div className={styles.strip}><span>多人参与</span><i/><span>共享讨论上下文</span><i/><span>AI 适时参与</span><i/><span>个人建议私密可见</span></div>
    <section id="how" className={styles.section}>
      <div className={styles.sectionHeading}><p className={styles.kicker}>01 / 在同一场讨论里</p><h2>不用从头解释，<br/>它跟得上讨论。</h2><p>人和 AI 在同一个群里交流。灵儿结合当前讨论理解问题：被提及时回答，也能在发现关键遗漏或分歧时，适时给出提醒。</p></div>
      <div className={styles.featureGrid}><article><span>01</span><h3>带着上下文回答</h3><p>问题、消息和讨论中的附件放在一起理解，少一点重复交代，多一点直接推进。</p></article><article><span>02</span><h3>需要时才开口</h3><p>点名提问时回应；发现讨论的前提不同或关键条件尚未明确时，给出简短提醒。</p></article><article><span>03</span><h3>围绕事情继续聊</h3><p>把需要确认的问题留在讨论中，参与的人可以接着补充、判断和决定。</p></article></div>
    </section>
    <section className={`${styles.section} ${styles.privateSection}`}>
      <div className={styles.privateVisual}><div className={styles.privateTop}><span>✳</span><div><strong>伴聊</strong><small>只对你可见</small></div><b>私密</b></div><p className={styles.privatePrompt}>我该怎么回应这个时间安排？</p><div className={styles.privateReply}><small>灵儿的建议</small><p>可以先确认数据迁移需要的时间，再和大家一起调整上线计划。</p><span>采纳建议 ↗</span></div><p className={styles.privateCaption}>示意内容 · 采纳后仍由你决定是否发送</p></div>
      <div className={styles.privateCopy}><p className={styles.kicker}>02 / 你的私密参谋</p><h2>先和灵儿商量，<br/>再加入讨论。</h2><p>打开伴聊后，灵儿可以从你的视角理解群里的新消息，给你私密的回复建议。建议只对你可见，采纳后填入输入框，发不发送由你决定。</p><div className={styles.note}><span>◌</span><div><strong>主动开启，随时关闭</strong><p>伴聊由每个人自行选择，不会因为打开面板而自动开启。</p></div></div></div>
    </section>
    <section className={styles.closing}><p className={styles.kicker}>一起工作，保持自己的判断</p><h2>让好的讨论，<br/>更容易走到下一步。</h2><p>把问题带进来，和团队、和灵儿一起想清楚。</p><Link href="/download?appId=launcher">立即下载 <span>↗</span></Link></section>
  </main><footer className={styles.footer}>© 2026 图灵环流</footer></div>;
}
