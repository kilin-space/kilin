import { createI18nMiddleware } from "fumadocs-core/i18n/middleware";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { i18nConfig } from "@/lib/i18n";

const defaultLocale = "en";
const localeRequestHeader = "x-kilin-locale";
const normalizeExplicitLocale = createI18nMiddleware(i18nConfig);

export default function proxy(
  request: NextRequest,
  event: NextFetchEvent,
): ReturnType<typeof normalizeExplicitLocale> | NextResponse {
  const pathLocale = request.nextUrl.pathname.split("/").find((segment) => segment.length > 0);

  if (pathLocale === defaultLocale) {
    return normalizeExplicitLocale(request, event);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    localeRequestHeader,
    pathLocale === "zh-cn" || pathLocale === "zh-tw" ? pathLocale : defaultLocale,
  );
  requestHeaders.delete("x-kilin-locale-rewrite");

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: ["/((?!api|_next|opengraph-image|.*\\..*).*)"],
};
