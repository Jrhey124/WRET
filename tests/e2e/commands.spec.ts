import { test, expect } from "@playwright/test";

test("command palette filters, navigates by keyboard, closes accessibly, and preserves editing shortcuts", async ({ page }) => {
  await page.goto("/");
  const projectName = page.getByLabel("Project name");
  await projectName.focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await expect(projectName).toBeFocused();

  const trigger = page.getByRole("button", { name: /Commands.*Ctrl\+K/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const search = page.getByRole("combobox", { name: "Search commands" });
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
  await expect(page.getByRole("option", { name: /Open or show Welcome tab/ })).toBeVisible();
  for (let index = 0; index < 10; index += 1) await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.locator(".command-list").evaluate((list) => list.scrollTop)).toBeGreaterThan(0);
  const selectedVisible = await page.locator(".command-list").evaluate((list) => {
    const selected = list.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!selected) return false;
    const listBounds = list.getBoundingClientRect();
    const optionBounds = selected.getBoundingClientRect();
    return optionBounds.top >= listBounds.top && optionBounds.bottom <= listBounds.bottom;
  });
  expect(selectedVisible).toBe(true);
  await search.fill("there is no matching command");
  await expect(page.getByText(/No commands match/)).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);
  await search.fill("debug");
  const debug = page.getByRole("option", { name: /Go to Debug/ });
  await expect(debug).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(debug).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Investigation workflow" }).getByRole("button", { name: "Debug", exact: true })).toHaveClass(/active/);
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Control+k");
  await expect(search).toBeFocused();
  await expect(page.getByRole("option", { name: /Close Welcome tab/ })).toHaveAttribute("aria-disabled", "false");
  await search.fill("");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Go to Inspect/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Investigation workflow" }).getByRole("button", { name: "Inspect", exact: true })).toHaveClass(/active/);

  await page.getByRole("button", { name: "Commands · Ctrl+K" }).click();
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Commands · Ctrl+K" })).toBeFocused();

  const selection = await page.locator(".welcome h1").evaluate((element) => getComputedStyle(element, "::selection").backgroundColor);
  expect(selection).toBe("rgb(199, 220, 233)");
});
