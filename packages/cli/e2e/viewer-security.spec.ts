import type { Page, Response } from "@playwright/test";

import { expect, requestViewer, test } from "./fixtures.js";

interface SessionBootstrap {
  readonly csrfToken: string;
  readonly pollIntervalMs: number;
}

interface BoundedOutput {
  readonly text: string;
  readonly totalBytes: number;
  readonly returnedBytes: number;
  readonly truncated: boolean;
}

const openViewerWithSession = async (
  page: Page,
  launchUrl: string,
): Promise<{ readonly navigation: Response; readonly session: SessionBootstrap }> => {
  const sessionResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/session" && response.request().method() === "POST",
  );
  const navigation = await page.goto(launchUrl);
  if (navigation === null) {
    throw new Error("The viewer navigation did not return an HTTP response.");
  }
  const response = await sessionResponse;
  const session = (await response.json()) as SessionBootstrap;
  await expect(page.locator("#app-shell")).toHaveAttribute("aria-busy", "false");
  return { navigation, session };
};

test.describe.configure({ mode: "serial" });

test("viewer authentication and routes enforce the local guarded boundary", async ({
  context,
  page,
  scenario,
  viewer,
}) => {
  const invocationCount = await scenario.runtimeInvocationCount();
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  const { navigation, session } = await openViewerWithSession(page, viewer.launchUrl);

  expect(new URL(page.url()).hash).toBe("");
  expect(requestedUrls.every((url) => url.startsWith(viewer.origin))).toBe(true);
  expect(requestedUrls.every((url) => !url.includes(viewer.launchToken))).toBe(true);
  const csp = navigation.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");

  const cookies = await context.cookies(viewer.origin);
  const sessionCookie = cookies.find(({ name }) => name.startsWith("kilin_session_"));
  expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Strict", secure: false });
  if (sessionCookie === undefined) {
    throw new Error("The viewer did not issue its expected session cookie.");
  }
  const originHost = new URL(viewer.origin).host;
  const cookieHeader = `${sessionCookie.name}=${sessionCookie.value}`;
  const authenticatedHeaders = {
    Host: originHost,
    Origin: viewer.origin,
    Cookie: cookieHeader,
    "X-Kilin-CSRF": session.csrfToken,
  };

  const replayBody = JSON.stringify({ token: viewer.launchToken });
  const replay = await requestViewer(viewer.origin, "/session", {
    method: "POST",
    headers: {
      Host: originHost,
      Origin: viewer.origin,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(replayBody)),
    },
    body: replayBody,
  });
  expect(replay.status).toBe(401);
  expect(replay.body).toContain("SESSION_TOKEN_INVALID");

  const resumeBody = "{}";
  const unauthenticatedResume = await requestViewer(viewer.origin, "/session/resume", {
    method: "POST",
    headers: {
      Host: originHost,
      Origin: viewer.origin,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(resumeBody)),
    },
    body: resumeBody,
  });
  expect(unauthenticatedResume.status).toBe(401);
  expect(unauthenticatedResume.body).toContain("SESSION_REQUIRED");
  const crossOriginResume = await requestViewer(viewer.origin, "/session/resume", {
    method: "POST",
    headers: {
      Host: originHost,
      Origin: "http://127.0.0.1:1",
      Cookie: cookieHeader,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(resumeBody)),
    },
    body: resumeBody,
  });
  expect(crossOriginResume.status).toBe(403);
  expect(crossOriginResume.body).toContain("REQUEST_FORBIDDEN");

  const missingCsrf = await requestViewer(viewer.origin, "/api/runs", {
    headers: { Host: originHost, Origin: viewer.origin, Cookie: cookieHeader },
  });
  expect(missingCsrf.status).toBe(403);
  expect(missingCsrf.body).toContain("CSRF_REQUIRED");
  const wrongCsrf = await requestViewer(viewer.origin, "/api/runs", {
    headers: { ...authenticatedHeaders, "X-Kilin-CSRF": "not-the-session-token" },
  });
  expect(wrongCsrf.status).toBe(403);
  expect(wrongCsrf.body).toContain("CSRF_REQUIRED");
  const wrongOrigin = await requestViewer(viewer.origin, "/api/runs", {
    headers: { ...authenticatedHeaders, Origin: "http://127.0.0.1:1" },
  });
  expect(wrongOrigin.status).toBe(403);
  expect(wrongOrigin.body).toContain("REQUEST_FORBIDDEN");
  const wrongHost = await requestViewer(viewer.origin, "/api/runs", {
    headers: { ...authenticatedHeaders, Host: `localhost:${new URL(viewer.origin).port}` },
  });
  expect(wrongHost.status).toBe(403);
  expect(wrongHost.body).toContain("REQUEST_FORBIDDEN");

  for (const [method, path] of [
    ["POST", "/api/runs"],
    ["PUT", "/api/workflow"],
    ["DELETE", `/api/runs/${scenario.successfulRunId}`],
  ] as const) {
    const mutation = await requestViewer(viewer.origin, path, {
      method,
      headers: authenticatedHeaders,
    });
    expect(mutation.status).toBe(405);
    expect(mutation.headers.allow).toBe("GET");
  }

  const runList = await requestViewer(viewer.origin, "/api/runs", {
    headers: authenticatedHeaders,
  });
  expect(runList.status).toBe(200);
  expect(runList.body).toContain(scenario.successfulRunId);
  expect(runList.body).toContain(scenario.rerunId);
  expect(runList.body).toContain(scenario.decisionPacketRunId);
  expect(runList.body).toContain(scenario.decisionPacketRerunId);
  expect(runList.body).toContain(scenario.ordinaryJsonRunId);
  expect(runList.body).toContain(scenario.failedRunId);
  expect(runList.body).toContain(scenario.cancelledRunId);
  expect(runList.body).toContain(scenario.interruptedRunId);
  expect(runList.body).not.toContain(scenario.otherWorkflowRunId);
  expect(runList.body).not.toContain(scenario.otherWorkingDirectoryRunId);
  expect(runList.body).not.toContain(scenario.project);
  const scopedDetail = await requestViewer(viewer.origin, `/api/runs/${scenario.successfulRunId}`, {
    headers: authenticatedHeaders,
  });
  expect(scopedDetail.status).toBe(200);
  expect(scopedDetail.body).not.toContain(scenario.root);
  expect(scopedDetail.body).not.toContain(scenario.stateDirectory);

  for (const runId of [scenario.otherWorkflowRunId, scenario.otherWorkingDirectoryRunId]) {
    const outOfScope = await requestViewer(viewer.origin, `/api/runs/${runId}`, {
      headers: authenticatedHeaders,
    });
    expect(outOfScope.status).toBe(404);
    expect(outOfScope.body).toContain("RUN_NOT_FOUND");
  }
  for (const path of [
    "/api/runs/not-a-run",
    "/api/runs/%ZZ",
    "/api/runs/%2e%2e",
    `/api/runs/${scenario.failedRunId}/nodes/999999999999999999999/output/stdout`,
    `/api/runs/${scenario.failedRunId}/nodes/1/output/..%2Fstdout`,
    "/api/runs?path=%2Fetc%2Fpasswd",
  ]) {
    const rejected = await requestViewer(viewer.origin, path, { headers: authenticatedHeaders });
    expect(rejected.status).toBe(404);
  }

  const bounded = await requestViewer(
    viewer.origin,
    `/api/runs/${scenario.failedRunId}/nodes/1/output/stdout`,
    { headers: authenticatedHeaders },
  );
  expect(bounded.status).toBe(200);
  const output = JSON.parse(bounded.body) as BoundedOutput;
  expect(output.truncated).toBe(true);
  expect(output.returnedBytes).toBe(65_536);
  expect(output.totalBytes).toBeGreaterThan(output.returnedBytes);
  expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(65_536);
  expect(output.text).toContain("BOUNDED_TAIL_MARKER");
  expect(output.text).not.toContain("TAIL_MUST_NOT_INCLUDE_THIS_PREFIX");

  const stylesheet = await requestViewer(viewer.origin, "/assets/viewer.css", {
    headers: { Host: originHost, Origin: viewer.origin },
  });
  const client = await requestViewer(viewer.origin, "/assets/client.js", {
    headers: { Host: originHost, Origin: viewer.origin },
  });
  expect(stylesheet.status).toBe(200);
  expect(stylesheet.headers["content-type"]).toContain("text/css");
  expect(client.status).toBe(200);
  expect(client.headers["content-type"]).toContain("text/javascript");

  await page.reload();
  await expect(page.locator("#connection-status")).toHaveText("Attached · guarded approval");
  await expect(scenario.runtimeInvocationCount()).resolves.toBe(invocationCount);
});

test("SIGINT stops the attached server without invoking the runtime", async ({
  page,
  scenario,
  viewer,
}) => {
  const invocationCount = await scenario.runtimeInvocationCount();
  await openViewerWithSession(page, viewer.launchUrl);

  const termination = await viewer.stop();
  expect(termination).toEqual({ exitCode: 0, signal: null });
  await expect(requestViewer(viewer.origin, "/")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  await expect(scenario.runtimeInvocationCount()).resolves.toBe(invocationCount);
});
