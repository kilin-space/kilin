#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const nextBinary = require.resolve("next/dist/bin/next");
const serverHostname = "localhost";

const searchCases = [
  {
    locale: "en",
    query: "workflow",
    expectedUrl: "/concepts/workflows",
  },
  {
    locale: "zh-cn",
    query: "工作流程",
    expectedUrl: "/zh-cn/concepts/workflows",
  },
  {
    locale: "zh-tw",
    query: "工作流程",
    expectedUrl: "/zh-tw/concepts/workflows",
  },
];

const documentationRoutes = [
  {
    path: "/getting-started/quickstart",
    language: "en",
    canonicalUrl: "https://docs.kilin.space/getting-started/quickstart",
  },
  {
    path: "/zh-cn/getting-started/quickstart",
    language: "zh-cn",
    canonicalUrl: "https://docs.kilin.space/zh-cn/getting-started/quickstart",
  },
  {
    path: "/zh-tw/getting-started/quickstart",
    language: "zh-tw",
    canonicalUrl: "https://docs.kilin.space/zh-tw/getting-started/quickstart",
  },
];

const hydrationRoutes = [
  { path: "/", language: "en" },
  ...documentationRoutes.map(({ path, language }) => ({ path, language })),
];

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

const waitForReady = async (process, output) =>
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

    process.stdout.on("data", inspectOutput);
    process.stderr.on("data", inspectOutput);
    process.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Documentation test server exited with code ${String(code)}.\n${output.join("")}`,
        ),
      );
    });
  });

const stopServer = async (process) => {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolveExit) => {
    process.once("exit", resolveExit);
  });
  process.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) => {
      setTimeout(() => resolveTimeout(false), 5_000);
    }),
  ]);
  if (!stopped) {
    process.kill("SIGKILL");
    await exited;
  }
};

const assertRoutesHydrate = async (serverOrigin) => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const hydrationRoute of hydrationRoutes) {
      const page = await browser.newPage();
      const browserErrors = [];
      page.on("pageerror", (error) => {
        browserErrors.push(error.message);
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          browserErrors.push(message.text());
        }
      });

      const response = await page.goto(`${serverOrigin}${hydrationRoute.path}`);
      assert.equal(response?.status(), 200, `${hydrationRoute.path} must load in Chromium`);
      await page.waitForLoadState("networkidle");
      assert.equal(
        await page.locator("html").getAttribute("lang"),
        hydrationRoute.language,
        `${hydrationRoute.path} must hydrate with lang=${hydrationRoute.language}`,
      );
      assert.deepEqual(
        browserErrors,
        [],
        `${hydrationRoute.path} must hydrate without browser errors`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
};

const port = await getAvailablePort();
const serverOrigin = `http://${serverHostname}:${String(port)}`;
const serverOutput = [];
const server = spawn(
  process.execPath,
  [nextBinary, "start", "--hostname", serverHostname, "--port", String(port)],
  {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

try {
  await waitForReady(server, serverOutput);

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
      new RegExp(`<html lang="${documentationRoute.language}"`, "u"),
      `${documentationRoute.path} must declare lang=${documentationRoute.language}`,
    );
    assert.ok(
      html.includes(`rel="canonical" href="${documentationRoute.canonicalUrl}"`),
      `${documentationRoute.path} must use its public canonical URL`,
    );
  }

  const explicitEnglishResponse = await fetch(`${serverOrigin}/en/getting-started/quickstart`, {
    redirect: "manual",
  });
  assert.equal(explicitEnglishResponse.status, 307, "/en routes must redirect");
  assert.equal(
    explicitEnglishResponse.headers.get("location"),
    "/getting-started/quickstart",
    "/en routes must redirect to the unprefixed English route",
  );

  const uppercaseLocaleResponse = await fetch(`${serverOrigin}/zh-CN/getting-started/quickstart`);
  assert.equal(
    uppercaseLocaleResponse.status,
    404,
    "uppercase locale routes must stay unsupported",
  );

  for (const assetPath of ["/brand/kilin-mark.svg", "/screenshots/viewer-parallel-review.png"]) {
    const response = await fetch(`${serverOrigin}${assetPath}`);
    assert.equal(response.status, 200, `${assetPath} must remain reachable`);
  }

  for (const searchCase of searchCases) {
    const url = new URL("/api/search", serverOrigin);
    url.searchParams.set("query", searchCase.query);
    url.searchParams.set("locale", searchCase.locale);

    const response = await fetch(url);
    assert.equal(response.status, 200, `${searchCase.locale} search must succeed`);

    const results = await response.json();
    assert.ok(Array.isArray(results), `${searchCase.locale} search must return an array`);
    assert.ok(
      results.some((result) => result.url === searchCase.expectedUrl),
      `${searchCase.locale} search must find ${searchCase.expectedUrl}`,
    );

    const localePrefix = searchCase.locale === "en" ? "/" : `/${searchCase.locale}`;
    const crossLocaleResults = results.filter((result) => {
      if (searchCase.locale === "en") {
        return result.url.startsWith("/zh-cn") || result.url.startsWith("/zh-tw");
      }
      return (
        result.url !== localePrefix &&
        !result.url.startsWith(`${localePrefix}/`) &&
        !result.url.startsWith(`${localePrefix}#`)
      );
    });
    assert.deepEqual(
      crossLocaleResults,
      [],
      `${searchCase.locale} search must not return another locale`,
    );
  }

  await assertRoutesHydrate(serverOrigin);
} finally {
  await stopServer(server);
}

process.stdout.write(
  "Validated live locale routes, hydration, public assets, and search for en, zh-cn, and zh-tw.\n",
);
