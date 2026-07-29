import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactElement } from "react";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";

import { isLocale, locales } from "@/lib/i18n";
import { source } from "@/lib/source";

interface PageProperties {
  params: Promise<{
    locale: string;
    slug?: string[];
  }>;
}

const openGraphLocales = {
  en: "en_US",
  "zh-cn": "zh_CN",
  "zh-tw": "zh_TW",
} as const;

const socialImageAlts = {
  en: "Kilin Documentation",
  "zh-cn": "Kilin 文档",
  "zh-tw": "Kilin 文件",
} as const;

function getLanguageAlternates(slug: string[]): Record<string, string> {
  return Object.fromEntries(
    locales.map((locale) => {
      const page = source.getPage(slug, locale);
      if (page === undefined) {
        throw new Error(`Missing ${locale} translation for /${slug.join("/")}.`);
      }
      return [locale, page.url];
    }),
  );
}

export default async function DocumentationPage({ params }: PageProperties): Promise<ReactElement> {
  const { locale, slug = [] } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  const page = source.getPage(slug, locale);
  if (page === undefined) {
    notFound();
  }

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description === undefined ? null : (
        <DocsDescription>{page.data.description}</DocsDescription>
      )}
      <DocsBody>
        <MDX components={defaultMdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams({
  params,
}: {
  params: {
    locale: string;
  };
}): Array<{ slug: string[] }> {
  if (!isLocale(params.locale)) {
    return [];
  }

  return source.getPages(params.locale).map((page) => ({ slug: page.slugs }));
}

export async function generateMetadata({ params }: PageProperties): Promise<Metadata> {
  const { locale, slug = [] } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  const page = source.getPage(slug, locale);
  if (page === undefined) {
    notFound();
  }

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      languages: getLanguageAlternates(slug),
    },
    openGraph: {
      type: "article",
      locale: openGraphLocales[locale],
      url: page.url,
      title: page.data.title,
      description: page.data.description,
      images: [
        {
          url: "https://docs.kilin.space/opengraph-image",
          alt: socialImageAlts[locale],
        },
      ],
    },
  };
}
