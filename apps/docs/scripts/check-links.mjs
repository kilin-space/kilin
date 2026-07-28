#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const locales = ["en", "zh-cn", "zh-tw"];
const defaultLocale = "en";
const expectedRoutes = [
  "/",
  "/concepts/monitoring",
  "/concepts/workflows",
  "/getting-started/installation",
  "/getting-started/quickstart",
  "/reference/commands",
  "/reference/configuration",
  "/security/trust-boundaries",
  "/troubleshooting",
];
const expectedMetaPages = new Map([
  [
    "meta.json",
    ["index", "getting-started", "concepts", "reference", "security", "troubleshooting"],
  ],
  ["concepts/meta.json", ["workflows", "monitoring"]],
  ["getting-started/meta.json", ["installation", "quickstart"]],
  ["reference/meta.json", ["commands", "configuration"]],
  ["security/meta.json", ["trust-boundaries"]],
]);
const contentRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))), "content", "docs");
const markdownExtensions = new Set([".md", ".mdx"]);
const markdownLinkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
const codeBlockPattern = /```[^\n]*\n([\s\S]*?)```/gu;
const cliPinPattern =
  /@kilin-space\/cli@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.-])/gu;

const collectFiles = async (directory, predicate) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(path, predicate);
      }
      return predicate(path) ? [path] : [];
    }),
  );
  return nestedFiles.flat();
};

const routeForFile = (localeRoot, file) => {
  const contentPath = relative(localeRoot, file).split(sep).join("/");
  const extension = extname(contentPath);
  const pathWithoutExtension = contentPath.slice(0, -extension.length);
  if (pathWithoutExtension === "index") {
    return "/";
  }
  if (pathWithoutExtension.endsWith("/index")) {
    return `/${pathWithoutExtension.slice(0, -"/index".length)}`;
  }
  return `/${pathWithoutExtension}`;
};

const publicRoute = (locale, route) => {
  if (locale === defaultLocale) {
    return route;
  }
  return route === "/" ? `/${locale}` : `/${locale}${route}`;
};

const routeLocale = (route) => {
  for (const locale of locales) {
    if (locale !== defaultLocale && (route === `/${locale}` || route.startsWith(`/${locale}/`))) {
      const localizedRoute = route.slice(locale.length + 1);
      return {
        locale,
        route: localizedRoute.length === 0 ? "/" : localizedRoute,
      };
    }
  }
  return { locale: defaultLocale, route };
};

const normalizeTarget = (value, sourceRoute) => {
  const absoluteUrl = new URL(value, `https://docs.kilin.space${sourceRoute}`);
  const route = absoluteUrl.pathname;
  return route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route;
};

const extractCodeBlocks = (source) =>
  [...source.matchAll(codeBlockPattern)].map((match) => match[1]?.trimEnd() ?? "");

const localeFiles = new Map();
const localeRoutes = new Map();
const sourceByRoute = new Map();
const pinnedCliVersions = new Set();
const failures = [];

for (const locale of locales) {
  const localeRoot = join(contentRoot, locale);
  const markdownFiles = await collectFiles(localeRoot, (path) =>
    markdownExtensions.has(extname(path)),
  );
  const routes = new Map();

  for (const file of markdownFiles) {
    const route = routeForFile(localeRoot, file);
    const existingFile = routes.get(route);
    if (existingFile !== undefined) {
      failures.push(`Duplicate ${locale} route ${route}: ${existingFile} and ${file}`);
      continue;
    }
    routes.set(route, file);
    sourceByRoute.set(`${locale}:${route}`, await readFile(file, "utf8"));
  }

  localeFiles.set(locale, markdownFiles);
  localeRoutes.set(locale, routes);

  const routeNames = [...(localeRoutes.get(locale)?.keys() ?? [])].sort();
  if (JSON.stringify(routeNames) !== JSON.stringify([...expectedRoutes].sort())) {
    failures.push(`${locale} routes differ from the canonical route contract`);
  }
}

