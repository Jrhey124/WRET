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
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("Open Whidra project archive").setInputFiles({ name: "reopen.wret.json", mimeType: "application/json", buffer: bytes });
  await expect(page.locator(".file-row")).toHaveCount(3);
  await workflow.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Origin and transformations" })).toBeVisible();
  await expect(page.getByText("literal-constants", { exact: true })).toBeVisible();
});
