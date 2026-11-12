import Link from "next/link";
import styles from "./knowledge.module.css";
import SiteHeader from "../../components/site-header";
import { imageUrl, videoUrl } from "../../lib/media";

// basePath 由 Next 自动加，这里不写 /linger 前缀
const DOWNLOAD_HREF = "/download?appId=launcher";
const INSIGHT_HREF = "/insight";

export const metadata = {
  title: "知识库 · 说一句话，找回你的照片和片段",
  description:
    "不用整理文件夹，不用改文件名。照片按你说的画面找回，视频直接定位到那几秒，声音也能当线索。全部在你的电脑上完成。",
};

const KINDS = [
  {
    tag: "照片",
    title: "照片",
    body: "它知道照片里有什么，也知道这张是几点拍的、在哪拍的、用什么拍的。你说画面，它就认画面。",
  },
  {
    tag: "视频",
    title: "视频",
    body: "整段片子只是一条记录，找到也没用。它把画面按几秒一段切开，你要的是哪几秒，直接告诉你。",
  },
  {
    tag: "声音",
    title: "声音",
    body: "监控没有旁白，也有人半夜按门铃。用一句声音的描述，就能翻出对应的那一段画面。",
  },
  {
    tag: "文件",
    title: "文件",
    body: "合同、账单、聊天记录导出、PDF，一起进来。找东西的时候，不用先想它当时存在哪儿。",
  },
];

const IMAGE_STEPS = [
  ["收进来", "照片进来自动读它自带的信息：什么时候拍的、在哪拍的、用什么设备。没有记录的就不编，宁可留空。"],
  ["看懂它", "给每张照片写一句人话，说清画面里有什么；照片上的文字也认出来，顺手纠错。"],
  ["记下来", "以后你聊起这张照片，它接得上。不用你提前打标签、建文件夹、改文件名。"],
];

const IMAGE_HITS = [
  ["2024.12.30 · 三亚 · 傍晚", "海滩边一只橘猫蹲在冲浪板旁边，背景是傍晚的海面，远处有人在散步。"],
  ["2024.12.31 · 三亚 · 酒店露台", "橘猫趴在躺椅上晒太阳，桌上有半杯椰子水。"],
  ["2024.11.20 · 家里 · 客厅", "橘猫缩在毯子里，旁边是刚拆开的快递箱。"],
];

const VIDEO_HITS = [
  ["23:14:05 – 23:14:15", "有人在单元门口来回走动，停住看了两次门牌，随后离开。", "最像你说的情况"],
  ["23:26:40 – 23:26:50", "一个人在门口停下，掏手机照亮门禁，没有进去，两分钟后离开。", "同一晚，更晚一点"],
  ["22:58:15 – 22:58:25", "外卖员放下一袋东西，拍了张照后骑车离开。", "同一晚，更早一点"],
];

const WHY = [
  ["换个说法也懂", "你不记得当时怎么说的，只记得那个意思。说「那只胖橘」，它照样能把照片翻出来。"],
  ["一字不差也认", "单号、门牌、人名这种不能错的词，它按字面精确找，不靠猜。"],
  ["两种结果合起来", "意思像的和字面准的一起排，谁的把握大谁靠前，你不用挑搜索方式。"],
];

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function Timeline() {
  const windows = Array.from({ length: 12 }, (_, i) => i);
  const hit = [1, 4];
  return (
    <svg className={styles.timeline} viewBox="0 0 1000 132" role="img" aria-label="视频按 5 秒切窗，命中第 2、第 5 个窗口">
      {windows.map(i => (
        <g key={i}>
          <rect
            x={8 + i * 82}
            y={44}
            width={74}
            height={30}
            fill={hit.includes(i) ? "#a4672a" : "#fafaf7"}
            stroke={hit.includes(i) ? "#a4672a" : "#e4e4dd"}
          />
          <text x={8 + i * 82 + 37} y={64} textAnchor="middle" className={hit.includes(i) ? styles.tlHit : styles.tlCell}>
            {i * 5}s
          </text>
        </g>
      ))}
      <line x1="8" y1="96" x2="992" y2="96" stroke="#dcdcd4" />
      {hit.map(i => (
        <g key={`m-${i}`}>
          <line x1={8 + i * 82 + 37} y1="96" x2={8 + i * 82 + 37} y2="112" stroke="#a4672a" />
          <text x={8 + i * 82 + 37} y={126} textAnchor="middle" className={styles.tlMark}>
            {i === 1 ? "23:14:05" : "23:26:40"}
          </text>
        </g>
      ))}
      <text x="8" y="26" className={styles.tlLabel}>60 秒素材 · 切成 12 段 · 逐段看画面</text>
    </svg>
  );
}

