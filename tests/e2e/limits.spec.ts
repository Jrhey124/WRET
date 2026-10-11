import { test, expect } from "@playwright/test";
import { writeFile } from 'node:fs/promises';

test("rejects over-100 MiB batches before importing any evidence", async ({ page }, testInfo) => {
  await page.goto("/");
  const buffer = Buffer.alloc(21 * 1024 * 1024);
  const paths: string[] = [];
  for (let i=0; i<5; i++) { const path = testInfo.outputPath(`large-${i}.bin`); await writeFile(path, buffer); paths.push(path); }
  await page
    .getByLabel("Import evidence files")
    .setInputFiles(paths);
  await expect(page.locator(".app > .alert")).toContainText("100 MiB");
  await expect(page.locator(".file-row")).toHaveCount(0);
});

test("searches binary bytes and preserves exact selections across UTF-8 BOM and mixed newlines", async ({
  page,
}) => {
  await page.goto("/");
  const source =
    '\uFEFFconst a="é";\r\nconst b="🧭";\nfetch("https://example.invalid");\rconst c=3;';
  await expect(page.getByRole("button", { name: "＋ Import files", exact: true })).toBeEnabled();
  await page.getByLabel("Import evidence files").setInputFiles([
    {
      name: "bom.js",
      mimeType: "text/javascript",
      buffer: Buffer.from(source),
    },
    {
      name: "opaque.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([255, 0, 98, 101, 97, 99, 111, 110, 254]),
    },
  ]);
  await expect(page.locator(".job-status.done")).toHaveCount(2, {
    timeout: 60000,
  });
  await page.getByRole("button", { name: "API pattern fetch" }).click();
  const offset = Buffer.from(source).indexOf("fetch");
  await expect(page.locator(".evidence-status")).toContainText(
    `bytes ${offset}–${offset + 5}`,
  );
  // Re-select with editor keys to verify source-to-byte mapping in both directions.
  await page.locator('.monaco-editor .inputarea, .monaco-editor .native-edit-context').focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  for (let i=0; i<5; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('.evidence-status')).toContainText(`bytes ${offset}–${offset + 5}`);
  await page.getByRole("tab", { name: "Decode", exact: true }).click();
  await page.getByRole("button", { name: "Use evidence selection" }).click();
  await expect(page.getByLabel("Encoded input")).toHaveValue("fetch");
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await page.getByLabel("Project search").fill("beacon");
  await expect(page.locator(".inspector .evidence-row")).toHaveCount(1);
  await page.locator(".inspector .evidence-row button").click();
  await expect(
    page.getByRole("tab", { name: "Hex", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".evidence-status")).toContainText("bytes 2–8");
  await expect(page.locator(".hex-bytes .highlight")).toHaveCount(6);
});

test("a failed restore cannot overwrite the last saved project", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) {
      if (this.name === "projects")
        throw new DOMException("simulated storage failure", "UnknownError");
      return original.apply(this, args);
    };
  });
  await page.goto("/");
  await expect(page.locator(".storage-alert")).toContainText(
    "Autosave is paused",
  );
  await page.getByLabel("Project name").fill("new unsaved work");
  await expect(page.locator(".storage-alert")).toContainText(
    "Autosave is paused",
  );
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open("wret");
          request.onsuccess = () => {
            const db = request.result;
            const cursor = db
              .transaction("projects")
              .objectStore("projects")
              .openCursor();
            cursor.onsuccess = () => {
              resolve(cursor.result === null);
              db.close();
            };
          };
        }),
    ),
  ).toBe(true);
});
