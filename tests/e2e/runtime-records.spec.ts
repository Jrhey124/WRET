import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("runtime records remain ordered, sanitize handles, and support annotations and portable restore", async ({
  page,
}) => {
  await page.addInitScript(() => {
    class FixtureSocket {
      onopen: any;
      onmessage: any;
      onclose: any;
      onerror: any;
      constructor() {
        (window as any).__debugSocket = this;
        setTimeout(() => this.onopen?.({}), 0);
      }
      close() {
        this.onclose?.({});
      }
      emit(message: any) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }
    (window as any).WebSocket = FixtureSocket;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const result =
      path === "/api/bootstrap"
        ? { token: "fixture-token" }
        : path === "/api/capabilities"
          ? { available: true, ready: true, checks: [] }
          : path === "/api/events"
            ? {
                sessionId: "session-fixture",
                events: [],
                captured: 0,
                truncated: false,
              }
            : path === "/api/command"
              ? { result: { type: "string", value: "fixture" } }
              : {};
    await route.fulfill({ json: result });
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Debug", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check companion / reconnect" })
    .click();
  await expect(page.locator(".debug-toolbar strong").first()).toHaveText(
    "Companion connected",
  );
  await page.evaluate(() => {
    const socket = (window as any).__debugSocket;
    const observation = (sequence: number, kind: string, data: unknown) =>
      socket.emit({
        sessionId: "session-fixture",
        observation: { sequence, time: "2026-10-10T00:00:00Z", kind, data },
      });
    // Recovery may overlap live delivery. Archive ordering must stay valid.
    observation(3, "paused", {
      target: "live-target",
      callFrames: [
        {
          callFrameId: "live-frame",
          functionName: "fixture",
          url: "https://example.invalid/app.js",
          location: { scriptId: "live-script", lineNumber: 0, columnNumber: 0 },
          scopeChain: [],
        },
      ],
    });
    observation(1, "running", {});
    observation(2, "script", {
      source: 'console.log("fixture");',
      scriptId: "live-script",
      url: "https://example.invalid/app.js",
    });
    observation(1, "running", {});
    observation(4, "network", {
      event: "Network.requestWillBeSent",
      requestId: "live-network-handle",
      targetType: "page",
      timestamp: 1,
      request: { url: "https://example.invalid/api", method: "GET", headers: { Accept: "application/json" } },
    });
    observation(5, "request", {
      requestId: "live-network-handle",
      targetType: "page",
      url: "https://example.invalid/api",
      method: "GET",
    });
    observation(6, "response", {
      requestId: "live-network-handle",
      targetType: "page",
      url: "https://example.invalid/api",
      status: 200,
      headers: [{ name: "Content-Type", value: "text/plain" }],
      body: btoa("captured response"),
      bodyBytes: 17,
    });
  });
  await expect(page.locator(".debug-toolbar strong").first()).toHaveText(
    "Paused",
  );
  await expect(page.locator(".file-row")).toHaveCount(2);
  const sourceRecord = page
    .locator(".debug-workspace > details")
    .filter({ hasText: "script" });
  await sourceRecord.locator("summary").click();
  await sourceRecord
    .getByRole("button", { name: "Bookmark and annotate observation" })
    .click();
  await expect(page.locator(".file-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.locator(".note-card")).toContainText(
    "Runtime script observation",
  );
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: /Export project/ })
    .first()
    .click();
  const archive = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(archive.schema).toBe(4);
  expect(archive.sessions[0].observations.map((o: any) => o.sequence)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
  expect(archive.sessions[0].requests).toHaveLength(1);
  expect(archive.sessions[0].requests[0].evidenceId).toBeTruthy();
  expect(JSON.stringify(archive)).not.toContain("live-network-handle");
  expect(archive.sessions[0].status).toBe("disconnected");
  expect(JSON.stringify(archive)).not.toContain("live-frame");
  expect(JSON.stringify(archive)).not.toContain("live-script");
  await expect(page.locator(".statusbar")).not.toContainText("Saved in this browser");
  await page.reload();
  await expect(page.locator(".file-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(1);
});
