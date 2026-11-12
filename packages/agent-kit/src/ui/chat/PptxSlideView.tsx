import { type CSSProperties, type ReactNode } from "react";
import type JSZip from "jszip";

// ─────────────────────────────────────────────────────────────────────────────
// PPTX 幻灯片内嵌预览：不依赖任何在线/本地转换器，JSZip 解包 + DOMParser 解析，
// 按 PPT 的 EMU 坐标系把每一页渲染成真实的幻灯片页面（文本、图片、底色、边框、
// 分组、表格、备注），而不是纯文字列表。
//   - 幻灯片尺寸取 ppt/presentation.xml 的 p:sldSz（默认 12192000×6858000 = 16:9）
//   - 页面元素以占位百分比绝对定位，字号用 cqw（容器查询单位）随面板宽度等比缩放
//   - 主题色从 ppt/theme/theme1.xml 的 a:clrScheme 解析；无法解析时用黑色/白色兜底
//   - 图片仅接受 png/jpg/gif/webp/bmp 栅格图，拒绝 SVG 等可能带脚本的类型
// ─────────────────────────────────────────────────────────────────────────────

export interface PptxRun {
  text: string;
  sizePt: number; // 磅（pt）
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
}
export interface PptxPara {
  runs: PptxRun[];
  align: string | null;
  indentPct: number | null;
}
export interface PptxBox {
  x: number;
  y: number;
  cx: number;
  cy: number;
}
export type PptxElement =
  | {
      kind: "text";
      box: PptxBox;
      fill: string | null;
      lineColor: string | null;
      lineW: number; // 线宽 EMU
      anchor: "t" | "ctr" | "b";
      wrap: boolean;
      paras: PptxPara[];
    }
  | { kind: "image"; box: PptxBox; dataUrl: string }
  | { kind: "table"; box: PptxBox; rows: string[][]; colWidths: number[] };
export interface PptxSlide {
  index: number;
  elements: PptxElement[];
  bg: string | null;
  note: string;
}
export interface PptxDeck {
  slideW: number;
  slideH: number;
  slides: PptxSlide[];
}

const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DEFAULT_SLIDE_W = 12192000;
const DEFAULT_SLIDE_H = 6858000;
const DEFAULT_SIZE_PT = 18; // presentation.xml 默认文本样式 lvl1 sz=1800
const PPTX_MAX_SLIDES = 400;
const RASTER_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

interface GroupCtx {
  offX: number;
  offY: number;
  extCX: number;
  extCY: number;
  chOffX: number;
  chOffY: number;
  chCX: number;
  chCY: number;
}

// ---------- 基础 XML 工具 ----------

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

function local(el: Element): string {
  return el.tagName.includes(":") ? el.tagName.split(":")[1] : el.tagName;
}

function numAttr(el: Element | null, name: string): number {
  const v = el?.getAttribute(name);
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------- 解析：主题色 ----------

function parseThemeColors(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const doc = parseXml(xml);
    const scheme = doc.getElementsByTagNameNS("*", "clrScheme")[0];
    if (!scheme) return out;
    for (const node of Array.from(scheme.children)) {
      const name = local(node);
      if (!name) continue;
      const srgb = node.getElementsByTagNameNS("*", "srgbClr")[0];
      if (srgb) {
        out[name] = `#${srgb.getAttribute("val") ?? ""}`;
        continue;
      }
      const sys = node.getElementsByTagNameNS("*", "sysClr")[0];
      const last = sys?.getAttribute("lastClr");
      if (last) out[name] = `#${last}`;
    }
  } catch {
    // 主题解析失败不影响预览，调用方用兜底色
  }
  return out;
}

// ---------- 解析：颜色 ----------

