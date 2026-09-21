"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext client Link navigation currently throws at runtime. */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { zhCN } from "../i18n/zh-CN";

const RISK_OPTIONS = [0.01, 0.02, 0.03, 0.05] as const;
const BALANCE_OPTIONS = [100, 500, 1_000, 5_000] as const;

export function ModeSelection({ onStartRisk, onStartChallenge, savedSessions = [], resuming = false, onResume, error }: {
  onStartRisk: (riskPercent: number) => void;
  onStartChallenge: (startingBalance: number) => void;
  savedSessions?: { sessionId: string; sessionMode: "RISK_TRAINING" | "CHALLENGE"; phase: string; balance: number }[];
  resuming?: boolean;
  onResume?: (sessionId: string) => void;
  error?: string | null;
}) {
  const [riskPercent, setRiskPercent] = useState(0.02);
  const [startingBalance, setStartingBalance] = useState(1_000);
  const [customBalance, setCustomBalance] = useState("");
  const effectiveBalance = customBalance ? Number(customBalance) : startingBalance;

  return <main className="min-h-[100dvh] bg-[#090b0d] px-4 py-8 text-[#d8dde2] sm:px-8 lg:py-14">
    <div className="mx-auto max-w-6xl">
      <header className="flex items-start justify-between gap-5 border-b border-[#252b31] pb-7"><div><p className="font-mono text-xs tracking-[0.16em] text-[#d6b66d]">{zhCN.modes.eyebrow}</p><h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{zhCN.common.chooseMode}</h1><p className="mt-3 max-w-xl text-sm leading-6 text-[#7f8994]">{zhCN.modes.intro}</p></div><a href="/wrong-book" className="shrink-0 border border-[#303840] px-4 py-2 text-sm text-[#c3cbd2] transition-colors hover:border-[#d6b66d] hover:text-[#d6b66d]">错题本</a></header>
      <section className="mt-8 grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
        <article className="border border-[#303840] bg-[#0d1013] p-6 sm:p-8"><p className="font-mono text-xs tracking-[0.14em] text-[#d6b66d]">{zhCN.common.riskTraining}</p><h2 className="mt-4 text-2xl font-semibold">{zhCN.modes.fixedRisk} · {zhCN.modes.automaticLot}</h2><p className="mt-2 max-w-md text-sm leading-6 text-[#7f8994]">{zhCN.modes.riskDescription}</p><div className="mt-8 grid grid-cols-2 gap-px bg-[#252b31]"><SelectionFact label={zhCN.common.startingBalance} value="$1,000" /><SelectionFact label={zhCN.modes.sizing} value={zhCN.modes.automatic} /></div><div className="mt-7"><p className="text-sm text-[#aab2ba]">{zhCN.modes.riskPerTrade}</p><div className="mt-3 grid grid-cols-4 gap-2">{RISK_OPTIONS.map((value) => <Button key={value} type="button" variant="outline" className={`h-11 rounded-none font-mono ${riskPercent === value ? "border-[#d6b66d] bg-[#211e16] text-[#e0c782]" : "border-[#303840] text-[#87919a]"}`} onClick={() => setRiskPercent(value)}>{value * 100}%</Button>)}</div></div><Button type="button" size="lg" className="mt-8 h-12 w-full rounded-none bg-[#d6b66d] text-[#111315] hover:bg-[#e2c783]" onClick={() => onStartRisk(riskPercent)}>{zhCN.modes.startTraining} <ChevronRight /></Button></article>
        <article className="border border-[#303840] bg-[#0d1013] p-6 sm:p-8"><p className="font-mono text-xs tracking-[0.14em] text-[#d6b66d]">{zhCN.common.challenge}</p><h2 className="mt-4 text-2xl font-semibold">{zhCN.modes.freePosition} · {zhCN.modes.realMargin}</h2><p className="mt-2 max-w-md text-sm leading-6 text-[#7f8994]">{zhCN.modes.challengeDescription}</p><div className="mt-8 grid grid-cols-2 gap-px bg-[#252b31]"><SelectionFact label={zhCN.modes.positions} value={zhCN.modes.oneActive} /><SelectionFact label={zhCN.modes.execution} value={zhCN.modes.oneMinute} /></div><div className="mt-7"><label className="text-sm text-[#aab2ba]" htmlFor="custom-balance">{zhCN.common.startingBalance}</label><div className="mt-3 grid grid-cols-4 gap-2">{BALANCE_OPTIONS.map((value) => <Button key={value} type="button" variant="outline" className={`h-10 rounded-none px-1 font-mono text-xs ${!customBalance && startingBalance === value ? "border-[#d6b66d] bg-[#211e16] text-[#e0c782]" : "border-[#303840] text-[#87919a]"}`} onClick={() => { setStartingBalance(value); setCustomBalance(""); }}>${value}</Button>)}</div><Input id="custom-balance" type="number" min="1" inputMode="decimal" value={customBalance} onChange={(event) => setCustomBalance(event.target.value)} placeholder={zhCN.modes.customBalance} className="mt-3 h-11 rounded-none border-[#303840] bg-[#0a0d0f] font-mono text-[#d8dde2] placeholder:text-[#606a73]" /></div><Button type="button" size="lg" className="mt-8 h-12 w-full rounded-none bg-[#d6b66d] text-[#111315] hover:bg-[#e2c783]" disabled={!Number.isFinite(effectiveBalance) || effectiveBalance <= 0} onClick={() => onStartChallenge(effectiveBalance)}>{zhCN.modes.startChallenge} <ChevronRight /></Button></article>
      </section>
      {savedSessions.length ? <section className="mt-8 border border-[#303840] bg-[#0d1013] p-6"><h2 className="text-xl font-semibold">继续上次训练</h2><div className="mt-4 grid gap-2 sm:grid-cols-2">{savedSessions.map((session) => <Button key={session.sessionId} type="button" variant="outline" disabled={resuming} className="h-auto min-h-14 justify-between border-[#303840] text-left" onClick={() => onResume?.(session.sessionId)}><span>{session.sessionMode === "CHALLENGE" ? zhCN.common.challenge : zhCN.common.riskTraining} · {session.phase}</span><span className="font-mono">${session.balance.toFixed(2)}</span></Button>)}</div></section> : null}
      {error ? <p className="mt-4 text-sm text-[#ef6b68]">{error}</p> : null}
    </div>
  </main>;
}

function SelectionFact({ label, value }: { label: string; value: string }) {
  return <div className="bg-[#111519] p-4"><p className="text-[11px] text-[#707b85]">{label}</p><p className="mt-1 font-mono text-sm text-[#d8dde2]">{value}</p></div>;
}
