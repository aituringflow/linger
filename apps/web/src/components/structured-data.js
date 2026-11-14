// 结构化数据（JSON-LD）。目的不是「堆字段」，而是把三个实体明确告诉搜索引擎：
//   Organization = 图灵环流 TuringFlow（出品方，含 GitHub sameAs）
//   WebSite      = 灵儿 Linger 官网（站点名 + 中英文别名，利于品牌词归一）
//   SoftwareApplication = 灵儿这个桌面个人智能体（类别、平台、开源、免费）
// 只有实体互相引用（@id），Google 才会把「灵儿 / Linger / 图灵环流 / 个人智能体」认成同一组关系，
// 否则这些词在页面上同时出现也只是散落的文本。
import {
  GITHUB_URL,
  ORG_NAME,
  SEO_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
  absoluteUrl,
} from "../lib/seo";

const ORG_ID = `${SITE_URL}/linger#organization`;
const SITE_ID = `${SITE_URL}/linger#website`;
const APP_ID = `${SITE_URL}/linger#software`;

const ORGANIZATION = {
  "@type": "Organization",
  "@id": ORG_ID,
  name: ORG_NAME,
  alternateName: ["TuringFlow", "图灵环流", "aituringflow"],
  url: `${SITE_URL}/linger`,
  logo: {
    "@type": "ImageObject",
    url: `${SITE_URL}/linger/icons/linger-mark-512.png`,
    width: 512,
    height: 512,
  },
  sameAs: [GITHUB_URL],
};

const WEBSITE = {
  "@type": "WebSite",
  "@id": SITE_ID,
  url: `${SITE_URL}/linger`,
  name: SITE_NAME,
  alternateName: ["灵儿", "Linger", "灵儿 Linger 桌面智能体"],
  inLanguage: "zh-CN",
  description: SEO_DESCRIPTION,
  publisher: { "@id": ORG_ID },
};

const APPLICATION = {
  "@type": "SoftwareApplication",
  "@id": APP_ID,
  name: "灵儿 Linger",
  alternateName: ["灵儿", "Linger", "图灵环流灵儿", "TuringFlow Linger"],
  applicationCategory: "ProductivityApplication",
  applicationSubCategory: "Personal AI Agent / 桌面个人智能体",
  operatingSystem: "macOS 13+, Windows 10, Windows 11",
  url: `${SITE_URL}/linger`,
  downloadUrl: `${SITE_URL}/linger/download`,
  description: SEO_DESCRIPTION,
  image: `${SITE_URL}/linger/icons/og-linger.png`,
  screenshot: `${SITE_URL}/linger/icons/og-linger.png`,
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "CNY", availability: "https://schema.org/InStock" },
  publisher: { "@id": ORG_ID },
  featureList: [
    "把微信、订单、账单、文件里的信息汇聚到一处",
    "一句话交代任务，自动执行并跟进",
    "本地知识库：照片、视频、声音用自然语言检索",
    "开源，数据默认留在本机",
  ],
  inLanguage: "zh-CN",
};

function JsonLd({ data }) {
  // 用 dangerouslySetInnerHTML 塞 JSON：不能用 {JSON.stringify(...)} 作为子节点，
  // React 会把引号转义成实体，抓取器读到的就不是合法 JSON 了。
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

/** 全站注入：出品方 + 站点实体 */
export default function SiteStructuredData() {
  return <JsonLd data={{ "@context": "https://schema.org", "@graph": [ORGANIZATION, WEBSITE] }} />;
}

/** 首页/下载页注入：产品实体（SoftwareApplication） */
export function SoftwareAppStructuredData() {
  return <JsonLd data={{ "@context": "https://schema.org", "@graph": [APPLICATION] }} />;
}

/** 面包屑：子页用它告诉搜索器层级，别再让 /desktop 变成一个孤立节点 */
export function BreadcrumbStructuredData({ items }) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.name,
          item: absoluteUrl(item.path),
        })),
      }}
    />
  );
}
