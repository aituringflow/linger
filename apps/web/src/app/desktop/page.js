import Link from "next/link";
import SiteHeader from "../../components/site-header";
import SiteFooter from "../../components/site-footer";
import styles from "./desktop.module.css";
import { imageUrl, videoUrl } from "../../lib/media";

export const metadata = {
  title: "桌面 · 把要做的事摆在桌面上",
  description: "灵儿这个桌面个人智能体把正在跑的任务、要翻的文件和每天用的入口摆到桌面上，位置和大小自己定，做完再收起。",
  alternates: { canonical: "/linger/desktop" },
};

const DOWNLOAD_HREF = "/download?appId=launcher";

const PARTS = [
  {
    index: "01",
    title: "进行中",
    desc: "正在处理的任务以卡片停在桌面上，进度一眼看到；点开卡片就是那段对话，不在应用之间来回找。",
  },
  {
    index: "02",
    title: "会话组",
    desc: "同一件事的多个会话收进一个组，组名自己起；整组一起挪位置，翻的时候不用一个个点开。",
  },
  {
    index: "03",
    title: "文件管理",
    desc: "桌面上直接开一个文件窗口，根目录就是你的 home；图标、分栏、列表三种视图，进一层才加载一层。",
  },
  {
    index: "04",
    title: "拖一下就交给它",
    desc: "从文件窗口把文件拖到会话卡片上，松手就把文件发进那个任务；想先补两句话，就在卡片上停一会儿再松手，文件先进输入框。",
  },
  {
    index: "05",
    title: "Dock",
    desc: "问、知识库、文件、浏览器、邮件、设置常驻底部；常用的东西一下就到，不用先找图标。",
  },
  {
    index: "06",
    title: "状态栏",
    desc: "时间日期、电量、Wi-Fi 自绘在右上角；读不到的项目直接不显示，不画假数据。",
  },
];

export default function DesktopPage() {
  return (
    <div className={styles.page}>
      <SiteHeader active="desktop" />
      <main>
        <section className={styles.hero}>
          {/* 首屏标题从 <p> 改成 <h1>：原来整页没有一级标题，抓取器只能拿导航文字当主题 */}
          <h1 className={styles.title}>桌面，先替你摆好。</h1>
          <p className={styles.lede}>
            正在跑的任务、常翻的文件、每天用的入口，都能摆在桌面上。位置和大小自己定，做完再收起——桌面不只是壁纸。
          </p>
          <div className={styles.heroMedia}>
            <video
              src={videoUrl("launcher-desktop.mp4")}
              poster={imageUrl("desktop-real.png")}
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              aria-label="真实桌面界面展示：会话组、演示报销单和会话窗口"
            />
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>桌面上能放什么。</h2>
            <p className={styles.sectionLede}>
              两类组件，加上底部的入口和右上角的状态栏，够你把当天的事摊开在眼前。
            </p>
          </div>
          <div className={styles.cards}>
            {PARTS.map(item => (
              <article className={styles.card} key={item.index}>
                <div className={styles.cardTop}>
                  <span>{item.index}</span>
                  <i aria-hidden="true" />
                </div>
                <h3>{item.title}</h3>
                <p>{item.desc}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section} id="multi-window">
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>一个桌面，多个窗口，各自选择算力。</h2>
            <p className={styles.sectionLede}>
              在系统设置的「算力」中管理可用框架和自定义模型。需要并行处理不同的事时，打开多个聊天窗口；每个窗口都可以选择自己的框架和模型，按任务需要切换。
            </p>
          </div>
          <div className={styles.heroMedia}>
            <video src={videoUrl("launcher-multi-window.mp4")} aria-label="真实界面展示：算力设置中的框架和自定义模型，以及两个使用不同框架和模型的聊天窗口" autoPlay muted loop playsInline controls preload="metadata" />
          </div>
        </section>

        <section className={styles.closing}>
          <h2>桌面先摆好，剩下的交给它。</h2>
          <Link href={DOWNLOAD_HREF} className={styles.cta}>
            立即下载
          </Link>
          <p className={styles.fineprint}>当前提供 macOS 与 Windows 桌面客户端</p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