for (const locale of locales) {
  const localeRoot = join(contentRoot, locale);
  const metaPaths = (await collectFiles(localeRoot, (path) => path.endsWith(`${sep}meta.json`)))
    .map((path) => relative(localeRoot, path).split(sep).join("/"))
    .sort();
  const canonicalMetaPaths = [...expectedMetaPages.keys()].sort();
  if (JSON.stringify(metaPaths) !== JSON.stringify(canonicalMetaPaths)) {
    failures.push(`${locale} meta files differ from the canonical meta contract`);
  }

  for (const [relativeMetaPath, expectedPages] of expectedMetaPages) {
    const localizedMetaFile = join(contentRoot, locale, relativeMetaPath);
    try {
      const localizedMeta = JSON.parse(await readFile(localizedMetaFile, "utf8"));
      if (JSON.stringify(localizedMeta.pages) !== JSON.stringify(expectedPages)) {
        failures.push(`${locale}/${relativeMetaPath} has invalid page ordering`);
      }
    } catch {
      failures.push(`${locale}/${relativeMetaPath} is missing or invalid`);
    }
  }
}

for (const locale of locales) {
  const routes = localeRoutes.get(locale);
  const markdownFiles = localeFiles.get(locale) ?? [];
  if (routes === undefined) {
    continue;
  }

  for (const file of markdownFiles) {
    const sourceRoute = routeForFile(join(contentRoot, locale), file);
    const sourcePublicRoute = publicRoute(locale, sourceRoute);
    const source = sourceByRoute.get(`${locale}:${sourceRoute}`) ?? "";

    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/u)?.[1];
    if (
      frontmatter === undefined ||
      !/^title:\s*.+$/mu.test(frontmatter) ||
      !/^description:\s*.+$/mu.test(frontmatter)
    ) {
      failures.push(`${locale}${sourceRoute} is missing title or description frontmatter`);
    }

    for (const match of source.matchAll(markdownLinkPattern)) {
      const target = match[1];
      if (
        target === undefined ||
        target.startsWith("#") ||
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:")
      ) {
        continue;
      }

      const targetPublicRoute = normalizeTarget(target, sourcePublicRoute);
      const localizedTarget = routeLocale(targetPublicRoute);
      if (localizedTarget.locale !== locale) {
        failures.push(`${locale}${sourceRoute} crosses locale boundary to ${targetPublicRoute}`);
        continue;
      }
      if (!routes.has(localizedTarget.route)) {
        failures.push(`${locale}${sourceRoute} links to missing route ${targetPublicRoute}`);
      }
    }

    for (const schemaVersion of source.matchAll(/schemaVersion:\s*(\d+)/gu)) {
      if (schemaVersion[1] !== "1") {
        failures.push(`${locale}${sourceRoute} uses schemaVersion ${schemaVersion[1]}`);
      }
    }
    for (const packageVersion of source.matchAll(cliPinPattern)) {
      pinnedCliVersions.add(packageVersion[1]);
    }
  }
}

for (const route of expectedRoutes) {
  const englishCode = extractCodeBlocks(sourceByRoute.get(`en:${route}`) ?? "");
  for (const locale of locales.slice(1)) {
    const localizedCode = extractCodeBlocks(sourceByRoute.get(`${locale}:${route}`) ?? "");
    if (JSON.stringify(localizedCode) !== JSON.stringify(englishCode)) {
      failures.push(`${locale}${route} code examples differ from en`);
    }
  }
}

if (pinnedCliVersions.size > 1) {
  failures.push(
    `Locales pin different @kilin-space/cli versions: ${[...pinnedCliVersions].sort().join(", ")}`,
  );
}

if (failures.length > 0) {
  throw new Error(`Documentation contract validation failed:\n${failures.join("\n")}`);
}

process.stdout.write(
  `Validated ${locales.length} locales, ${expectedRoutes.length} routes per locale, localized links, matching examples, and metadata topology.\n`,
);
