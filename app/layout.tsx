import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { cookies } from "next/headers";
import { headers } from "next/headers";
import { LocaleProvider } from "@/components/locale-context";
import { ProductUIProvider } from "@/components/ui";
import { localeFrom } from "@/lib/i18n";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Arc · Harnest AI workspace",
  description: "A production-boundary example for Harnest and Supabase",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = localeFrom(cookieStore.get("arc_locale")?.value, headerStore.get("accept-language") ?? undefined);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: `try{const t=localStorage.getItem("arc_theme");document.documentElement.dataset.theme=t==="light"||t==="dark"?t:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch{}` }} /></head>
      <body className={`${inter.variable} ${mono.variable}`}><LocaleProvider initialLocale={locale}><ProductUIProvider>{children}</ProductUIProvider></LocaleProvider></body>
    </html>
  );
}
