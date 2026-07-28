import type { MetadataRoute } from "next";

import { locales } from "@/lib/i18n";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => {
    const languageAlternates = Object.fromEntries(
      locales.map((locale) => {
        const localizedPage = source.getPage(page.slugs, locale);
        if (localizedPage === undefined) {
          throw new Error(`Missing ${locale} translation for ${page.url}.`);
        }
        return [locale, new URL(localizedPage.url, "https://docs.kilin.space").toString()];
      }),
    );

    return {
      url: new URL(page.url, "https://docs.kilin.space").toString(),
      changeFrequency: page.slugs.length === 0 ? ("weekly" as const) : ("monthly" as const),
      priority: page.slugs.length === 0 ? 1 : 0.7,
      alternates: {
        languages: languageAlternates,
      },
    };
  });
}