function colorFrom(container: Element | null, theme: Record<string, string>, fallback: string): string | null {
  if (!container) return null;
  const srgb = container.getElementsByTagNameNS("*", "srgbClr")[0];
  if (srgb) return `#${srgb.getAttribute("val") ?? ""}`;
  const scheme = container.getElementsByTagNameNS("*", "schemeClr")[0];
  if (scheme) {
    const name = scheme.getAttribute("val") ?? "";
    // tx1/bg1 是 dk1/lt1 的别名
    const key = name === "tx1" ? "dk1" : name === "bg1" ? "lt1" : name;
    return theme[key] ?? fallback;
  }
  const sys = container.getElementsByTagNameNS("*", "sysClr")[0];
  const last = sys?.getAttribute("lastClr");
  return last ? `#${last}` : null;
}

function fillColorOf(spPr: Element, theme: Record<string, string>): string | null {
  const solid = spPr.getElementsByTagNameNS("*", "solidFill")[0];
  if (solid) return colorFrom(solid, theme, "#000000");
  // 渐变/图案/图片填充：预览只支持纯色，其余忽略
  return null;
}

function lineOf(spPr: Element, theme: Record<string, string>): { color: string | null; w: number } {
  const ln = spPr.getElementsByTagNameNS("*", "ln")[0];
  if (!ln) return { color: null, w: 0 };
  const color = colorFrom(ln, theme, "#000000");
  return { color, w: numAttr(ln, "w") };
}

// ---------- 解析：文本 ----------

function runColorOf(rPr: Element, theme: Record<string, string>): string | null {
  const solid = rPr.getElementsByTagNameNS("*", "solidFill")[0];
  return solid ? colorFrom(solid, theme, "#000000") : null;
}

function runsOfPara(pEl: Element, theme: Record<string, string>, defaultSizePt: number): PptxRun[] {
  const runs: PptxRun[] = [];
  for (const node of Array.from(pEl.children)) {
    const tag = local(node);
    if (tag === "r" || tag === "fld") {
      const rPr = node.getElementsByTagNameNS("*", "rPr")[0];
      const t = node.getElementsByTagNameNS("*", "t")[0];
      const text = t?.textContent ?? "";
      const sz = numAttr(rPr, "sz");
      runs.push({
        text,
        sizePt: sz > 0 ? sz / 100 : defaultSizePt,
        bold: rPr?.getAttribute("b") === "1",
        italic: rPr?.getAttribute("i") === "1",
        underline: (rPr?.getAttribute("u") ?? "") !== "" && rPr?.getAttribute("u") !== "none",
        color: rPr ? runColorOf(rPr, theme) : null,
      });
    } else if (tag === "br") {
      runs.push({ text: "\n", sizePt: defaultSizePt, bold: false, italic: false, underline: false, color: null });
    } else if (tag === "tab") {
      runs.push({ text: "\t", sizePt: defaultSizePt, bold: false, italic: false, underline: false, color: null });
    }
  }
  return runs;
}

function parasOf(txBody: Element, theme: Record<string, string>): PptxPara[] {
  const out: PptxPara[] = [];
  for (const node of Array.from(txBody.children)) {
    if (local(node) !== "p") continue;
    const pPr = node.getElementsByTagNameNS("*", "pPr")[0];
    const align = pPr?.getAttribute("algn") ?? null;
    const marL = numAttr(pPr, "marL");
    out.push({
      runs: runsOfPara(node, theme, DEFAULT_SIZE_PT),
      align,
      indentPct: marL > 0 ? marL : null, // 缩进换算成百分比在渲染层用盒宽计算
    });
  }
  return out;
}

function textOfPara(pEl: Element, theme: Record<string, string>, defaultSizePt: number): string {
  return runsOfPara(pEl, theme, defaultSizePt)
    .map((r) => r.text)
    .join("");
}

// ---------- 解析：坐标 ----------

