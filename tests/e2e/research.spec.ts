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
  await page.getByRole("button", { name: "Save derived evidence" }).click();
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

test("previews a safe deobfuscation chain and saves each changed step as linked evidence", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Import evidence files").setInputFiles({
    name: "bundle.js",
    mimeType: "text/javascript",
    buffer: Buffer.from('const _0x=["admin"]; send(_0x[0], object["name"]);'),
  });
  await page.getByRole("navigation", { name: "Investigation workflow" }).getByRole("button", { name: "Research", exact: true }).click();
  await page.getByRole("button", { name: "Deobfuscate", exact: true }).click();
  await expect(page.getByLabel("Deobfuscation evidence")).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Preview deobfuscation" }).click();
  await expect(page.locator(".research-diff")).toContainText('send("admin", object.name)');
  await page.getByRole("button", { name: "Save derived evidence" }).click();
  await expect(page.getByRole("status")).toContainText("Saved 2 derived files");
  await expect(page.locator(".file-row")).toHaveCount(3);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export project/ }).first().click();
  const archiveBytes = await readFile((await (await downloading).path())!);
  const archive = JSON.parse(archiveBytes.toString());
  const original = archive.files.find((candidate: any) => candidate.name === "bundle.js");
  const steps = archive.transformations;
  expect(Buffer.from(original.bytes, "base64").toString()).toBe('const _0x=["admin"]; send(_0x[0], object["name"]);');
  expect(steps).toHaveLength(2);
  expect(steps[0].parentHash).toBe(original.evidenceHash);
  expect(steps[1].parentEvidenceId).toBe(steps[0].outputEvidenceId);
  expect(steps[1].parentHash).toBe(steps[0].outputHash);
  expect(steps.map((step: any) => step.parameters.preset)).toEqual(["conservative-cleanup", "conservative-cleanup"]);
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("Open Whidra project archive").setInputFiles({ name: "deobfuscated.whidra.json", mimeType: "application/json", buffer: archiveBytes });
  await expect(page.locator(".file-row")).toHaveCount(3);
  await page.getByRole("navigation", { name: "Investigation workflow" }).getByRole("button", { name: "Research", exact: true }).click();
  await page.getByRole("button", { name: "Transforms", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Origin and transformations" })).toBeVisible();
  await expect(page.getByText("const-string-arrays", { exact: true })).toBeVisible();
  await expect(page.getByText("normalize-properties", { exact: true })).toBeVisible();
});
