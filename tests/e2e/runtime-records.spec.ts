import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("historical observations survive import, deletion, reload and export without live execution", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Import evidence files").setInputFiles([
    { name: "a.js", mimeType: "text/javascript", buffer: Buffer.from("const a=1;") },
    { name: "b.js", mimeType: "text/javascript", buffer: Buffer.from("const b=2;") },
  ]);
  await expect(page.locator(".file-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Delete a.js", exact: true })).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export project/ }).first().click();
  const archive = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  archive.sessions = [{ id: "legacy", createdAt: "2026-10-10T00:00:00Z", target: "https://example.invalid", status: "running", approvals: [], capturedBytes: 0, truncated: false, observations: [{ sequence: 1, time: "2026-10-10T00:00:00Z", kind: "console", data: { text: "historical fixture" } }] }];
  archive.breakpoints = [{ id: "legacy-bp", url: "https://example.invalid/old.js", line: 1, condition: "" }];
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("Open Whidra project archive").setInputFiles({ name: "legacy.whidra.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)) });
  const workflow = page.getByRole("navigation", { name: "Investigation workflow" });
  await expect(workflow.getByRole("button", { name: "Debug", exact: true })).toHaveCount(0);
  await workflow.getByRole("button", { name: "Observations", exact: true }).click();
  await page.locator("details summary").filter({ hasText: /^console/ }).click();
  await expect(page.getByText(/historical fixture/)).toBeVisible();
  await workflow.getByRole("button", { name: "Inspect", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete a.js", exact: true }).click();
  await expect(page.locator(".file-row")).toHaveCount(1);
  await page.waitForTimeout(1600);
  await page.reload();
  await expect(page.locator(".file-row")).toHaveCount(1);
  const finalDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export project/ }).first().click();
  const restored = JSON.parse(await readFile((await (await finalDownload).path())!, "utf8"));
  expect(restored.sessions[0].observations[0].data.text).toBe("historical fixture");
  expect(restored.breakpoints).toHaveLength(1);
  expect(restored.files[0].evidenceHash).toBe(archive.files[1].evidenceHash);
});
