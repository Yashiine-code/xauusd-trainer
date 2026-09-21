"use client";

import { Button } from "@/components/ui/button";
import { profitFactor } from "../lib/session-statistics";
import { endReasonLabel, zhCN } from "../i18n/zh-CN";
import type { ChallengeSession, RiskTrainingSession } from "../types/product-modes";

export function RiskTrainingSummary({ session, onDone }: { session: RiskTrainingSession; onDone: () => void }) {
  const winRate = session.stats.trades ? (session.stats.wins / session.stats.trades) * 100 : 0;
  const averageR = session.stats.trades ? session.stats.netR / session.stats.trades : 0;
  return <SummaryShell title={zhCN.summary.riskComplete} subtitle={zhCN.summary.riskSubtitle} onDone={onDone}>
    <SummaryMetric label={zhCN.common.startingBalance} value={usd(session.startingBalance)} /><SummaryMetric label={zhCN.summary.endingBalance} value={usd(session.balance)} /><SummaryMetric label={zhCN.summary.netPnl} value={signedUsd(session.stats.netPnl)} /><SummaryMetric label={zhCN.summary.netR} value={`${session.stats.netR.toFixed(2)}R`} /><SummaryMetric label={zhCN.summary.questionsViewed} value={String(session.stats.questionsViewed)} /><SummaryMetric label={zhCN.summary.trades} value={String(session.stats.trades)} /><SummaryMetric label={zhCN.summary.passCount} value={String(session.stats.passCount)} /><SummaryMetric label={zhCN.summary.winRate} value={`${winRate.toFixed(1)}%`} /><SummaryMetric label={zhCN.summary.averageR} value={`${averageR.toFixed(2)}R`} /><SummaryMetric label={zhCN.summary.maxDrawdown} value={`${session.stats.maxDrawdown.toFixed(1)}%`} /><SummaryMetric label={zhCN.summary.peakBalance} value={usd(session.stats.peakBalance)} /><SummaryMetric label={zhCN.summary.longestLosingStreak} value={String(session.stats.longestLosingStreak)} />
  </SummaryShell>;
}

export function ChallengeSummary({ session, onDone }: { session: ChallengeSession; onDone: () => void }) {
  const winRate = session.stats.totalTrades ? (session.stats.wins / session.stats.totalTrades) * 100 : 0;
  const returnPercent = session.startingBalance > 0 ? ((session.account.balance - session.startingBalance) / session.startingBalance) * 100 : 0;
  const factor = profitFactor(session.stats);
  return <SummaryShell title={session.phase === "BLOWN" ? zhCN.summary.challengeBlown : zhCN.summary.challengeComplete} subtitle={`${zhCN.summary.endedBy}：${endReasonLabel(session.endedReason ?? "USER_ENDED")}`} onDone={onDone}>
    <SummaryMetric label={zhCN.common.startingBalance} value={usd(session.startingBalance)} /><SummaryMetric label={zhCN.summary.endingBalance} value={usd(session.account.balance)} /><SummaryMetric label={zhCN.summary.returnRate} value={`${returnPercent.toFixed(1)}%`} /><SummaryMetric label={zhCN.summary.netPnl} value={signedUsd(session.account.balance - session.startingBalance)} /><SummaryMetric label={zhCN.summary.peakBalance} value={usd(session.account.peakBalance)} /><SummaryMetric label={zhCN.summary.maxDrawdown} value={`${session.account.maxDrawdown.toFixed(1)}%`} /><SummaryMetric label={zhCN.summary.totalTrades} value={String(session.stats.totalTrades)} /><SummaryMetric label={zhCN.summary.winRate} value={`${winRate.toFixed(1)}%`} /><SummaryMetric label={zhCN.summary.profitFactor} value={factor === null ? "—" : factor.toFixed(2)} /><SummaryMetric label={zhCN.summary.largestWin} value={signedUsd(session.stats.largestWin)} /><SummaryMetric label={zhCN.summary.largestLoss} value={signedUsd(session.stats.largestLoss)} /><SummaryMetric label={zhCN.summary.averageHolding} value={session.stats.totalTrades ? `${Math.round(session.stats.totalHoldingMinutes / session.stats.totalTrades)} 分钟` : "—"} /><SummaryMetric label={zhCN.summary.tpSl} value={`${session.stats.exitCounts.TP} / ${session.stats.exitCounts.SL}`} /><SummaryMetric label={zhCN.summary.manualClose} value={String(session.stats.exitCounts.MANUAL_CLOSE)} /><SummaryMetric label={zhCN.summary.stopOut} value={String(session.stats.exitCounts.STOP_OUT)} />
  </SummaryShell>;
}

function SummaryShell({ title, subtitle, onDone, children }: { title: string; subtitle: string; onDone: () => void; children: React.ReactNode }) {
  return <main className="min-h-[100dvh] bg-[#090b0d] px-4 py-10 text-[#d8dde2] sm:px-8"><section className="mx-auto max-w-4xl border border-[#303840] bg-[#0d1013] p-6 sm:p-9"><p className="font-mono text-xs tracking-[0.14em] text-[#d6b66d]">{zhCN.summary.sessionSummary}</p><h1 className="mt-3 text-3xl font-semibold tracking-tight">{title}</h1><p className="mt-2 text-sm text-[#7f8994]">{subtitle}</p><div className="mt-8 grid grid-cols-2 gap-px bg-[#252b31] md:grid-cols-3">{children}</div><Button type="button" size="lg" className="mt-8 h-12 w-full rounded-none bg-[#d6b66d] text-[#111315] hover:bg-[#e2c783]" onClick={onDone}>{zhCN.summary.chooseAnotherMode}</Button></section></main>;
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-h-20 bg-[#111519] p-4"><p className="text-[11px] text-[#707b85]">{label}</p><p className="mt-2 font-mono text-base text-[#d8dde2]">{value}</p></div>;
}

function usd(value: number) { return `$${value.toFixed(2)}`; }
function signedUsd(value: number) { return `${value > 0 ? "+" : ""}$${value.toFixed(2)}`; }
