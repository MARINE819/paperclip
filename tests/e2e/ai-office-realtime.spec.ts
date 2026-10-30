import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Request as PWRequest,
  type WebSocket as PWWebSocket,
  type WebSocketRoute,
} from "@playwright/test";

// NEXORA — AI Office WebSocket real-time connection UAT (isolated e2e env:
// port 3199 / embedded-postgres 54350, never the operational 3100/54329
// instance). Verifies the actual browser-level LiveUpdates WebSocket
// lifecycle (connect, no duplicate connections, disconnect/reconnect), the
// client-side handling of a heartbeat.run.progress message, and the
// WS-outage 60s fallback-polling path — all against a real throwaway
// server, not a jsdom/unit mock.
//
// Scope note:
// - heartbeat.run.progress: in production this WS frame is only ever
//   emitted when a run executes through a sandbox-transport execution
//   target (packages/adapter-utils/src/execution-target.ts, gated on
//   target.kind === "remote" && target.transport === "sandbox" —
//   confirmed by reading the source); no sandbox provider is configured in
//   this throwaway e2e instance, and none is added here. The test below
//   therefore injects ONE synthetic heartbeat.run.progress message
//   (schema-matched to server/src/services/heartbeat.ts's
//   publishHeartbeatRunRuntimeProgress payload) onto an otherwise fully
//   real, already-connected LiveUpdates WebSocket, targeting a REAL
//   heartbeat run started via the existing
//   POST /api/agents/:id/heartbeat/invoke endpoint (same call already used
//   by tests/e2e/signoff-policy.spec.ts and mcp-user-stories.spec.ts). This
//   verifies the client's receive -> cache-patch -> render path for real.
//   It does NOT verify that the server itself ever produces this event
//   outside a sandboxed run — that remains unverified and out of scope.
// - 60s fallback polling: verified live using Playwright's page.clock to
//   fast-advance virtual time after a real WS outage, instead of waiting
//   60 real seconds. Every reconnect attempt during that window is
//   immediately refused by the same routeWebSocket handler (never opened),
//   so the app stays in the disconnected state for the full interval
//   instead of silently reconnecting and masking the fallback path. The
//   HTTP request the fallback timer fires is a genuine network request to
//   the real isolated server, observed via page.waitForRequest().

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", { data: { name: `AI Office RT ${label} ${Date.now()}` } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

function isLiveUpdatesSocket(ws: PWWebSocket): boolean {
  return ws.url().includes("/events/ws");
}

async function waitForLiveUpdatesSocket(page: Page, timeoutMs = 20_000): Promise<PWWebSocket> {
  return page.waitForEvent("websocket", { predicate: isLiveUpdatesSocket, timeout: timeoutMs });
}

