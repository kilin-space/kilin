#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const nextBinary = require.resolve("next/dist/bin/next");
const documentationProjectRoot = fileURLToPath(new URL("..", import.meta.url));
const documentationOrigin = "https://docs.kilin.space";
const serverHostname = "127.0.0.1";

const documentationRouteSuffixes = [
  "",
  "/concepts/monitoring",
  "/concepts/workflows",
  "/getting-started/installation",
  "/getting-started/quickstart",
  "/reference/commands",
  "/reference/configuration",
  "/security/trust-boundaries",
  "/troubleshooting",
];

const localeCases = [
  {
    locale: "en",
    searchQuery: "workflow",
    searchResultUrl: "/en/concepts/workflows",
    switcherLabel: "Choose a language",
    switchTargetLocale: "zh-cn",
    switchTargetName: "简体中文",
  },
  {
    locale: "zh-cn",
    searchQuery: "工作流程",
    searchResultUrl: "/zh-cn/concepts/workflows",
    switcherLabel: "选择语言",
    switchTargetLocale: "zh-tw",
    switchTargetName: "繁體中文",
  },
  {
    locale: "zh-tw",
    searchQuery: "工作流程",
    searchResultUrl: "/zh-tw/concepts/workflows",
    switcherLabel: "選擇語言",
    switchTargetLocale: "en",
    switchTargetName: "English",
  },
];

const representativeRouteSuffixes = ["", "/getting-started/quickstart"];
const documentationRoutes = localeCases.flatMap(({ locale }) =>
  representativeRouteSuffixes.map((suffix) => ({
    locale,
    path: `/${locale}${suffix}`,
    publicUrl: `${documentationOrigin}/${locale}${suffix}`,
    suffix,
  })),
);

const unsupportedRoutes = ["/getting-started/quickstart", "/fr", "/fr/getting-started/quickstart"];

const caseInvalidRoutes = [
  "/EN",
  "/EN/getting-started/quickstart",
  "/zh-CN",
  "/zh-CN/getting-started/quickstart",
  "/zh-TW",
  "/zh-TW/getting-started/quickstart",
];

const publicFileCases = [
  { path: "/brand/kilin-mark.svg", contentType: "image/svg+xml" },
  { path: "/screenshots/viewer-parallel-review.png", contentType: "image/png" },
  { path: "/icon.svg", contentType: "image/svg+xml" },
  { path: "/opengraph-image", contentType: "image/png" },
];

const expectedSitemapUrls = localeCases
  .flatMap(({ locale }) =>
    documentationRouteSuffixes.map((suffix) => `${documentationOrigin}/${locale}${suffix}`),
  )
  .sort();
const documentationLinkPaths = new Set([
  ...expectedSitemapUrls.map((url) => new URL(url).pathname),
  ...documentationRouteSuffixes.map((suffix) => suffix || "/"),
]);

const getAvailablePort = async () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, serverHostname, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local documentation test port."));
        return;
      }
      server.close((error) => {
        if (error === undefined) {
          resolvePort(address.port);
        } else {
          reject(error);
        }
      });
    });
  });

const waitForReady = async (serverProcess, output) =>
  new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Documentation test server did not start.\n${output.join("")}`));
    }, 30_000);

    const inspectOutput = (chunk) => {
      const text = chunk.toString();
      output.push(text);
      if (text.includes("Ready in") || text.includes("Ready on")) {
        clearTimeout(timeout);
        resolveReady();
      }
    };

    serverProcess.stdout.on("data", inspectOutput);
    serverProcess.stderr.on("data", inspectOutput);
    serverProcess.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Documentation test server exited with code ${String(code)}.\n${output.join("")}`,
        ),
      );
    });
  });

const stopServer = async (serverProcess) => {
  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolveExit) => {
    serverProcess.once("exit", resolveExit);
  });
  serverProcess.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) => {
      setTimeout(() => resolveTimeout(false), 5_000);
    }),
  ]);
  if (!stopped) {
    serverProcess.kill("SIGKILL");
    await exited;
  }
};

const startDocumentationServer = async (projectRoot) => {
  const port = await getAvailablePort();
  const origin = `http://${serverHostname}:${String(port)}`;
  const output = [];
  const serverProcess = spawn(
    process.execPath,
    [nextBinary, "start", "--hostname", serverHostname, "--port", String(port)],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForReady(serverProcess, output);
  } catch (error) {
    await stopServer(serverProcess);
    throw error;
  }

  return { origin, output, serverProcess };
};

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const hasLink = (html, attributes) => {
  const linkTags = html.match(/<link\b[^>]*>/giu) ?? [];
  return linkTags.some((linkTag) =>
    Object.entries(attributes).every(([name, value]) =>
      new RegExp(
        String.raw`\b${escapeRegularExpression(name)}="${escapeRegularExpression(value)}"`,
        "iu",
      ).test(linkTag),
    ),
  );
};