function xfrmBox(spPr: Element, ctx: GroupCtx | null): PptxBox | null {
  const xfrm = spPr.getElementsByTagNameNS("*", "xfrm")[0];
  if (!xfrm) return null;
  const off = xfrm.getElementsByTagNameNS("*", "off")[0];
  const ext = xfrm.getElementsByTagNameNS("*", "ext")[0];
  if (!off || !ext) return null;
  let x = numAttr(off, "x");
  let y = numAttr(off, "y");
  let cx = numAttr(ext, "cx");
  let cy = numAttr(ext, "cy");
  if (cx <= 0 || cy <= 0) return null;
  if (ctx) {
    // 分组内坐标 → 幻灯片绝对坐标
    x = ctx.offX + ((x - ctx.chOffX) * ctx.extCX) / ctx.chCX;
    y = ctx.offY + ((y - ctx.chOffY) * ctx.extCY) / ctx.chCY;
    cx = (cx * ctx.extCX) / ctx.chCX;
    cy = (cy * ctx.extCY) / ctx.chCY;
  }
  return { x, y, cx, cy };
}

function groupCtx(node: Element, parent: GroupCtx | null): GroupCtx | null {
  const grpSpPr = node.getElementsByTagNameNS("*", "grpSpPr")[0];
  if (!grpSpPr) return parent;
  const xfrm = grpSpPr.getElementsByTagNameNS("*", "xfrm")[0];
  if (!xfrm) return parent;
  const off = xfrm.getElementsByTagNameNS("*", "off")[0];
  const ext = xfrm.getElementsByTagNameNS("*", "ext")[0];
  const chOff = xfrm.getElementsByTagNameNS("*", "chOff")[0];
  const chExt = xfrm.getElementsByTagNameNS("*", "chExt")[0];
  if (!off || !ext || !chOff || !chExt) return parent;
  const g: GroupCtx = {
    offX: numAttr(off, "x"),
    offY: numAttr(off, "y"),
    extCX: numAttr(ext, "cx"),
    extCY: numAttr(ext, "cy"),
    chOffX: numAttr(chOff, "x"),
    chOffY: numAttr(chOff, "y"),
    chCX: numAttr(chExt, "cx"),
    chCY: numAttr(chExt, "cy"),
  };
  if (g.chCX <= 0 || g.chCY <= 0 || g.extCX <= 0 || g.extCY <= 0) return parent;
  if (parent) {
    // 嵌套分组：先把子分组自身的变换套进父坐标系
    g.offX = parent.offX + ((g.offX - parent.chOffX) * parent.extCX) / parent.chCX;
    g.offY = parent.offY + ((g.offY - parent.chOffY) * parent.extCY) / parent.chCY;
    g.extCX = (g.extCX * parent.extCX) / parent.chCX;
    g.extCY = (g.extCY * parent.extCY) / parent.chCY;
  }
  return g;
}

// ---------- 解析：形状 / 图片 / 表格 ----------

function parseShape(node: Element, ctx: GroupCtx | null, theme: Record<string, string>): PptxElement | null {
  const spPr = node.getElementsByTagNameNS("*", "spPr")[0];
  if (!spPr) return null;
  const box = xfrmBox(spPr, ctx);
  if (!box) return null;
  const txBody = node.getElementsByTagNameNS("*", "txBody")[0];
  const paras = txBody ? parasOf(txBody, theme) : [];
  const hasText = paras.some((p) => p.runs.some((r) => r.text.trim() !== ""));
  const fill = fillColorOf(spPr, theme);
  const line = lineOf(spPr, theme);
  // 既无文字又无填充/边框的形状不可见，跳过
  if (!hasText && !fill && !line.color && line.w === 0) return null;
  const bodyPr = txBody?.getElementsByTagNameNS("*", "bodyPr")[0];
  const anchorRaw = bodyPr?.getAttribute("anchor");
  const anchor: "t" | "ctr" | "b" = anchorRaw === "ctr" || anchorRaw === "b" ? anchorRaw : "t";
  const wrap = bodyPr?.getAttribute("wrap") !== "none";
  return { kind: "text", box, fill, lineColor: line.color, lineW: line.w, anchor, wrap, paras };
}

