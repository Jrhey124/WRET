import { test, expect } from "@playwright/test";

test("Whidra logo, Welcome tab, and Investigation tabs remain readable and keyboard operable", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 560 });
  await page.goto("/");
  await expect(page).toHaveTitle("Whidra — Web-based Reverse Engineering Tool");

  const home = page.getByRole("button", { name: "Whidra home — open Welcome" });
  await home.click();
  const welcomeLogo = page.locator(".welcome-emblem");
  await expect(welcomeLogo).toBeVisible();
  const logoSize = await welcomeLogo.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, top: bounds.top, loaded: (element as HTMLImageElement).naturalWidth > 0 };
  });
  expect(logoSize.loaded).toBe(true);
  expect(logoSize.width).toBeLessThanOrEqual(144);
  expect(logoSize.top).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Close Welcome tab" }).click();
  await expect(page.getByText("No editor tab open")).toBeVisible();
  await home.click();
  await expect(page.getByRole("tab", { name: "Welcome" })).toHaveAttribute("aria-selected", "true");

  await page.getByLabel("Import evidence files").setInputFiles({
    name: "sidebar.js",
    mimeType: "text/javascript",
    buffer: Buffer.from("function sample() { return 'ready'; }")
  });
  await expect(page.locator(".job-status.done")).toBeVisible();
  const investigation = page.getByRole("tablist", { name: "Investigation tools" });
  const tabs = investigation.getByRole("tab");
  await expect(tabs).toHaveCount(6);
  await expect(page.locator(".inspector-evidence-context")).toContainText("sidebar.js");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tabs.nth(5)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
});