const assertDocumentationRoutes = async (serverOrigin, serverOutput) => {
  for (const documentationRoute of documentationRoutes) {
    const response = await fetch(`${serverOrigin}${documentationRoute.path}`);
    const html = await response.text();
    assert.equal(
      response.status,
      200,
      `${documentationRoute.path} must succeed\n${html}\n${serverOutput.join("")}`,
    );
    assert.match(
      html,
      new RegExp(`<html lang="${documentationRoute.locale}"`, "u"),
      `${documentationRoute.path} must declare lang=${documentationRoute.locale}`,
    );
    assert.ok(
      hasLink(html, {
        rel: "canonical",
        href: documentationRoute.publicUrl,
      }),
      `${documentationRoute.path} must use ${documentationRoute.publicUrl} as its canonical URL`,
    );

    for (const { locale } of localeCases) {
      const alternateUrl = `${documentationOrigin}/${locale}${documentationRoute.suffix}`;
      assert.ok(
        hasLink(html, {
          rel: "alternate",
          hrefLang: locale,
          href: alternateUrl,
        }),
        `${documentationRoute.path} must link ${locale} to ${alternateUrl}`,
      );
    }

    const renderedDocumentationLinks = [...html.matchAll(/href="(\/[^"]*)"/gu)]
      .map((match) => new URL(match[1], serverOrigin).pathname)
      .filter((path) => documentationLinkPaths.has(path));
    assert.ok(
      renderedDocumentationLinks.length > 0,
      `${documentationRoute.path} must render documentation navigation`,
    );
    const localeRoot = `/${documentationRoute.locale}`;
    assert.deepEqual(
      renderedDocumentationLinks.filter(
        (path) => path !== localeRoot && !path.startsWith(`${localeRoot}/`),
      ),
      [],
      `${documentationRoute.path} navigation must stay in ${documentationRoute.locale}`,
    );
  }
};

const assertRootRedirect = async (serverOrigin) => {
  const response = await fetch(`${serverOrigin}/`, { redirect: "manual" });
  assert.equal(response.status, 307, "/ must redirect with HTTP 307");

  const location = response.headers.get("location");
  assert.notEqual(location, null, "/ must include a redirect location");
  assert.equal(new URL(location, serverOrigin).pathname, "/en", "/ must redirect to /en");
};

const assertInvalidRoutes = async (serverOrigin, routes) => {
  for (const path of routes) {
    const response = await fetch(`${serverOrigin}${path}`, { redirect: "manual" });
    assert.equal(response.status, 404, `${path} must return HTTP 404`);
  }
};

const assertNotFoundMetadata = async (serverOrigin) => {
  const response = await fetch(`${serverOrigin}/fr`, { redirect: "manual" });
  const html = await response.text();
  assert.equal(response.status, 404, "/fr must return HTTP 404");
  assert.doesNotMatch(
    html,
    /https?:\/\/localhost(?::\d+)?\//u,
    "404 metadata must not contain localhost URLs",
  );
};

const assertPublicFiles = async (serverOrigin) => {
  for (const publicFileCase of publicFileCases) {
    const response = await fetch(`${serverOrigin}${publicFileCase.path}`);
    assert.equal(response.status, 200, `${publicFileCase.path} must remain reachable`);
    assert.ok(
      response.headers.get("content-type")?.startsWith(publicFileCase.contentType),
      `${publicFileCase.path} must use ${publicFileCase.contentType}`,
    );
  }
};

const assertRobots = async (serverOrigin) => {
  const response = await fetch(`${serverOrigin}/robots.txt`);
  const body = await response.text();
  assert.equal(response.status, 200, "/robots.txt must remain reachable");
  assert.match(body, /^Allow: \/$/mu, "/robots.txt must allow documentation routes");
  assert.match(
    body,
    /^Sitemap: https:\/\/docs\.kilin\.space\/sitemap\.xml$/mu,
    "/robots.txt must keep the unprefixed sitemap URL",
  );
};

const assertSitemap = async (serverOrigin) => {
  const response = await fetch(`${serverOrigin}/sitemap.xml`);
  const body = await response.text();
  assert.equal(response.status, 200, "/sitemap.xml must remain reachable");

  const sitemapUrls = [...body.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]).sort();
  assert.deepEqual(
    sitemapUrls,
    expectedSitemapUrls,
    "the sitemap must contain each locale-prefixed document URL exactly once",
  );
};