async function parsePic(
  node: Element,
  ctx: GroupCtx | null,
  rels: Record<string, string>,
  zip: JSZip,
): Promise<PptxElement | null> {
  const spPr = node.getElementsByTagNameNS("*", "spPr")[0];
  const box = spPr ? xfrmBox(spPr, ctx) : null;
  if (!box) return null;
  const blip = node.getElementsByTagNameNS("*", "blip")[0];
  if (!blip) return null;
  const rid = blip.getAttributeNS(RELS_NS, "embed") ?? blip.getAttribute("embed");
  const target = rid ? rels[rid] : undefined;
  if (!target) return null;
  const dataUrl = await mediaDataUrl(zip, target);
  if (!dataUrl) return null;
  return { kind: "image", box, dataUrl };
}

function parseTable(node: Element, ctx: GroupCtx | null, theme: Record<string, string>): PptxElement | null {
  const box = xfrmBox(node, ctx);
  if (!box) return null;
  const tbl = node.getElementsByTagNameNS("*", "tbl")[0];
  if (!tbl) return null;
  const colWidths = Array.from(tbl.getElementsByTagNameNS("*", "gridCol")).map((c) => numAttr(c, "cx"));
  const rows: string[][] = [];
  for (const tr of Array.from(tbl.getElementsByTagNameNS("*", "tr"))) {
    const row: string[] = [];
    for (const tc of Array.from(tr.getElementsByTagNameNS("*", "tc"))) {
      const txBody = tc.getElementsByTagNameNS("*", "txBody")[0];
      const text = txBody
        ? Array.from(txBody.children)
            .filter((n) => local(n) === "p")
            .map((p) => textOfPara(p, theme, DEFAULT_SIZE_PT))
            .join("\n")
        : "";
      row.push(text);
    }
    rows.push(row);
  }
  if (rows.length === 0) return null;
  return { kind: "table", box, rows, colWidths };
}

async function parseSpTree(
  spTree: Element,
  ctx: GroupCtx | null,
  theme: Record<string, string>,
  rels: Record<string, string>,
  zip: JSZip,
): Promise<PptxElement[]> {
  const out: PptxElement[] = [];
  for (const node of Array.from(spTree.children)) {
    const tag = local(node);
    if (tag === "sp" || tag === "cxnSp") {
      const el = parseShape(node, ctx, theme);
      if (el) out.push(el);
    } else if (tag === "pic") {
      const el = await parsePic(node, ctx, rels, zip);
      if (el) out.push(el);
    } else if (tag === "graphicFrame") {
      const el = parseTable(node, ctx, theme);
      if (el) out.push(el);
    } else if (tag === "grpSp") {
      // 分组扁平化：子元素坐标已换算到幻灯片空间，直接按文档顺序插入
      const childCtx = groupCtx(node, ctx);
      const children = await parseSpTree(node, childCtx ?? ctx, theme, rels, zip);
      out.push(...children);
    }
  }
  return out;
}

// ---------- 解析：幻灯片 / 关系 / 媒体 / 备注 ----------

function parseSlideRels(relsXml: string): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const doc = parseXml(relsXml);
    for (const rel of Array.from(doc.getElementsByTagNameNS("*", "Relationship"))) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target") ?? "";
      if (id && target.startsWith("../media/")) {
        // rels 的 Target 相对 ppt/slides/ 目录：../media/image1.png → ppt/media/image1.png
        map[id] = `ppt/${target.replace(/^\.\.\//, "")}`;
      }
    }
  } catch {
    // 无 rels 时视为无媒体
  }
  return map;
}

