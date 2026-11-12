import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import type { Chunk } from "./chunker.js";
import { estimateTokens } from "./chunker.js";
const require = createRequire(import.meta.url);
const unzipper = require("unzipper");
const sax = require("sax");

/** Stream worksheet rows; a batch is acknowledged before any more input is read. */
export async function streamXlsx(filePath: string, emit: (chunks: Chunk[]) => Promise<void>, progress: () => void = () => {}): Promise<void> {
  let lastProgress = 0;
  const heartbeat = () => { if (Date.now() - lastProgress >= 2000) { lastProgress = Date.now(); progress(); } };
  const archive = await unzipper.Open.file(filePath);
  const entry = (name: string) => archive.files.find((f: any) => f.path === name);
  const workbookEntry = entry("xl/workbook.xml"), relsEntry = entry("xl/_rels/workbook.xml.rels");
  if (!workbookEntry || !relsEntry) throw new Error("工作簿结构无效");
  const parseXml = (data: string, onOpen: (node: any) => void) => {
    const parser = sax.parser(true, { xmlns: false }); parser.onopentag = onOpen; parser.write(data).close();
  };
  const rels = new Map<string, string>();
  parseXml((await relsEntry.buffer()).toString("utf8"), n => {
    if (n.name.split(":").pop() !== "Relationship") return;
    const a = n.attributes; if (a.Id && a.Target && !a.TargetMode) rels.set(String(a.Id), String(a.Target));
  });
  const sheets: Array<{ name: string; target: string }> = [];
  parseXml((await workbookEntry.buffer()).toString("utf8"), n => {
    if (n.name.split(":").pop() !== "sheet") return;
    const target = rels.get(String(n.attributes["r:id"] ?? ""));
    if (!target) throw new Error(`工作表无法定位：${n.attributes.name ?? ""}`);
    const normalized = require("node:path").posix.normalize(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    if (!normalized.startsWith("xl/worksheets/")) throw new Error("工作表路径无效");
    sheets.push({ name: String(n.attributes.name ?? ""), target: normalized });
  });
  const shared: string[] = [];
  const strings = entry("xl/sharedStrings.xml");
  if (strings) {
    const parser = sax.parser(true); let inSi = false, inText = false, value = "";
    parser.onopentag = (n: any) => { const tag = n.name.split(":").pop(); if (tag === "si") { inSi = true; value = ""; } if (inSi && tag === "t") inText = true; };
    parser.ontext = (t: string) => { if (inText) value += t; }; parser.oncdata = parser.ontext;
    parser.onclosetag = (n: string) => { const tag = n.split(":").pop(); if (tag === "t") inText = false; if (tag === "si") { shared.push(value); inSi = false; } };
    const decoder = new StringDecoder("utf8");
    for await (const part of strings.stream()) { parser.write(decoder.write(part)); heartbeat(); } parser.write(decoder.end()).close();
  }
  let batch: Chunk[] = [];
  const flushBatch = async () => { if (batch.length) { const current = batch; batch = []; await emit(current); } };
  for (const sheet of sheets) {
    const file = entry(sheet.target); if (!file) throw new Error(`工作表缺失：${sheet.name}`);
    let rowNumber = 0, cellRef = "", cellType = "", textTag = "", cellText = "", formula = "", cells: string[] = [];
    let header = "", group: string[] = [], start = 0, end = 0;
    const pushGroup = () => {
      if (!group.length) return;
      const headingPath = `工作表：${sheet.name} · 第 ${start}–${end} 行`;
      const text = `${headingPath}\n${header ? `表头（第 ${headerRow} 行）：${header}\n` : ""}${group.join("\n")}`;
      batch.push({ text, headingPath, tokenCount: estimateTokens(text) }); group = [];
    };
    let headerRow = 0;
    const parser = sax.parser(true);
    parser.onopentag = (n: any) => {
      const tag = n.name.split(":").pop();
      if (tag === "row") { rowNumber = Number(n.attributes.r) || rowNumber + 1; cells = []; }
      else if (tag === "c") { cellRef = String(n.attributes.r ?? ""); cellType = String(n.attributes.t ?? ""); cellText = ""; formula = ""; }
      else if (tag === "v" || tag === "t" || tag === "f") textTag = tag;
    };
    parser.ontext = (t: string) => { if (textTag === "f") formula += t; else if (textTag === "v" || textTag === "t") cellText += t; }; parser.oncdata = parser.ontext;
    parser.onclosetag = (n: string) => {
      const tag = n.split(":").pop();
      if (tag === "v" || tag === "t" || tag === "f") textTag = "";
      if (tag === "c") {
        let value = cellType === "s" ? (shared[Number(cellText)] ?? "") : cellText;
        if (cellType === "b") value = value === "1" ? "TRUE" : "FALSE";
        if (formula) value = `${value}${value ? " " : ""}[公式: ${formula}]`;
        if (value) cells.push(`${cellRef.replace(/\d+$/, "") || "?"}: ${value}`);
      }
      if (tag === "row" && cells.length) {
        const line = cells.join(" | ");
        if (!header) { header = line; headerRow = rowNumber; }
        if (group.length && group.join("\n").length + line.length > 1200) pushGroup();
        if (!group.length) start = rowNumber; end = rowNumber;
        group.push(`第 ${rowNumber} 行：${line}`);
      }
    };
    const decoder = new StringDecoder("utf8");
    for await (const part of file.stream()) { parser.write(decoder.write(part)); heartbeat(); if (batch.length >= 100) await flushBatch(); }
    parser.write(decoder.end()).close(); pushGroup(); await flushBatch();
  }
}
