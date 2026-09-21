import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "XAUUSD 历史行情交易训练",
  description: "使用隐藏的 XAUUSD 历史行情训练交易计划。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