test.describe("AI Office — WebSocket real-time connection (live browser evidence)", () => {
  test.setTimeout(120_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await newCompany(request, "ws-smoke");
    const agentRes = await request.post(`/api/companies/${seed.companyId}/agents`, {
      data: {
        name: "JARVIS",
        role: "ceo",
        title: "CTO / Orchestrator",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
    });
    expect(agentRes.ok(), `create JARVIS failed ${agentRes.status()}: ${await agentRes.text()}`).toBe(true);
  });

  test("establishes exactly one real LiveUpdates WebSocket connection, loads real data, zero console errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const liveSockets: PWWebSocket[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("websocket", (ws) => {
      if (isLiveUpdatesSocket(ws)) liveSockets.push(ws);
    });

    const socketPromise = waitForLiveUpdatesSocket(page);
    await page.goto(`/${seed.prefix}/ai-office`);

    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    await expect(
      main.locator('[data-room-type="department"]').getByRole("button", { name: /JARVIS/ }),
    ).toBeVisible({ timeout: 30_000 });

    // Real WebSocket evidence (not a mock): the browser actually opened the
    // LiveUpdates socket for this company.
    const socket = await socketPromise;
    expect(socket.url()).toContain(encodeURIComponent(seed.companyId));
    await expect.poll(() => liveSockets.length, { timeout: 10_000 }).toBe(1);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-office-rt-01-connected.png`, fullPage: true });

    expect(pageErrors, `uncaught page errors: ${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("reconnects after the server closes the connection, without stacking duplicate WebSocket connections", async ({
    page,
  }) => {
    // Real WebSocket connections the app itself opens (what LiveUpdatesProvider
    // actually uses) — same instrumentation as the test above.
    const liveSockets: PWWebSocket[] = [];
    page.on("websocket", (ws) => {
      if (isLiveUpdatesSocket(ws)) liveSockets.push(ws);
    });

    // Test-control connections: connectToServer() makes Playwright open a real
    // native WebSocket to this isolated e2e server and pass all traffic through
    // unmodified (verified in playwright-core's routeWebSocket implementation:
    // _apiConnect() creates `new NativeWebSocket(...)`). Calling close() here
    // closes that real connection; by default Playwright forwards the closure
    // to the page's WebSocket too (closeServer -> closePage, since no onClose
    // override is registered), which dispatches a genuine CloseEvent on the
    // object LiveUpdatesProvider's onclose handler is listening to. This
    // replaces context.setOffline(true), which blocks all browser-level
    // network I/O in both directions while active and never let a close frame
    // reach the page within a short wait.
    const serverSideConnections: WebSocketRoute[] = [];
    await page.routeWebSocket(
      (url) => url.pathname.endsWith("/events/ws"),
      (ws) => {
        serverSideConnections.push(ws.connectToServer());
      },
    );

    const firstSocketPromise = waitForLiveUpdatesSocket(page);
    await page.goto(`/${seed.prefix}/ai-office`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    const firstSocket = await firstSocketPromise;
    await expect.poll(() => serverSideConnections.length, { timeout: 10_000 }).toBe(1);

    const firstClosed = firstSocket.waitForEvent("close", { timeout: 20_000 });
    await serverSideConnections[0].close();
    await firstClosed;

    await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-office-rt-02-disconnected.png`, fullPage: true });

    const secondSocketPromise = waitForLiveUpdatesSocket(page, 30_000);
    const secondSocket = await secondSocketPromise;

    expect(secondSocket).not.toBe(firstSocket);
    // Exactly the two real app-visible sockets captured so far (the original +
    // the one reconnect) — no extra stacked reconnect attempts.
    await expect.poll(() => liveSockets.length, { timeout: 10_000 }).toBe(2);
    // Matches one-for-one with the test-control connections actually routed.
    await expect.poll(() => serverSideConnections.length, { timeout: 10_000 }).toBe(2);

    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-office-rt-03-reconnected.png`, fullPage: true });
  });

  test("applies a synthetic heartbeat.run.progress message to a real run's cache and screen state", async ({
    page,
    request,
  }) => {
    // CEO requirement: never silently create a second "Atlas" — check first,
    // and abort instead of creating a duplicate if one already exists in
    // this test company. The shared `seed` company and the beforeAll JARVIS
    // fixture are untouched either way.
    const existingAgentsRes = await request.get(`/api/companies/${seed.companyId}/agents`);
    expect(
      existingAgentsRes.ok(),
      `list agents failed ${existingAgentsRes.status()}: ${await existingAgentsRes.text()}`,
    ).toBe(true);
    const existingAgents = (await existingAgentsRes.json()) as Array<{ id?: string; name?: string }>;
    const existingAtlas = existingAgents.find((a) => a?.name === "Atlas");
    expect(
      existingAtlas,
      `an "Atlas" agent already exists in this test company (id=${existingAtlas?.id}) — aborting instead of creating a duplicate, per CEO instruction`,
    ).toBeUndefined();

    const agentRes = await request.post(`/api/companies/${seed.companyId}/agents`, {
      data: {
        name: "Atlas",
        role: "general",
        title: "COO",
        adapterType: "process",
        // A generous safety net, not a timing dependency: the run is
        // explicitly cancelled via the real board-only
        // /heartbeat-runs/:id/cancel endpoint in the `finally` block below
        // regardless of this test's pass/fail outcome.
        // process adapters have no registered models (models: []), so the
        // model-routing step fails closed with "model_not_found" before the
        // adapter is ever dispatched, unless an explicit model is set here.
        // This value is never read by the process adapter itself — existing
        // precedent: tests/e2e/mcp-user-stories.spec.ts:39-49.
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "setTimeout(() => process.exit(0), 60000)"],
          model: "n/a",
        },
      },
    });
    expect(agentRes.ok(), `create ProgressProbe failed ${agentRes.status()}: ${await agentRes.text()}`).toBe(true);
    const agent = await agentRes.json();

    // Real heartbeat run via the same endpoint existing e2e suites already
    // use (tests/e2e/signoff-policy.spec.ts, mcp-user-stories.spec.ts) — not
    // a new API. The legacy endpoint returns 202 with the HeartbeatRun body
    // directly, or `{ status: "skipped" }` if wakeup declined — 202 is
    // `.ok()` either way, so assert on a real run id explicitly instead of
    // trusting .ok() alone.
    const invokeRes = await request.post(`/api/agents/${agent.id}/heartbeat/invoke`, {
      data: {
        payload: {
          prompt: "Please describe the current status for this diagnostic probe.",
        },
      },
    });
    expect(invokeRes.ok(), `heartbeat/invoke failed ${invokeRes.status()}: ${await invokeRes.text()}`).toBe(true);
    const run = await invokeRes.json();
    expect(typeof run?.id, `heartbeat/invoke did not start a real run: ${JSON.stringify(run)}`).toBe("string");

    try {
      const pageSideRoutes: WebSocketRoute[] = [];
      await page.routeWebSocket(
        (url) => url.pathname.endsWith("/events/ws"),
        (ws) => {
          ws.connectToServer(); // keep this connection fully real
          pageSideRoutes.push(ws);
        },
      );

      const socketPromise = waitForLiveUpdatesSocket(page);
      await page.goto(`/${seed.prefix}/ai-office`);
      const main = page.locator("#main-content");
      await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
      await socketPromise;
      await expect.poll(() => pageSideRoutes.length, { timeout: 10_000 }).toBe(1);

      const agentButton = main
        .locator('[data-room-type="department"]')
        .getByRole("button", { name: /Atlas/ });
      await expect(agentButton).toBeVisible({ timeout: 30_000 });
      await agentButton.click();

      const detailSheet = page.getByRole("dialog");
      await expect(detailSheet).toBeVisible({ timeout: 10_000 });

      // Confirms the real run is actually present in the browser's live-runs
      // cache (ui/src/pages/AIOffice.tsx: liveRunByAgentId -> activeRunId,
      // rendered as the "Run ID" row in AgentDetailSheet) before touching
      // anything synthetic — not assumed from timing alone.
      await expect(detailSheet.getByText(run.id)).toBeVisible({ timeout: 15_000 });

      // Before: the real run has not reported any tool yet. AgentDetailSheet
      // (ui/src/components/AIOfficeFloor.tsx) — the component actually
      // mounted on the AI Office floor view, not the Dashboard-only
      // AgentOperationsPanel — only renders the "실행 중 도구" row when
      // currentToolName is set.
      await expect(detailSheet.getByText("실행 중 도구")).toHaveCount(0);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-office-rt-04-before-progress.png`, fullPage: true });

      const SYNTHETIC_TOOL_NAME = "nexora-uat-synthetic-tool";
      const syntheticEvent = {
        id: 999999,
        companyId: seed.companyId,
        type: "heartbeat.run.progress",
        createdAt: new Date().toISOString(),
        payload: {
          runId: run.id,
          agentId: agent.id,
          issueId: null,
          phase: "run_activity",
          message: "NEXORA_UAT_SYNTHETIC_PROBE",
          currentToolName: SYNTHETIC_TOOL_NAME,
          lastAssistantSnippet: null,
          lastEventAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      // Synthetic injection (see top-of-file scope note): this message never
      // actually came from the real server — field names/shape match
      // server/src/services/heartbeat.ts's publishHeartbeatRunRuntimeProgress
      // payload exactly. Sent on the page-side route so it arrives at
      // LiveUpdatesProvider's onmessage exactly like a real frame.
      pageSideRoutes[0].send(JSON.stringify(syntheticEvent));

      // After: the exact same screen now shows the injected tool name —
      // proves the real cache-patch (applyRunLiveStatusPatchToCaches ->
      // queryKeys.liveRuns(companyId)) + render path, not just that a
      // message was sent.
      await expect(detailSheet.getByText(SYNTHETIC_TOOL_NAME)).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-office-rt-05-after-progress.png`, fullPage: true });
    } finally {
      // Cleanup is best-effort and must never override the test's real
      // pass/fail reason above: nothing here ever throws. Failure is
      // instead tagged [CLEANUP_FAILED] in the console so the final report
      // can surface it explicitly either way.
      try {
        const cancelRes = await request.post(`/api/heartbeat-runs/${run.id}/cancel`);
        if (!cancelRes.ok()) {
          console.error(
            `[CLEANUP_FAILED] cancel HTTP ${cancelRes.status()} for run ${run.id}: ${await cancelRes.text()}`,
          );
        } else {
          // The cancel response IS the updated run — no separate GET needed.
          const cancelledRun = await cancelRes.json();
          const terminal = ["cancelled", "succeeded", "failed", "timed_out"].includes(cancelledRun?.status);
          if (terminal) {
            console.log(`[cleanup] run ${run.id} terminal after cancel: status=${cancelledRun?.status}`);
          } else {
            console.error(
              `[CLEANUP_FAILED] run ${run.id} still not terminal after cancel: status=${cancelledRun?.status}`,
            );
          }
        }
      } catch (err) {
        console.error(`[CLEANUP_FAILED] cancel threw for run ${run.id}: ${String(err)}`);
      }
    }
  });

  test("falls back to 60s polling while disconnected, verified via a real HTTP request under an accelerated clock", async ({
    page,
  }) => {
    // Install before navigating (Playwright's documented best practice): the
    // clock auto-ticks in lockstep with real time until explicitly paused
    // below, so page load and the initial real connection proceed normally.
    await page.clock.install({ time: Date.now() });

    let connectionCount = 0;
    let firstServerRoute: WebSocketRoute | null = null;
    await page.routeWebSocket(
      (url) => url.pathname.endsWith("/events/ws"),
      (ws) => {
        connectionCount += 1;
        if (connectionCount === 1) {
          firstServerRoute = ws.connectToServer(); // first connection stays fully real
        } else {
          // Every reconnect attempt during the outage below is refused
          // immediately (never opened) — keeps the app disconnected for the
          // whole accelerated window instead of silently reconnecting and
          // flipping refetchInterval back to false before the 60s mark.
          void ws.close();
        }
      },
    );

    const firstSocketPromise = waitForLiveUpdatesSocket(page);
    await page.goto(`/${seed.prefix}/ai-office`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    const firstSocket = await firstSocketPromise;
    expect(connectionCount, "exactly one real connection before the outage").toBe(1);

    const firstClosed = firstSocket.waitForEvent("close", { timeout: 20_000 });
    await firstServerRoute!.close();
    await firstClosed;

    // No pauseAt(): install() alone keeps the clock running, and runFor()
    // below advances it by a relative duration — there is no absolute
    // target time that could ever be "in the past", which is what caused
    // the earlier pauseAt(pauseAtMs) race.

    const agentsListPath = `/api/companies/${seed.companyId}/agents`;
    const isAgentsListGet = (r: PWRequest) =>
      new URL(r.url()).pathname === agentsListPath && r.method() === "GET";

    // Before: well before the 60s mark, confirm no refetch yet, while the
    // refused reconnect attempts keep accumulating — direct evidence the
    // app is actually in the disconnected state, not merely "not yet
    // checked". No other query shares this exact path, and no synthetic
    // event or successful reconnect occurs in this test, so a match here
    // can only come from this fallback timer.
    const earlyRequest = page.waitForRequest(isAgentsListGet, { timeout: 3_000 }).catch(() => null);
    await page.clock.runFor("00:05");
    const connectionCountEarly = connectionCount;
    expect(
      await earlyRequest,
      "agents list should not refetch 5s into the outage, before the 60s fallback fires",
    ).toBeNull();
    expect(connectionCountEarly, "reconnect attempts should keep firing while disconnected").toBeGreaterThan(1);

    // After: advance to and past the 60s mark — the fallback poll must now
    // fire a genuine GET to the real isolated server.
    const fallbackRequestPromise = page.waitForRequest(isAgentsListGet, { timeout: 15_000 });
    await page.clock.runFor("01:00");
    const fallbackRequest = await fallbackRequestPromise;
    expect(fallbackRequest.method()).toBe("GET");
    expect(fallbackRequest.url().startsWith("http://127.0.0.1:3199/")).toBe(true);
    expect(
      connectionCount,
      "reconnect attempts should still be refused throughout",
    ).toBeGreaterThan(connectionCountEarly);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-office-rt-06-fallback-poll.png`, fullPage: true });
  });
});
