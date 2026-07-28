import { headers } from "next/headers";
import type { ReactElement, ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { getLocaleRoot, i18nConfig, isLocale, type Locale } from "@/lib/i18n";
import { source } from "@/lib/source";

const localeRequestHeader = "x-kilin-locale";

async function getRequestLocale(): Promise<Locale> {
  const requestedLocale = (await headers()).get(localeRequestHeader);
  return requestedLocale !== null && isLocale(requestedLocale) ? requestedLocale : "en";
}

export default async function DocumentationLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  const locale = await getRequestLocale();

  return (
    <DocsLayout
      containerProps={{ className: "[--fd-layout-width:100%]" }}
      nav={{
        title: (
          <>
            <svg width="22" height="22" viewBox="0 0 128 128" aria-hidden="true">
              <rect width="128" height="128" rx="24" fill="#24262B" />
              <g stroke="#FAFBFC" strokeWidth="11" fill="none">
                <path d="M47 30 L47 98" />
                <path d="M81 30 L47 64 L81 98" />
              </g>
              <g fill="#FAFBFC">
                <circle cx="47" cy="30" r="12" />
                <circle cx="47" cy="98" r="12" />
                <circle cx="81" cy="30" r="12" />
                <circle cx="81" cy="98" r="12" />
              </g>
              <circle cx="47" cy="64" r="12" fill="#C9A25E" />
            </svg>
            Kilin
          </>
        ),
        url: getLocaleRoot(locale),
      }}
      githubUrl="https://github.com/kilin-space/kilin"
      i18n={i18nConfig}
      tree={source.getPageTree(locale)}
    >
      {children}
    </DocsLayout>
  );
}