export default function KnowledgePage() {
  return (
    <div className={styles.page}>
      <SiteHeader active="knowledge" />

      <main>
        <section className={styles.hero}>
          <h1 className={styles.title}>说一句话，找回照片和那几秒。</h1>
          <p className={styles.lede}>
            不用建文件夹，不用给照片改名，不用拖时间轴一格一格地看。
            你记得的那个画面，说一句，它就到。
          </p>
          <dl className={styles.stats}>
            <div><dt>一句话</dt><dd>不用关键词，说人话就行</dd></div>
            <div><dt>到秒</dt><dd>视频直接跳到那几秒</dd></div>
            <div><dt>不上传</dt><dd>照片和视频留在本机</dd></div>
          </dl>
          <div className={styles.heroMedia}>
            <video
              src={videoUrl("knowledge-image.mp4")}
              poster={imageUrl("knowledge-image.png")}
              aria-label="知识库演示：照片入库后，一句话找回山顶日出的照片"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
            />
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>你记得的是画面，不是文件名。</h2>
            <p>相册按日期分堆，视频按条堆放，可真要找回某一个画面，你还是得从头翻。</p>
          </div>
          <div className={styles.cards}>
            {KINDS.map(item => (
              <article key={item.title} className={styles.card}>
                <span className={styles.cardTag}>{item.tag}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>照片：你说画面，它认画面。</h2>
            <p>收进来的时候多懂一点，找回的时候少想一次文件名。</p>
          </div>
          <ol className={styles.steps}>
            {IMAGE_STEPS.map(([title, body], i) => (
              <li key={title}>
                <span className={styles.stepNo}>{String(i + 1).padStart(2, "0")}</span>
                <strong>{title}</strong>
                <p>{body}</p>
              </li>
            ))}
          </ol>

          <figure className={styles.queryCard}>
            <figcaption>
              <span className={styles.queryLabel}>你说</span>
              <q>去年冬天在海边拍的那只橘猫，还在吗？</q>
            </figcaption>
            <ul className={styles.hits}>
              {IMAGE_HITS.map(([meta, text], i) => (
                <li key={meta}>
                  <span className={styles.thumb} aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <p className={styles.hitText}>{text}</p>
                    <p className={styles.hitMeta}>{meta}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className={styles.footNote}>
              没被描述过的照片也能找，它看的是画面本身；换个说法也能找，它记的是意思，不是词。
            </p>
          </figure>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>视频：给你那几秒，不是那一条。</h2>
            <p>
              一整段监控丢给你，等于什么都没给。它把画面按几秒一段切开逐段看，所以能直接说清第几分第几秒。
            </p>
          </div>

          <div className={styles.heroMedia}>
            <video
              src={videoUrl("knowledge-video.mp4")}
              aria-label="视频召回演示：用画面描述找到人们走过斑马线的片段并预览"
              autoPlay
              muted
              loop
              playsInline
              controls
              preload="metadata"
            />
          </div>
          <p className={styles.footNote}>演示素材来自视频知识库，检索结果与操作流程为示意。</p>

          <figure className={styles.videoCard}>
            <figcaption>
              <span className={styles.queryLabel}>你说</span>
              <q>昨晚十一点以后，有人在门口来回走动。</q>
            </figcaption>
            <Timeline />
            <ul className={styles.videoHits}>
              {VIDEO_HITS.map(([range, text, note], i) => (
                <li key={range} className={i === 0 ? styles.videoHitMain : undefined}>
                  <span className={styles.range}>{range}</span>
                  <div>
                    <p className={styles.hitText}>{text}</p>
                    <p className={styles.hitMeta}>{note}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className={styles.footNote}>
              点进去就看那几秒，不用从头拉一遍。监控没有旁白也能用声音当线索——「半夜有人按门铃」这句话，它照样翻得出片段。
            </p>
          </figure>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>找得准，不只是记关键词。</h2>
            <p>你不记得原话，它按意思找；你记得确切的号，它按字面找。两种一起给。</p>
          </div>
          <div className={styles.routes}>
            {WHY.map(([title, body], i) => (
              <article key={title} className={styles.route}>
                <span className={styles.routeTag}>0{i + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <p className={styles.routeNote}>
            还能自己收窄：只找照片、只找视频、只找声音。找图不会混进一堆文档，找画面不会混进一段闲聊。
          </p>
        </section>

        <section className={styles.closing}>
          <h2>你的照片和片子，不用上传也能找。</h2>
          <div className={styles.actions}>
            <Link href={DOWNLOAD_HREF} className={styles.primary}>
              立即下载
              <DownloadIcon />
            </Link>
            <Link href={INSIGHT_HREF} className={styles.secondary}>
              看时空上下文
              <ArrowIcon />
            </Link>
          </div>
          <p className={styles.fineprint}>照片、视频、声音都在你自己的电脑上处理，断网也能用</p>
        </section>
      </main>

      <footer className={styles.footer}>
        <p>© 2026 图灵环流</p>
      </footer>
    </div>
  );
}
