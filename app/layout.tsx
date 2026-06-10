import type { Metadata } from "next";
import { DemoBadge } from "@/components/demo-badge";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 短视频助手",
  description: "面向小店老板的一键 AI 短视频 SaaS"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <Providers>
          <DemoBadge />
          {children}
        </Providers>
      </body>
    </html>
  );
}
