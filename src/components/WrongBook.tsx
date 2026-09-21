"use client";
/* eslint-disable @next/next/no-img-element, @next/next/no-html-link-for-pages -- Authenticated images and Vinext-safe full navigations are intentional. */

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type WrongBookEntry = {
  id: string;
  symbol: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  resultR: number;
  resultPnl: number;
  exitReason: string;
  note: string;
  tags: string[];
  createdAt: string;
};

const TAGS = ["入场过早", "逆势交易", "假突破判断错误", "止损位置错误", "盈亏比问题", "追涨杀跌", "其他"];

export function WrongBookList() {
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<WrongBookEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/wrong-book?page=${page}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as { entries?: WrongBookEntry[]; total?: number; error?: string };
        if (!response.ok) throw new Error(result.error ?? "读取错题本失败。");
        setEntries(result.entries ?? []);
        setTotal(result.total ?? 0);
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "读取错题本失败。");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [page]);

  const pageCount = Math.max(1, Math.ceil(total / 20));
  const changePage = (next: number) => { setLoading(true); setError(""); setPage(next); };
  return <main className="min-h-[100dvh] bg-[#090b0d] px-4 py-8 text-[#d8dde2] sm:px-8 lg:py-12">
    <div className="mx-auto max-w-7xl">
      <header className="flex items-end justify-between gap-5 border-b border-[#252b31] pb-7">
        <div><p className="font-mono text-xs tracking-[0.16em] text-[#d6b66d]">RISK TRAINING</p><h1 className="mt-3 text-3xl font-semibold">错题本</h1><p className="mt-2 text-sm text-[#7f8994]">只收录止损题，按时间从新到旧排列。</p></div>
        <a href="/" className="flex items-center gap-2 text-sm text-[#b8c0c7] hover:text-[#d6b66d]"><ArrowLeft size={16} /> 返回训练</a>
      </header>
      {loading ? <div className="grid gap-4 pt-8 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-72 animate-pulse border border-[#252b31] bg-[#111519]" />)}</div> : null}
      {error ? <p className="mt-8 border border-[#3b2a2a] bg-[#181112] p-4 text-sm text-[#ef6b68]">{error}</p> : null}
      {!loading && !error && !entries.length ? <div className="mt-8 border border-[#252b31] bg-[#0d1013] p-10 text-center"><p className="text-lg">还没有错题</p><p className="mt-2 text-sm text-[#7f8994]">Risk Training 中止损后查看未来行情，会自动收录。</p></div> : null}
      {!loading && entries.length ? <section className="grid gap-4 pt-8 sm:grid-cols-2 xl:grid-cols-3">{entries.map((entry) => <a key={entry.id} href={`/wrong-book/${entry.id}`} className="group overflow-hidden border border-[#252b31] bg-[#0d1013] transition-colors hover:border-[#4a535b]">
        <img src={`/api/wrong-book/${entry.id}/image?size=thumbnail`} alt={`${entry.symbol} ${entry.timeframe} 错题图表`} loading="lazy" decoding="async" className="aspect-[16/9] w-full bg-[#0b0e11] object-cover" />
        <div className="p-4"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><b>{entry.symbol}</b><span className="font-mono text-xs text-[#7f8994]">{entry.timeframe}</span></div><span className={`font-mono text-sm ${entry.direction === "LONG" ? "text-[#26a69a]" : "text-[#ef6b68]"}`}>{entry.direction}</span></div><div className="mt-4 flex items-end justify-between"><div><p className="font-mono text-xl text-[#ef6b68]">{formatR(entry.resultR)}</p><p className="mt-1 text-xs text-[#8b959e]">止损</p></div><time className="text-xs text-[#68737d]">{formatDate(entry.createdAt)}</time></div></div>
      </a>)}</section> : null}
      {total > 20 ? <nav className="mt-8 flex items-center justify-center gap-4"><Button variant="outline" disabled={page <= 1} onClick={() => changePage(page - 1)}><ChevronLeft /> 上一页</Button><span className="font-mono text-sm text-[#7f8994]">{page} / {pageCount}</span><Button variant="outline" disabled={page >= pageCount} onClick={() => changePage(page + 1)}>下一页 <ChevronRight /></Button></nav> : null}
    </div>
  </main>;
}

