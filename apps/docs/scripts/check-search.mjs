#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBinary = require.resolve("next/dist/bin/next");

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

const getAvailablePort = async () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
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
  if (process.exitCode !== null) {
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

const port = await getAvailablePort();
const serverOutput = [];
const server = spawn(
  process.execPath,
  [nextBinary, "start", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

try {
  await waitForReady(server, serverOutput);

  for (const headers of [{}, { "x-kilin-locale-rewrite": "en" }]) {
    const response = await fetch(`http://127.0.0.1:${String(port)}/getting-started/quickstart`, {
      headers,
    });
    const html = await response.text();
    assert.equal(
      response.status,
      200,
      `the unprefixed English route must succeed\n${html}\n${serverOutput.join("")}`,
    );
    assert.match(html, /<html lang="en"/u, "the English route must declare lang=en");
    assert.match(
      html,
      /rel="canonical" href="https:\/\/docs\.kilin\.space\/getting-started\/quickstart"/u,
      "the English route must keep its unprefixed canonical URL",
    );
  }

  for (const searchCase of searchCases) {
    const url = new URL(`http://127.0.0.1:${String(port)}/api/search`);
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
} finally {
  await stopServer(server);
}

process.stdout.write("Validated the live search GET route for en, zh-cn, and zh-tw.\n");
