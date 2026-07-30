import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { isLocale } from "@/lib/i18n";

export default function proxy(request: NextRequest): NextResponse {
  const pathLocale = request.nextUrl.pathname.split("/", 2)[1] ?? "";
  const normalizedLocale = pathLocale.toLowerCase();

  if (isLocale(normalizedLocale) && pathLocale !== normalizedLocale) {
    return new NextResponse(null, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/([eE][nN]|[zZ][hH]-[cC][nN]|[zZ][hH]-[tT][wW])/:path*"],
};