export function WrongBookDetail({ id }: { id: string }) {
  const [entry, setEntry] = useState<WrongBookEntry | null>(null);
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "saved" | "failed">("loading");

  useEffect(() => {
    fetch(`/api/wrong-book/${id}`, { cache: "no-store" }).then(async (response) => {
      const result = await response.json() as { entry?: WrongBookEntry; error?: string };
      if (!response.ok || !result.entry) throw new Error(result.error ?? "读取错题失败。");
      setEntry(result.entry); setNote(result.entry.note); setTags(result.entry.tags); setState("ready");
    }).catch(() => setState("failed"));
  }, [id]);

  const save = useCallback(() => {
    setState("saving");
    void fetch(`/api/wrong-book/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note, tags }) })
      .then(async (response) => { if (!response.ok) throw new Error(); setState("saved"); window.setTimeout(() => setState("ready"), 1500); })
      .catch(() => setState("failed"));
  }, [id, note, tags]);

  if (state === "loading") return <main className="grid min-h-[100dvh] place-items-center bg-[#090b0d] text-[#7f8994]">正在读取错题…</main>;
  if (!entry) return <main className="grid min-h-[100dvh] place-items-center bg-[#090b0d] text-[#d8dde2]"><div className="text-center"><p>错题不存在或无权查看。</p><a href="/wrong-book" className="mt-4 inline-block text-[#d6b66d]">返回错题本</a></div></main>;

  const facts = [["Symbol", entry.symbol], ["Timeframe", entry.timeframe], ["Direction", entry.direction], ["Entry", entry.entry.toFixed(2)], ["SL", entry.stopLoss.toFixed(2)], ["TP", entry.takeProfit.toFixed(2)], ["Exit", entry.exitPrice.toFixed(2)], ["R", formatR(entry.resultR)], ["PnL", formatUsd(entry.resultPnl)], ["Result", "止损"], ["Created", formatDate(entry.createdAt)]];
  return <main className="min-h-[100dvh] bg-[#090b0d] px-4 py-8 text-[#d8dde2] sm:px-8">
    <div className="mx-auto max-w-7xl"><header className="flex items-center justify-between border-b border-[#252b31] pb-5"><div><p className="font-mono text-xs text-[#d6b66d]">WRONG BOOK REVIEW</p><h1 className="mt-2 text-2xl font-semibold">{entry.symbol} · {entry.timeframe}</h1></div><a href="/wrong-book" className="flex items-center gap-2 text-sm text-[#b8c0c7] hover:text-[#d6b66d]"><ArrowLeft size={16} /> 返回列表</a></header>
      <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_380px]"><div><img src={`/api/wrong-book/${entry.id}/image`} alt={`${entry.symbol} ${entry.timeframe} 交易复盘图`} className="w-full border border-[#252b31] bg-[#0b0e11]" /><div className="mt-4 grid grid-cols-2 gap-px bg-[#252b31] sm:grid-cols-4">{facts.map(([label, value]) => <div key={label} className="bg-[#111519] p-3"><p className="text-[11px] text-[#707b85]">{label}</p><p className="mt-1 truncate font-mono text-sm">{value}</p></div>)}</div></div>
        <aside className="border border-[#252b31] bg-[#0d1013] p-5"><h2 className="text-lg font-semibold">我的复盘</h2><label className="mt-5 block text-sm text-[#aab2ba]" htmlFor="review-note">复盘笔记</label><Textarea id="review-note" value={note} maxLength={5000} onChange={(event) => setNote(event.target.value)} placeholder="记录入场逻辑、错误原因和改进方案…" className="mt-2 min-h-40 border-[#303840] bg-[#090c0e]" /><p className="mt-5 text-sm text-[#aab2ba]">错误标签</p><div className="mt-3 flex flex-wrap gap-2">{TAGS.map((tag) => <button key={tag} type="button" aria-pressed={tags.includes(tag)} className={`border px-3 py-2 text-xs transition-colors ${tags.includes(tag) ? "border-[#d6b66d] bg-[#211e16] text-[#e0c782]" : "border-[#303840] text-[#87919a] hover:text-white"}`} onClick={() => setTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])}>{tag}</button>)}</div><Button className="mt-6 w-full bg-[#d6b66d] text-[#111315] hover:bg-[#e2c783]" disabled={state === "saving"} onClick={save}>{state === "saving" ? "正在保存…" : state === "saved" ? "已保存" : "保存复盘"}</Button>{state === "failed" ? <p className="mt-3 text-sm text-[#ef6b68]">保存失败，请重试。</p> : null}</aside>
      </section>
    </div>
  </main>;
}

function formatR(value: number) { return `${value > 0 ? "+" : ""}${value.toFixed(2)}R`; }
function formatUsd(value: number) { return `${value > 0 ? "+" : ""}$${value.toFixed(2)}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
