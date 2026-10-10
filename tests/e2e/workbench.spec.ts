import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import wabtFactory from "wabt";
const source =
  'const marker = "🧭";\nfunction collect(value) { return fetch(value); }\ncollect("https://example.invalid/beacon");\nconst encoded = "aGVsbG8=";\n//# sourceMappingURL=https://example.invalid/missing.map';
async function addSample(
  page: import("@playwright/test").Page,
  name = "sample.js",
  content = source,
) {
  await page.getByLabel("Import evidence files").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(content),
  });
  await expect(page.locator(".job-status.done").first()).toBeVisible({
    timeout: 60000,
  });
}
test("complete local investigation, navigation, notes, reports, archive round trip and privacy", async ({
  page,
  baseURL,
}) => {
  const requests: { url: string; method: string; body: string | null }[] = [],
    errors: string[] = [];
  page.on("request", (request) =>
    requests.push({
      url: request.url(),
      method: request.method(),
      body: request.postData(),
    }),
  );
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /WRET: Web-based Reverse Engineering Tool/ }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/welcome.png", fullPage: true });
  await addSample(page);
  await expect(page.locator(".hash-panel code")).toHaveText(/^[a-f0-9]{64}$/);
  await page
    .getByRole("button", { name: "URL https://example.invalid/beacon" })
    .click();
  const start = Buffer.from(source).indexOf("https://example.invalid/beacon");
  await expect(page.locator(".evidence-status")).toContainText(
    `bytes ${start}–${start + 30}`,
  );
  await page
    .getByLabel("Status for https://example.invalid/beacon", { exact: true })
    .selectOption("investigating");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page
    .getByLabel("Analyst note")
    .fill("Review the beacon argument; pattern only.");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".note-card")).toContainText("Review the beacon");
  await page.getByRole("tab", { name: "Beautified", exact: true }).click();
  await expect(
    page.getByText("Derived formatting ·", { exact: false }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Original", exact: true }).click();
  await page.getByRole("button", { name: "Symbols", exact: true }).click();
  await expect(page.locator(".inspector")).toContainText("static call");
  await expect(page.locator(".inspector")).toContainText(
    "unresolved dynamic call",
  );
  await page
    .getByRole("button", { name: "function collect", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByLabel("Note type").selectOption("label");
  await page.getByLabel("Analyst note").fill("network wrapper");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("button", { name: "Symbols", exact: true }).click();
  await expect(page.locator(".inspector")).toContainText("network wrapper");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Evidence relationship graph" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Decode", exact: true }).click();
  await page.getByLabel("Encoded input").fill("aGVsbG8=");
  await page.getByRole("button", { name: "Decode & record step" }).click();
  await expect(page.locator(".decode-card pre").last()).toHaveText("hello");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Project search").fill("beacon");
  await expect(page.locator(".inspector .evidence-row")).toHaveCount(1);
  await page.locator(".inspector .evidence-row button").click();
  await expect(
    page.getByRole("tab", { name: "Original", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: "test-results/investigation.png",
    fullPage: true,
  });
  const archiveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export project ↗" }).click();
  const archive = await archiveDownload;
  const bytes = await readFile((await archive.path())!);
  const parsed = JSON.parse(bytes.toString());
  expect(Buffer.from(parsed.files[0].bytes, "base64").toString()).toBe(source);
  expect(parsed.notes).toHaveLength(2);
  expect(parsed.decodes).toHaveLength(1);
  expect(parsed.tools[0].integrity).toMatch(/^[a-f0-9]{64}$/);
  const reportDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export report ↗", exact: true })
    .click();
  const report = await readFile((await (await reportDownload).path())!, "utf8");
  expect(report).toContain(parsed.files[0].evidenceHash);
  expect(report).toContain("Review the beacon");
  await expect(page.locator(".statusbar")).not.toContainText("Saved in this browser");
  await page.reload();
  await expect(page.locator(".file-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(2);
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page.locator(".file-row")).toHaveCount(0);
  await page.getByLabel("Open WRET archive").setInputFiles({
    name: "case.wret.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect(page.locator(".file-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Findings", exact: true }).click();
  await expect(
    page.getByLabel("Status for https://example.invalid/beacon", {
      exact: true,
    }),
  ).toHaveValue("investigating");
  expect(
    requests.every(
      (r) =>
        r.url.startsWith(`${new URL(baseURL!).origin}/`) ||
        r.url.startsWith(`blob:${new URL(baseURL!).origin}/`),
    ),
  ).toBe(true);
  expect(requests.every((r) => r.method === "GET" && !r.body)).toBe(true);
  expect(requests.some((r) => r.url.includes("example.invalid"))).toBe(false);
  expect(errors).toEqual([]);
});
test("WASM disassembly links functions to original bytes under production CSP", async ({
  page,
}) => {
  const wabt = await wabtFactory(),
    module = wabt.parseWat(
      "example.wat",
      '(module (import "env" "log" (func (param i32))) (func (export "answer") (result i32) i32.const 42))',
    );
  const bytes = module.toBinary({ write_debug_names: false }).buffer;
  module.destroy();
  await page.goto("/");
  await page.getByLabel("Import evidence files").setInputFiles({
    name: "stripped.wasm",
    mimeType: "application/wasm",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator(".job-status.done")).toBeVisible({
    timeout: 60000,
  });
  await page.getByRole("button", { name: "Symbols", exact: true }).click();
  await expect(page.locator(".inspector")).toContainText("wasm export");
  await page.getByRole("button", { name: /^wasm func/ }).click();
  await expect(
    page.getByRole("tab", { name: "WAT", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".monaco-editor")).toContainText("i32.const");
  await page.getByRole("tab", { name: "Hex", exact: true }).click();
  await expect(page.locator(".hex-bytes .highlight").first()).toBeVisible();
  await page.getByRole("button", { name: "Sections", exact: true }).click();
  await expect(page.locator(".inspector")).toContainText("code section");
});
test("HTML remains inert and invalid files retain their original evidence", async ({
  page,
}) => {
  const outside: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("example.invalid")) outside.push(r.url());
  });
  await page.goto("/");
  await addSample(
    page,
    "sample.html",
    '<script>globalThis.SAMPLE_EXECUTED=true; fetch("https://example.invalid/leak")</script><iframe src="https://example.invalid"></iframe>',
  );
  expect(
    await page.evaluate(() => (globalThis as any).SAMPLE_EXECUTED),
  ).toBeUndefined();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(outside).toEqual([]);
  await addSample(page, "broken.js", "function broken( {");
  await expect(page.locator(".diagnostics")).toContainText("parsing");
  await expect(
    page.getByRole("tab", { name: "Original", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});
test("oversized import is rejected before changing the project", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Import evidence files").setInputFiles({
    name: "large.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(25 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toContainText("25 MiB");
  await expect(page.locator(".file-row")).toHaveCount(0);
});
test("tool tampering is blocked and existing notes survive worker failure", async ({
  page,
}) => {
  await page.goto("/");
  await addSample(page);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByLabel("Analyst note").fill("Preserve me");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.route("**/tools/analysis-*.js", (route) =>
    route.fulfill({
      body: 'throw new Error("untrusted")',
      contentType: "text/javascript",
    }),
  );
  await page.getByLabel("Import evidence files").setInputFiles({
    name: "second.js",
    mimeType: "text/plain",
    buffer: Buffer.from("let b=1;"),
  });
  await expect(page.locator(".job-status.failed")).toBeVisible();
  await expect(page.locator(".app > .alert")).toContainText("integrity");
  await expect(page.locator(".note-card")).toContainText("Preserve me");
});
test("cancelling a queued analysis preserves evidence and leaves workbench responsive", async ({
  page,
}) => {
  await page.route("**/tools/manifest.json", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto("/");
  await page.getByLabel("Import evidence files").setInputFiles([
    {
      name: "a.js",
      mimeType: "text/plain",
      buffer: Buffer.from("function a(){}"),
    },
    {
      name: "b.js",
      mimeType: "text/plain",
      buffer: Buffer.from("function b(){}"),
    },
  ]);
  await expect(
    page.getByRole("button", { name: "Cancel analysis" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel analysis" }).click();
  await expect(page.locator(".job-status.cancelled")).toHaveCount(2);
  await expect(page.locator(".file-row")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "＋ Import files", exact: true }),
  ).toBeEnabled();
});
test("storage exhaustion is visible and does not lose notes in memory or export", async ({
  page,
}) => {
  await page.goto("/");
  await addSample(page);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException(
        "simulated quota exhaustion",
        "QuotaExceededError",
      );
    };
  });
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByLabel("Analyst note").fill("Unsaved but exportable");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".storage-alert")).toContainText("still in memory");
  await expect(page.locator(".note-card")).toContainText(
    "Unsaved but exportable",
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export now", exact: true }).click();
  const bytes = await readFile((await (await pending).path())!, "utf8");
  expect(JSON.parse(bytes).notes[0].text).toBe("Unsaved but exportable");
});
