import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("evidence tabs close independently and explorer deletion removes linked project records", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Import evidence files").setInputFiles([
    { name: "alpha.js", mimeType: "text/javascript", buffer: Buffer.from("const alpha = 1;") },
    { name: "beta.js", mimeType: "text/javascript", buffer: Buffer.from("const beta = 2;") },
  ]);
  await expect(page.locator(".file-row")).toHaveCount(2);
  const tabs = page.getByRole("tablist", { name: "Open editor tabs" });
  const alphaRow = page.locator(".file-row").filter({ hasText: "alpha.js" });
  const betaRow = page.locator(".file-row").filter({ hasText: "beta.js" });

  await alphaRow.click();
  await betaRow.click();
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await page.getByRole("button", { name: "Close alpha.js" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(alphaRow).toBeVisible();
  await alphaRow.click();
  await expect(tabs.getByRole("tab", { name: "Inspect alpha.js" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await page.getByRole("button", { name: "Close alpha.js" }).click();
  await expect(tabs.getByRole("tab", { name: "Inspect beta.js" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close beta.js" }).click();
  await expect(tabs.getByRole("tab", { name: "Welcome" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".file-row")).toHaveCount(2);
  await page.getByRole("button", { name: "Close Welcome tab" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("No editor tab open")).toBeVisible();
  await page.getByRole("button", { name: "Open Welcome" }).click();
  await expect(tabs.getByRole("tab", { name: "Welcome" })).toHaveAttribute("aria-selected", "true");

  await alphaRow.click();
  await betaRow.click();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByLabel("Analyst note").fill("Evidence attached to beta");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".note-card")).toContainText("Evidence attached to beta");

  await betaRow.click({ button: "right" });
  page.once("dialog", (message) => void message.accept());
  await page.getByRole("menuitem", { name: "Delete beta.js" }).click();
  await expect(page.locator(".file-row")).toHaveCount(1);
  await expect(page.locator(".file-row")).toContainText("alpha.js");
  await expect(tabs.getByRole("tab", { name: "Inspect alpha.js" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(0);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export project/ }).first().click();
  const archiveBytes = await readFile((await (await download).path())!);
  const archive = JSON.parse(archiveBytes.toString("utf8"));
  expect(archive.files.map((file: { name: string }) => file.name)).toEqual(["alpha.js"]);
  expect(archive.notes).toEqual([]);
  page.once("dialog", (message) => void message.accept());
  await page.getByLabel("Open WRET archive").setInputFiles({ name:"cleaned.wret.json", mimeType:"application/json", buffer:archiveBytes });
  await expect(page.locator(".file-row")).toHaveCount(1);
  await expect(page.locator(".file-row")).toContainText("alpha.js");
  await page.getByRole("button", { name:"Notes", exact:true }).click();
  await expect(page.locator(".note-card")).toHaveCount(0);
});
