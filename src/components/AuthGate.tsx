"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type AuthState = "loading" | "signed_out" | "suspended" | "active";
type AuthResponse = { accessStatus?: "active" | "suspended"; needsConfirmation?: boolean; error?: string };

export function AuthGate({ children, required }: { children: ReactNode; required: boolean }) {
  const [state, setState] = useState<AuthState>(required ? "loading" : "active");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!required) return;
    fetch("/api/auth", { cache: "no-store" })
      .then(async (response): Promise<AuthResponse | null> => response.ok ? response.json() : null)
      .then((result) => setState(result?.accessStatus === "active" ? "active" : result?.accessStatus === "suspended" ? "suspended" : "signed_out"))
      .catch(() => setState("signed_out"));
  }, [required]);

  async function submit(action: "signup" | "signin") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, email, password }),
      });
      const result = await response.json() as AuthResponse;
      if (!response.ok) throw new Error(result.error ?? "操作失败，请稍后重试。");
      if (action === "signup" && result.needsConfirmation) {
        setMessage("注册成功。请检查邮箱完成验证，然后登录即可开始训练。");
      } else {
        setState(result.accessStatus === "active" ? "active" : result.accessStatus === "suspended" ? "suspended" : "signed_out");
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally { setBusy(false); }
  }

  async function signout() {
    await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "signout" }) });
    setState("signed_out");
  }

  if (state === "active") return <><div className="fixed right-3 top-3 z-50"><Button size="sm" variant="outline" onClick={signout}>退出登录</Button></div>{children}</>;
  return <main className="flex min-h-screen items-center justify-center bg-[#101417] px-4 text-[#dce2e5]">
    <section className="w-full max-w-sm rounded-xl border border-[#2e363b] bg-[#171d21] p-6">
      <p className="text-xs tracking-[0.16em] text-[#d6b66d]">XAUUSD 交易训练</p>
      <h1 className="mt-3 text-2xl font-semibold">{state === "loading" ? "正在验证登录状态" : state === "suspended" ? "账号暂不可用" : "登录或注册"}</h1>
      {state === "suspended" ? <p className="mt-3 text-sm text-[#aab4bb]">此账号的访问权限已暂停。</p> : null}
      {state === "signed_out" ? <form className="mt-6 space-y-3" onSubmit={(event) => { event.preventDefault(); void submit("signin"); }}>
        <Input type="email" autoComplete="email" placeholder="邮箱" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <Input type="password" autoComplete="current-password" placeholder="密码（至少 8 位）" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} />
        <Button className="w-full bg-[#d6b66d] text-[#111315]" disabled={busy} type="submit">登录</Button>
        <Button className="w-full" variant="outline" disabled={busy} type="button" onClick={() => void submit("signup")}>注册</Button>
      </form> : null}
      {message ? <p className="mt-4 text-sm text-[#d6b66d]">{message}</p> : null}
      {state === "suspended" ? <Button className="mt-5" variant="outline" onClick={signout}>退出登录</Button> : null}
    </section>
  </main>;
}
