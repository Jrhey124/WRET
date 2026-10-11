import { test, expect } from "@playwright/test";
test("guided collection, coverage and analyst links survive export and reopen", async ({ page }) => {
  const external: string[] = [];
  page.on("request", r => { if (r.url().includes("fixture.invalid")) external.push(r.url()); });
  await page.goto("/");
  await page.getByRole("button", { name: "Collect website evidence", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Collect website evidence" })).toBeVisible();
  await page.getByLabel("Website URL (optional)").fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Open website", exact: true }).click();
  await expect(page.getByText("Enter an HTTP or HTTPS URL without embedded credentials.")).toBeVisible();
  await page.setViewportSize({ width: 760, height: 540 });
  await page.locator("html").evaluate(e => { e.style.zoom = "2"; });
  await expect(page.getByRole("heading", { name: "Collect website evidence" })).toBeVisible();
  await page.locator("html").evaluate(e => { e.style.zoom = "1"; });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "2. Record activity" }).click();
  await expect(page.getByText("Enable Preserve log", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Close collection guide tab" }).click();
  await page.getByRole("button", { name: "Collect website evidence", exact: true }).click();
  const entry = (text?: string) => ({ startedDateTime: "2026-10-12T00:00:00Z", request: { method: "GET", url: "https://fixture.invalid/app.js" }, response: { status: 200, content: { mimeType: "text/javascript", ...(text === undefined ? {} : { text }) } } });
  await page.getByLabel("Import HAR capture").setInputFiles({ name: "collection.har", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ log: { entries: [entry("const endpoint='/api/profile';"), entry()] } })) });
  await expect(page.getByRole("heading", { name: "Network", exact: true })).toBeVisible();
  await page.getByText("HAR capture: collection.har - capture coverage").click();
  await expect(page.getByText("absent bodies", { exact: true })).toBeVisible();
  await page.getByLabel("Associate request evidence").selectOption({ index: 1 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Commands", exact: false }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("Export project");
  await page.getByRole("option", { name: "Export project", exact: false }).click();
  const download = await downloadPromise;
  const path = await download.path();
  page.on("dialog", d => d.accept());
  await page.getByLabel("Open Whidra project archive").setInputFiles(path!);
  await page.getByRole("navigation", { name: "Investigation workflow" }).getByRole("button", { name: "Network", exact: true }).click();
  await expect(page.getByLabel("Associate request evidence")).not.toHaveValue("");
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open("wret", 3);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("runtimeRecords");
      const request = tx.objectStore("runtimeRecords").getAll();
      tx.oncomplete = () => { resolve(request.result.some(record => record.sessions?.some((session: any) => session.requests?.some((request: any) => request.analystEvidenceId)))); db.close(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }))).toBe(true);
  await page.reload();
  await expect(page.locator(".file-row")).toHaveCount(1);
  await page.getByRole("navigation", { name: "Investigation workflow" }).getByRole("button", { name: "Network", exact: true }).click();
  await expect(page.getByLabel("Associate request evidence")).not.toHaveValue("");
  await page.getByRole("button", { name: "Beautify", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy beautified source", exact: true })).toBeVisible();
  expect(external).toEqual([]);
});

test("records a deterministic website HAR and imports bounded linked resources", async ({ page, browser }, testInfo) => {
  const harPath = testInfo.outputPath("website.har");
  const collector = await browser.newContext({ recordHar: { path: harPath, content: "embed", mode: "full" } });
  await collector.route("**/collection-fixture/**", async route => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    if (name === "redirect") return route.fulfill({ status: 302, headers: { location: "/collection-fixture/api" } });
    const resources: Record<string, { contentType: string; body: string | Buffer }> = {
      "index.html": { contentType: "text/html", body: '<link rel="stylesheet" href="style.css"><button id="submit">Submit</button><script src="app.js"></script>' },
      "style.css": { contentType: "text/css", body: "button { color: blue; }" },
      "app.js": { contentType: "text/javascript", body: 'document.getElementById("submit").onclick=async()=>{ await fetch("redirect"); await WebAssembly.compile(await (await fetch("module.wasm")).arrayBuffer()); document.body.dataset.done="yes"; };' },
      "module.wasm": { contentType: "application/wasm", body: Buffer.from([0,97,115,109,1,0,0,0]) },
      "api": { contentType: "application/json", body: '{"message":"fixture"}' },
    };
    const resource = resources[name || ""];
    await route.fulfill(resource || { status: 404, body: "Missing fixture" });
  });
  const target = await collector.newPage();
  await target.goto("http://127.0.0.1:4173/collection-fixture/index.html");
  await target.getByRole("button", { name: "Submit" }).click();
  await expect(target.locator("body")).toHaveAttribute("data-done", "yes");
  await collector.close();
  await page.goto("/");
  await page.getByLabel("Import HAR capture").setInputFiles(harPath);
  await expect(page.getByRole("heading", { name: "Network", exact: true })).toBeVisible();
  await page.getByLabel("Resource type").selectOption("wasm");
  await expect(page.locator(".network-table")).toContainText("module.wasm");
  await page.getByRole("button", { name: "Open response evidence", exact: true }).click();
  await expect(page.locator(".evidence-tabs")).toContainText("wasm");
});

test("large captures virtualize results and support keyboard navigation", async ({ page }) => {
  await page.goto("/");
  const entries = Array.from({ length: 500 }, (_, index) => ({ startedDateTime: "2026-10-12T00:00:00Z", request: { method: "GET", url: "https://fixture.invalid/request/" + index }, response: { status: 200, content: { mimeType: "application/json" } } }));
  await page.getByLabel("Import HAR capture").setInputFiles({ name: "large.har", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ log: { entries } })) });
  await expect(page.locator(".network-count")).toHaveText("500 of 500 requests");
  expect(await page.locator(".network-table tbody tr:not([aria-hidden])").count()).toBeLessThanOrEqual(24);
  await page.locator('[data-request-row="0"]').focus();
  await page.keyboard.press("End");
  await expect(page.locator('[data-request-row="499"]')).toBeFocused();
  await expect(page.locator(".network-details h2")).toContainText("request/499");
  await page.getByLabel("Filter network requests").fill("request/200");
  await expect(page.locator(".network-count")).toHaveText("1 of 500 requests");
  await expect(page.locator(".network-table tbody")).toContainText("request/200");
});

test("cancelled HAR worker leaves evidence and captures unchanged", async ({ page }) => {
  await page.goto("/");
  await page.route("**/assets/research.worker-*.js", route => route.fulfill({ contentType: "application/javascript", body: "self.onmessage = () => {};" }));
  await page.getByLabel("Import HAR capture").setInputFiles({ name: "cancel.har", mimeType: "application/json", buffer: Buffer.from('{"log":{"entries":[]}}') });
  await page.getByRole("button", { name: "Cancel HAR import" }).click();
  await expect(page.locator(".alert").filter({ hasText: "Could not import HAR" })).toBeVisible();
  await page.getByRole("navigation", { name: "Investigation workflow" }).getByRole("button", { name: "Network", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No captured requests" })).toBeVisible();
});
