import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("previews derivatives, navigates module references, and reopens provenance", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Import evidence files").setInputFiles([
    { name: "a.js", mimeType: "text/javascript", buffer: Buffer.from("export const answer=1+2;") },
    { name: "b.js", mimeType: "text/javascript", buffer: Buffer.from('import {answer} from "./a.js"; console.log(answer);') },
  ]);
  await expect(page.locator(".file-row")).toHaveCount(2);
  const workflow = page.getByRole("navigation", { name: "Investigation workflow" });
  await workflow.getByRole("button", { name: "Research", exact: true }).click();
  await page.getByLabel("Transform evidence").selectOption({ label: "a.js" });
  await page.getByRole("button", { name: "Preview transformations" }).click();
  await expect(page.locator(".research-diff")).toContainText("export const answer=(3);");
  await page.getByRole("button", { name: "Save derived files" }).click();
  await expect(page.getByRole("status")).toContainText("Saved 1 derived files");
  await page.getByRole("button", { name: "Cross-references", exact: true }).click();
  await page.getByRole("button", { name: "Build reference index" }).click();
  await page.getByLabel("Filter cross-references").fill("answer");
  const imported = page.locator(".research-record").filter({ hasText: "module" });
  await expect(imported).toHaveCount(1);
  await imported.getByRole("button", { name: "Go to definition" }).click();
  await expect(page.locator(".file-row.selected")).toContainText("a.js");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export project/ }).first().click();
  const bytes = await readFile((await (await downloading).path())!);
  const archive = JSON.parse(bytes.toString());
  const original = archive.files.find((file: any) => file.name === "a.js");
  const derivative = archive.files.find((file: any) => file.derivation);
  expect(Buffer.from(original.bytes, "base64").toString()).toBe("export const answer=1+2;");
  expect(derivative.derivation.sourceHash).toBe(original.evidenceHash);
  await page.getByLabel("Open WRET archive").setInputFiles({ name: "reopen.wret.json", mimeType: "application/json", buffer: bytes });
  await expect(page.locator(".file-row")).toHaveCount(3);
  await workflow.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Origin and transformations" })).toBeVisible();
  await expect(page.getByText("literal-constants", { exact: true })).toBeVisible();
});

test("runtime tools gate capabilities and retain bounded snapshot and applied edit evidence", async ({ page }) => {
  await page.addInitScript(() => {
    class Socket {
      onopen: any; onmessage: any; onclose: any;
      constructor() { (window as any).__runtimeSocket = this; setTimeout(() => this.onopen?.({}), 0); }
      close() { this.onclose?.({}); }
      emit(message: any) { this.onmessage?.({ data: JSON.stringify(message) }); }
    }
    (window as any).WebSocket = Socket;
  });
  const commands: any[] = [];
  let sequence = 4;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/command") {
      const command = route.request().postDataJSON(); commands.push(command);
      if (command.action === "liveEdit" && !command.dryRun || command.action === "snapshot" || command.action === "pausePolicy") {
        const observation = { sequence: ++sequence, time: "2026-10-11T00:00:00Z", kind: command.action === "liveEdit" ? "liveEdit" : command.action, data: command.action === "liveEdit" ? { url: command.url, source: command.source, dryRun: false, status: "Ok" } : command.action === "snapshot" ? { heapUsage: { usedSize: 100 }, scopes: [{ name: "local", properties: [{ name: "token", value: "sensitive-token", description: "sensitive-token" }] }] } : { skip: command.skip } };
        await page.evaluate((observation) => (window as any).__runtimeSocket.emit({ sessionId: "fixture", observation }), observation);
      }
      await route.fulfill({ json: command.action === "liveEdit" ? { status: "Ok" } : {} });
      return;
    }
    await route.fulfill({ json: path === "/api/bootstrap" ? { token: "fixture-auth" } : path === "/api/capabilities" ? { available: true, ready: true, checks: [] } : { sessionId: "fixture", events: [], captured: 0, truncated: false } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Investigation workflow" }).getByRole("button", { name: "Debug", exact: true }).click();
  await page.getByRole("button", { name: "Check companion / reconnect" }).click();
  await expect(page.getByRole("button", { name: "Capture state snapshot" })).toBeDisabled();
  await page.evaluate(() => {
    for (const [sequence, kind, data] of [
      [1, "capabilities", { features: ["snapshot", "liveEdit", "pausePolicy"] }],
      [2, "running", {}],
      [3, "script", { source: "function test(){return 1;}", url: "https://example.invalid/app.js?token=private-query" }],
      [4, "paused", { target: "live-target", callFrames: [{ callFrameId: "live-frame", functionName: "test", location: { lineNumber: 0, columnNumber: 0 }, scopeChain: [{ type: "local", object: { objectId: "live-scope" } }] }] }],
    ]) (window as any).__runtimeSocket.emit({ sessionId: "fixture", observation: { sequence, time: "2026-10-11T00:00:00Z", kind, data } });
  });
  await expect(page.getByRole("button", { name: "Capture state snapshot" })).toBeEnabled();
  await page.getByText("Review a live script edit", { exact: true }).click();
  await page.getByLabel("Live edit script").selectOption({ index: 1 });
  await page.getByLabel("Draft live script source").fill("function test(){return 2;}");
  await expect(page.getByRole("button", { name: "Apply reviewed edit" })).toBeDisabled();
  await page.getByRole("button", { name: "Validate live edit" }).click();
  await page.getByRole("button", { name: "Apply reviewed edit" }).click();
  await page.getByRole("button", { name: "Capture state snapshot" }).click();
  await expect(page.locator(".file-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Suppress all pauses" }).click();
  await expect(page.getByRole("button", { name: "Restore normal pauses" })).toBeVisible();
  expect(commands.find((command) => command.action === "liveEdit").url).toContain("private-query");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export project/ }).first().click();
  const text = await readFile((await (await downloading).path())!, "utf8"), archive = JSON.parse(text);
  expect(text).not.toContain("live-scope"); expect(text).not.toContain("private-query");
  expect(archive.files.find((file: any) => file.captureKind === "live-edit").derivation.recipe).toBe("live-edit");
  const snapshot = archive.files.find((file: any) => file.captureKind === "snapshot");
  expect(Buffer.from(snapshot.bytes, "base64").toString()).not.toContain("sensitive-token");
  await page.evaluate((sequence) => (window as any).__runtimeSocket.emit({ sessionId: "fixture", observation: { sequence, time: "2026-10-11T00:00:00Z", kind: "capabilities", data: { features: ["snapshot", "pausePolicy"], unsupported: { liveEdit: "Live script editing is unavailable in this Chromium build." } } } }), ++sequence);
  await expect(page.getByRole("button", { name: "Validate live edit" })).toBeDisabled();
  await expect(page.getByText("Live script editing is unavailable in this Chromium build.", { exact: true })).toBeVisible();
});
