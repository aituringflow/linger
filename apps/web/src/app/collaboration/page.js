import Link from "next/link";
import SiteHeader from "../../components/site-header";
import SiteFooter from "../../components/site-footer";
import styles from "./collaboration.module.css";

export const metadata = {
  title: "协同 · 人与 AI，一起把事情推进",
  description: "和灵儿在群聊中协作，或通过伴聊私下商量。",
};

export default function CollaborationPage() {
  return <div className={styles.page}><SiteHeader active="collaboration"/><main>
    <section className={styles.section}>
      <div className={styles.heading}>
        <p className={styles.kicker}>人与 AI 的协同</p>
        <h1>从群聊讨论，到一起交付。</h1>
        <p>团队提出问题，灵儿做出初稿，接着根据反馈更新。</p>
      </div>
      <img className={styles.productVisual} src="/linger/intro/collaboration.gif" alt="群聊中与灵儿协作并迭代产物的演示" />
    </section>
    <section className={styles.section}>
      <div className={styles.heading}>
        <p className={styles.kicker}>私密伴聊</p>
        <h2>遇到难题，先和伴聊商量。</h2>
        <p>梳理群里分散的信息，分析取舍，帮你给出有依据的回复。</p>
      </div>
      <img className={styles.productVisual} src="/linger/intro/chatmate.png" alt="灵儿伴聊界面" loading="lazy" />
    </section>
    <section className={styles.closing}><h2>和灵儿一起，把事情推进。</h2><Link href="/download?appId=launcher">立即下载 <span>↗</span></Link></section>
  </main><SiteFooter /></div>;
}
