import { test, expect } from "@playwright/test";
test("guided workflow preserves folder paths, links dependencies and maps, and remains usable without companion", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) external.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "WRET: Web-based Reverse Engineering Tool",
    }),
  ).toBeVisible();
  const inspectTab = page.getByRole("button", { name: "Inspect", exact: true });
  await inspectTab.focus();
  await expect(page.getByRole("tooltip")).toContainText("Browse evidence");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.evaluate(() => {
    const input = document.querySelector(
      'input[aria-label="Import site folder"]',
    ) as HTMLInputElement;
    const transfer = new DataTransfer();
    for (const [name, text] of Object.entries({
      "site/index.html":
        '<script src="app.js"></script><link rel="stylesheet" href="missing.css"><img src="https://example.invalid/pixel"><iframe src="https://example.invalid/frame"></iframe>',
      "site/app.js": 'const x = "a" + "b";\n//# sourceMappingURL=app.js.map',
      "site/app.js.map": JSON.stringify({
        version: 3,
        sources: ["original.js"],
        mappings: "AAAA",
      }),
      "site/original.js": 'const x = "ab";',
    })) {
      const file = new File([text], name.split("/").at(-1)!);
      Object.defineProperty(file, "webkitRelativePath", { value: name });
      transfer.items.add(file);
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(
    page.locator(".file-label").filter({ hasText: "site/index.html" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Investigation workflow" })
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(page.getByText("Missing imported dependency")).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect site/app.js", exact: true })
    .click();
  await page.getByText("Local source map navigation").click();
  await page
    .getByRole("button", { name: "Generated 1:1 → original.js byte 0" })
    .click();
  await expect(page.locator(".file-row.selected")).toContainText("original.js");
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "Investigation workflow" })
    .getByRole("button", { name: "Debug", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check companion / reconnect" })
    .click();
  await expect(
    page.locator(".debug-workspace").getByRole("alert"),
  ).toContainText("Start the local companion");
  await expect(
    page.getByRole("button", { name: "Start session", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("navigation", { name: "Investigation workflow" })
    .getByRole("button", { name: "Report", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Investigation report" }),
  ).toBeVisible();
  expect(external).toEqual([]);
});