async function mediaDataUrl(zip: JSZip, path: string): Promise<string | null> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!RASTER_EXT.has(ext)) return null;
  const file = zip.file(path);
  if (!file) return null;
  try {
    const base64 = await file.async("base64");
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${base64}`;
  } catch {
    return null;
  }
}

function bgOf(sld: Element, theme: Record<string, string>): string | null {
  const bg = sld.getElementsByTagNameNS("*", "bg")[0];
  if (!bg) return null;
  return fillColorOf(bg, theme);
}

async function noteOf(zip: JSZip, no: number): Promise<string> {
  const f = zip.file(`ppt/notesSlides/notesSlide${no}.xml`);
  if (!f) return "";
  const xml = await f.async("string");
  const doc = parseXml(xml);
  const out: string[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS("*", "p"))) {
    const ph = p.getElementsByTagNameNS("*", "ph")[0];
    const phType = ph?.getAttribute("type") ?? "";
    if (phType.toLowerCase().includes("slidenum")) continue;
    const text = textOfPara(p, {}, DEFAULT_SIZE_PT).trim();
    if (text) out.push(text);
  }
  return out.join("\n");
}

function slideOrder(presDoc: Document, presRelsXml: string): number[] | null {
  const sldIds = Array.from(presDoc.getElementsByTagNameNS("*", "sldId"));
  if (sldIds.length === 0) return null;
  const idToTarget: Record<string, string> = {};
  try {
    const relsDoc = presRelsXml ? parseXml(presRelsXml) : null;
    if (relsDoc) {
      for (const rel of Array.from(relsDoc.getElementsByTagNameNS("*", "Relationship"))) {
        idToTarget[rel.getAttribute("Id") ?? ""] = rel.getAttribute("Target") ?? "";
      }
    }
  } catch {
    // 忽略，走下面 target 缺失时跳过
  }
  const order: number[] = [];
  for (const sldId of sldIds) {
    const rid = sldId.getAttributeNS(RELS_NS, "id") ?? sldId.getAttribute("id");
    const target = rid ? idToTarget[rid] : undefined;
    const m = target ? /slide(\d+)\.xml$/.exec(target) : null;
    if (m) order.push(Number(m[1]));
  }
  return order.length > 0 ? order : null;
}

function availableSlideNos(zip: JSZip): number[] {
  const out: number[] = [];
  for (const name of Object.keys(zip.files)) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

// ---------- 入口 ----------

export async function parsePptx(buf: ArrayBuffer): Promise<PptxDeck> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buf);
  const presXml = await zip.file("ppt/presentation.xml")?.async("string");
  if (!presXml) throw new Error("非法的 PPTX 文件：缺少 presentation.xml");

  let slideW = DEFAULT_SLIDE_W;
  let slideH = DEFAULT_SLIDE_H;
  const presDoc = parseXml(presXml);
  const sldSz = presDoc.getElementsByTagNameNS("*", "sldSz")[0];
  if (sldSz) {
    const cx = numAttr(sldSz, "cx");
    const cy = numAttr(sldSz, "cy");
    if (cx > 0 && cy > 0) {
      slideW = cx;
      slideH = cy;
    }
  }

  const themeFile = zip.file("ppt/theme/theme1.xml");
  const theme = themeFile ? parseThemeColors(await themeFile.async("string")) : {};
  const presRelsXml = (await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")) ?? "";
  let order = slideOrder(presDoc, presRelsXml);
  if (!order) order = availableSlideNos(zip);

  const slides: PptxSlide[] = [];
  for (const no of order) {
    const xml = await zip.file(`ppt/slides/slide${no}.xml`)?.async("string");
    if (!xml) continue;
    const relsXml = (await zip.file(`ppt/slides/_rels/slide${no}.xml.rels`)?.async("string")) ?? "";
    const rels = parseSlideRels(relsXml);
    const doc = parseXml(xml);
    const sld = doc.getElementsByTagNameNS("*", "sld")[0];
    if (!sld) continue;
    const bg = bgOf(sld, theme);
    const spTree = sld.getElementsByTagNameNS("*", "spTree")[0];
    const elements = spTree ? await parseSpTree(spTree, null, theme, rels, zip) : [];
    const note = await noteOf(zip, no);
    slides.push({ index: no, elements, bg, note });
    if (slides.length >= PPTX_MAX_SLIDES) break;
  }
  if (slides.length === 0) throw new Error("未找到幻灯片");
  return { slideW, slideH, slides };
}

// ---------- 渲染 ----------

const FONT_SCALE = 100 / 960; // 幻灯片按 960px 设计宽（13.33in × 72dpi），1pt = 1px；cqw 随容器等比
function cq(pt: number): string {
  return `calc(${(pt * FONT_SCALE).toFixed(4)} * 1cqw)`;
}
function pct(n: number, total: number): string {
  if (total <= 0) return "0%";
  return `${((n / total) * 100).toFixed(4)}%`;
}

const ANCHOR_MAP: Record<string, string> = { t: "flex-start", ctr: "center", b: "flex-end" };
const ALIGN_MAP: Record<string, string> = { l: "left", ctr: "center", r: "right", j: "justify" };

function renderElement(el: PptxElement, deck: PptxDeck, key: number | string): ReactNode {
  const pos: CSSProperties = {
    left: pct(el.box.x, deck.slideW),
    top: pct(el.box.y, deck.slideH),
    width: pct(el.box.cx, deck.slideW),
    height: pct(el.box.cy, deck.slideH),
  };
  if (el.kind === "text") {
    return (
      <div
        key={key}
        className="artifact-ppt-el artifact-ppt-shape"
        style={{
          ...pos,
          backgroundColor: el.fill ?? undefined,
          borderColor: el.lineColor ?? undefined,
          borderWidth: el.lineW > 0 ? cq(el.lineW / 12700) : undefined,
          borderStyle: el.lineColor || el.lineW > 0 ? "solid" : undefined,
        }}
      >
        <div
          className={`artifact-ppt-text${el.wrap ? "" : " is-nowrap"}`}
          style={{ justifyContent: ANCHOR_MAP[el.anchor] }}
        >
          {el.paras.map((p, i) => (
            <div
              key={i}
              className="artifact-ppt-para"
              style={{
                textAlign: (p.align ? ALIGN_MAP[p.align] : undefined) as CSSProperties["textAlign"],
                marginLeft: p.indentPct ? `${p.indentPct}%` : undefined,
              }}
            >
              {p.runs.map((r, j) => (
                <span
                  key={j}
                  style={{
                    fontSize: cq(r.sizePt),
                    fontWeight: r.bold ? 700 : undefined,
                    fontStyle: r.italic ? "italic" : undefined,
                    textDecoration: r.underline ? "underline" : undefined,
                    color: r.color ?? undefined,
                  }}
                >
                  {r.text}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (el.kind === "image") {
    return (
      <div key={key} className="artifact-ppt-el" style={pos}>
        <img className="artifact-ppt-img" src={el.dataUrl} alt="" draggable={false} />
      </div>
    );
  }
  const total = el.colWidths.reduce((a, b) => a + b, 0);
  return (
    <div key={key} className="artifact-ppt-el" style={pos}>
      <table className="artifact-ppt-table">
        {total > 0 && (
          <colgroup>
            {el.colWidths.map((w, i) => (
              <col key={i} style={{ width: `${((w / total) * 100).toFixed(3)}%` }} />
            ))}
          </colgroup>
        )}
        <tbody>
          {el.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} style={{ fontSize: cq(13) }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PptxSlideView({ deck }: { deck: PptxDeck }): ReactNode {
  return (
    <div className="artifact-ppt">
      {deck.slides.map((slide) => (
        <div key={slide.index} className="artifact-ppt-wrap">
          <div
            className="artifact-ppt-slide"
            style={{ aspectRatio: `${deck.slideW} / ${deck.slideH}`, backgroundColor: slide.bg ?? "#ffffff" }}
          >
            <span className="artifact-ppt-no" aria-hidden="true">
              {slide.index}
            </span>
            {slide.elements.map((el, i) => renderElement(el, deck, i))}
          </div>
          {slide.note ? <p className="artifact-ppt-note">备注：{slide.note}</p> : null}
        </div>
      ))}
    </div>
  );
}