const assertSearch = async (serverOrigin) => {
  for (const localeCase of localeCases) {
    const url = new URL("/api/search", serverOrigin);
    url.searchParams.set("query", localeCase.searchQuery);
    url.searchParams.set("locale", localeCase.locale);

    const response = await fetch(url);
    assert.equal(response.status, 200, `${localeCase.locale} search must succeed`);

    const results = await response.json();
    assert.ok(Array.isArray(results), `${localeCase.locale} search must return an array`);
    assert.ok(
      results.every((result) => typeof result?.url === "string"),
      `${localeCase.locale} search results must include string URLs`,
    );
    assert.ok(
      results.some((result) => result.url === localeCase.searchResultUrl),
      `${localeCase.locale} search must find ${localeCase.searchResultUrl}`,
    );

    const localeRoot = `/${localeCase.locale}`;
    const crossLocaleResults = results.filter(
      (result) =>
        result.url !== localeRoot &&
        !result.url.startsWith(`${localeRoot}/`) &&
        !result.url.startsWith(`${localeRoot}#`),
    );
    assert.deepEqual(
      crossLocaleResults,
      [],
      `${localeCase.locale} search must not return another locale`,
    );
  }
};

const collectBrowserErrors = (page) => {
  const browserErrors = [];
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  return browserErrors;
};

const assertRoutesHydrate = async (browser, serverOrigin) => {
  for (const documentationRoute of documentationRoutes) {
    const page = await browser.newPage();
    const browserErrors = collectBrowserErrors(page);
    try {
      const response = await page.goto(`${serverOrigin}${documentationRoute.path}`);
      assert.equal(response?.status(), 200, `${documentationRoute.path} must load in Chromium`);
      await page.waitForLoadState("networkidle");
      assert.equal(
        await page.locator("html").getAttribute("lang"),
        documentationRoute.locale,
        `${documentationRoute.path} must hydrate with lang=${documentationRoute.locale}`,
      );
      assert.deepEqual(
        browserErrors,
        [],
        `${documentationRoute.path} must hydrate without browser errors`,
      );
    } finally {
      await page.close();
    }
  }
};

const assertLanguageSwitching = async (browser, serverOrigin) => {
  const suffix = "/getting-started/quickstart";

  for (const localeCase of localeCases) {
    const page = await browser.newPage();
    const browserErrors = collectBrowserErrors(page);
    const sourcePath = `/${localeCase.locale}${suffix}`;
    const targetPath = `/${localeCase.switchTargetLocale}${suffix}`;

    try {
      const response = await page.goto(`${serverOrigin}${sourcePath}`);
      assert.equal(response?.status(), 200, `${sourcePath} must load before language switching`);
      await page.waitForLoadState("networkidle");

      await page
        .getByRole("button", { name: localeCase.switcherLabel, exact: true })
        .first()
        .click();
      await Promise.all([
        page.waitForURL((url) => url.pathname === targetPath),
        page.getByRole("button", { name: localeCase.switchTargetName, exact: true }).last().click(),
      ]);
      await page.waitForLoadState("networkidle");

      assert.equal(
        new URL(page.url()).pathname,
        targetPath,
        `${sourcePath} must switch to the same page in ${localeCase.switchTargetLocale}`,
      );
      assert.equal(
        await page.locator("html").getAttribute("lang"),
        localeCase.switchTargetLocale,
        `${targetPath} must declare lang=${localeCase.switchTargetLocale}`,
      );
      assert.deepEqual(browserErrors, [], `${sourcePath} must switch without browser errors`);
    } finally {
      await page.close();
    }
  }
};

const assertBrowserBehavior = async (serverOrigin) => {
  const browser = await chromium.launch({ headless: true });
  try {
    await assertRoutesHydrate(browser, serverOrigin);
    await assertLanguageSwitching(browser, serverOrigin);
  } finally {
    await browser.close();
  }
};

const assertPrimaryProductionServer = async () => {
  const server = await startDocumentationServer(documentationProjectRoot);
  try {
    await assertRootRedirect(server.origin);
    await assertDocumentationRoutes(server.origin, server.output);
    await assertInvalidRoutes(server.origin, unsupportedRoutes);
    await assertInvalidRoutes(server.origin, caseInvalidRoutes);
    await assertNotFoundMetadata(server.origin);
    await assertSearch(server.origin);
    await assertPublicFiles(server.origin);
    await assertRobots(server.origin);
    await assertSitemap(server.origin);
    await assertBrowserBehavior(server.origin);
  } finally {
    await stopServer(server.serverProcess);
  }
};

await assertPrimaryProductionServer();

process.stdout.write(
  "Validated prefixed locale routes, metadata, search, public files, language switching, and hydration.\n",
);
