import Link from "next/link";
import styles from "./intro.module.css";
import SiteHeader from "../components/site-header";
import SiteFooter from "../components/site-footer";
import { imageUrl, videoUrl } from "../lib/media";

// 下载页要求带 ?appId= 定向通道；intro 重点介绍 launcher，所以直接落到 launcher 通道。
// 注意：web 配了 basePath=/linger，Link 会自动拼上前缀，这里不能再写 /linger。
const DOWNLOAD_HREF = "/download?appId=launcher";
const INSIGHT_HREF = "/insight";

export const metadata = {
  title: "灵儿 · 你的数字分身",
  description:
    "灵儿是你的桌面数字分身：替你汇聚散落在各个应用里的信息，替你办事，替你把关。",
};

const CAPABILITIES = [
  {
    index: "01",
    title: "替你汇聚",
    desc: "微信聊天、美团订单、银行账单、基金股票、快递物流与本地文件，散落在各个应用里的信息被收拢到同一个入口，一次理清。",
  },
  {
    index: "02",
    title: "替你办事",
    desc: "查账单、比优惠、订座、设提醒，一句话办完；布置任务、跟进进度、会议纪要与周报，也可以一并打理。",
  },
  {
    index: "03",
    title: "替你把关",
    desc: "能自动处理的直接处理：屏蔽微信广告、骚扰短信与工作群刷屏；投资行情、任务进度出现重要变化时，才来问你。",
  },
];

function ArrowRightIcon({ className }) {
  return (
    <svg
      className={className}
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function DownloadIcon({ className }) {
  return (
    <svg
      className={className}
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

export default function IntroPage() {
  return (
    <main className={styles.page}>
      <SiteHeader active="home" />

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <h1 className={styles.title}>灵儿：你的数字分身</h1>
          <p className={styles.lede}>
            灵儿是你的桌面分身：散落在各个应用里的消息、订单、账单和文件，它替你收拢、跟进，能自动完成的直接做完。操作方式也不同——没有层层菜单，也不用记快捷键：你说一句要做什么，它直接接手，只在需要你拍板时才开口问。
          </p>
          <div className={styles.actions}>
            <Link href={DOWNLOAD_HREF} className={styles.primary}>
              立即下载
              <DownloadIcon className={styles.actionIcon} />
            </Link>
          </div>
        </div>
        <div className={styles.heroMedia}>
          <video
            src={videoUrl("launcher-home.mp4")}
            poster={imageUrl("launcher-home.png")}
            aria-label="AgentOS Launcher：悬停打开输入框，点击展开聊天窗口"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
          />
        </div>
      </section>

      <section className={styles.section} id="voice">
        <div className={styles.sectionHead}>
          <div className={styles.sectionHeadMain}>
            <h2 className={styles.h2}>开口说一句，它就接住。</h2>
            <p className={styles.sectionLede}>
              不想打字时，直接对麦克风说话。灵儿识别你的意图，结合当前数域和上下文给出回应，任务照样一句话交代清楚；说完即走，等待和跟进交给它。
            </p>
          </div>
        </div>
        <div className={styles.sectionMedia}>
          <video
            src={videoUrl("launcher-voice.mp4")}
            aria-label="灵儿语音交互演示：说出需求并交由灵儿处理"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
          />
        </div>
      </section>

      <section className={styles.section} id="skins">
        <div className={styles.sectionHead}>
          <div className={styles.sectionHeadMain}>
            <h2 className={styles.h2}>换一套主题，换一整个桌面。</h2>
            <p className={styles.sectionLede}>
              从沉静的静态壁纸，到会流动的动态场景，多套主题连着输入框、Dock 与窗口一起换装；火焰、水波与流光的强弱随手可调，也能换成自己的图片。
            </p>
          </div>
        </div>
        <div className={styles.sectionMedia}>
          <video
            src={videoUrl("launcher-skins.mp4")}
            aria-label="主题皮肤演示：切换不同界面配色与皮肤"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
          />
        </div>
      </section>

      <section className={styles.section} id="capabilities">
        <div className={styles.sectionHead}>
          <div className={styles.sectionHeadMain}>
            <h2 className={styles.h2}>
              替你汇聚，替你办事，替你把关。
            </h2>
            <p className={styles.sectionLede}>
              它先替你收拾散落的线索，再动手把事做完，最后替你挡住噪音。你只需要在关键处点头。
            </p>
          </div>
        </div>

        <div className={styles.cards}>
          {CAPABILITIES.map((item) => (
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

        <div className={styles.example}>
          <p className={styles.exampleLabel}>举个例子</p>
          <p className={styles.exampleAsk}>
            你说：「微信里我们约了周五晚聚餐，帮我订个适合六人的餐厅。」
          </p>
          <div className={styles.exampleFlow}>
            <div>
              <span>01</span>
              <strong>去微信确认</strong>
              <em>人数、时间、谁在场</em>
            </div>
            <ArrowRightIcon className={styles.flowArrow} />
            <div>
              <span>02</span>
              <strong>在美团筛选</strong>
              <em>六人位、可订、距离合适</em>
            </div>
            <ArrowRightIcon className={styles.flowArrow} />
            <div>
              <span>03</span>
              <strong>订座并回报</strong>
              <em>确认信息发回给你</em>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.closing}>
        <h2 className={styles.closingTitle}>把第一个任务，交给它。</h2>
        <div className={styles.actions}>
          <Link href={DOWNLOAD_HREF} className={styles.primary}>
            立即下载
            <DownloadIcon className={styles.actionIcon} />
          </Link>
          <Link href={INSIGHT_HREF} className={styles.secondary}>
            了解更多
            <ArrowRightIcon className={styles.actionIcon} />
          </Link>
        </div>
        <p className={styles.fineprint}>当前提供 macOS 与 Windows 桌面客户端</p>
      </section>

      <SiteFooter />
    </main>
  );
}
