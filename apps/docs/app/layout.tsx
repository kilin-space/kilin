import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactElement, ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";

import { i18nUi, isLocale, type Locale } from "@/lib/i18n";

import "./global.css";

const siteUrl = new URL("https://docs.kilin.space");
const socialImageUrl = new URL("/opengraph-image", siteUrl).toString();
const localeRequestHeader = "x-kilin-locale";

const localeMetadata = {
  en: {
    description:
      "Install Kilin, author reusable agent workflows, run them through supported coding agents, and inspect their evidence.",
    openGraphDescription:
      "Author, validate, run, and inspect reusable workflows across supported coding agents.",
    socialImageAlt: "Kilin Documentation",
    openGraphLocale: "en_US",
    title: "Kilin Documentation",
  },
  "zh-cn": {
    description:
      "安装 Kilin，编写可复用的 Agent 工作流程，通过支持的编码 Agent 运行并检查执行证据。",
    openGraphDescription: "编写、验证、运行并检查由支持的编码 Agent 执行的可复用工作流程。",
    socialImageAlt: "Kilin 文档",
    openGraphLocale: "zh_CN",
    title: "Kilin 文档",
  },
  "zh-tw": {
    description:
      "安裝 Kilin，編寫可重用的 Agent 工作流程，透過支援的編碼 Agent 執行並檢查執行證據。",
    openGraphDescription: "編寫、驗證、執行並檢查由支援的編碼 Agent 執行的可重用工作流程。",
    socialImageAlt: "Kilin 文件",
    openGraphLocale: "zh_TW",
    title: "Kilin 文件",
  },
} as const;

async function getRequestLocale(): Promise<Locale> {
  const requestedLocale = (await headers()).get(localeRequestHeader);
  return requestedLocale !== null && isLocale(requestedLocale) ? requestedLocale : "en";
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const content = localeMetadata[locale];

  return {
    metadataBase: siteUrl,
    title: {
      default: content.title,
      template: "%s | Kilin",
    },
    description: content.description,
    openGraph: {
      type: "website",
      locale: content.openGraphLocale,
      siteName: content.title,
      title: content.title,
      description: content.openGraphDescription,
      images: [{ url: socialImageUrl, alt: content.socialImageAlt }],
    },
    twitter: {
      card: "summary_large_image",
      title: content.title,
      description: content.openGraphDescription,
      images: [{ url: socialImageUrl, alt: content.socialImageAlt }],
    },
  };
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  const locale = await getRequestLocale();

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider i18n={i18nUi.provider(locale)}>{children}</RootProvider>
      </body>
    </html>
  );
}
