import { expect, test } from "@playwright/test";

test("imports HAR captures offline and opens linked response evidence", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) externalRequests.push(request.url());
  });
  await page.goto("/");
  const har = {
    log: {
      version: "1.2",
      creator: { name: "WRET fixture", version: "1" },
      entries: [{
        startedDateTime: "2026-10-10T00:00:00.000Z",
        time: 24,
        request: {
          method: "GET",
          url: "https://example.invalid/api?token=secret",
          headers: [{ name: "Authorization", value: "Bearer secret" }],
        },
        response: {
          status: 200,
          statusText: "OK",
          headers: [{ name: "Content-Type", value: "application/json" }],
          content: { size: 15, mimeType: "application/json", text: '{"ok":true}' },
        },
      }],
    },
  };
  await page.getByLabel("Import HAR capture").setInputFiles({
    name: "fixture.har",
    mimeType: "application/har+json",
    buffer: Buffer.from(JSON.stringify(har)),
  });
  await expect(page.getByRole("heading", { name: "Network", exact: true })).toBeVisible();
  await expect(page.locator(".network-table")).toContainText("example.invalid/api?token=%5Bredacted%5D");
  await expect(page.locator(".network-table")).toContainText("200");
  await expect(page.locator(".network-table")).toContainText("fixture.har");
  await page.getByRole("tab", { name: "Response", exact: true }).click();
  await expect(page.locator(".network-response-body")).toContainText('"ok": true');
  await page.getByRole("button", { name: "Hex", exact: true }).click();
  await expect(page.locator(".network-response-body")).toContainText("00000000");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.locator(".network-response-body")).toContainText('{"ok":true}');
  await page.getByRole("button", { name: "Open response evidence" }).click();
  await expect(page.getByRole("navigation", { name: "Investigation workflow" }).getByRole("button", { name: "Inspect", exact: true })).toHaveAttribute("aria-current", "page");
  expect(externalRequests).toEqual([]);
});

test("keeps long request URLs inside details and displays bounded tooltips", async ({ page }) => {
  const longUrl = `https://example.invalid/${"very-long-path-segment-".repeat(75)}`;
  await page.goto("/");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const har = { log: { version: "1.2", creator: { name: "fixture", version: "1" }, entries: [{ startedDateTime: "2026-10-10T00:00:00.000Z", time: 1, request: { method: "GET", url: longUrl }, response: { status: 200, statusText: "OK", headers: [], content: { size: 0, mimeType: "text/plain", text: "" } } }] } };
  await page.getByLabel("Import HAR capture").setInputFiles({ name: "long-url.har", mimeType: "application/har+json", buffer: Buffer.from(JSON.stringify(har)) });
  const row = page.locator(".network-row-select").first();
  await row.evaluate((button) => button.setAttribute("aria-describedby", "existing-help"));
  await row.focus();
  await expect(page.locator(".global-tooltip")).toBeVisible();
  await expect(row).toHaveAttribute("aria-describedby", /existing-help/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".global-tooltip")).toHaveCount(0);
  await expect(row).toHaveAttribute("aria-describedby", "existing-help");
  await row.hover();
  const tooltip = page.locator(".global-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveCSS("position", "fixed");
  await expect(tooltip).not.toContainText("very-long-path-segment");
  const tipBounds = await tooltip.boundingBox();
  const viewport = page.viewportSize()!;
  expect(tipBounds).not.toBeNull();
  expect(tipBounds!.x).toBeGreaterThanOrEqual(0);
  expect(tipBounds!.y).toBeGreaterThanOrEqual(0);
  expect(tipBounds!.x + tipBounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(tipBounds!.y + tipBounds!.height).toBeLessThanOrEqual(viewport.height);
  await expect(row).toHaveAttribute("title", "Select request to inspect its captured details.");
  await row.click();
  const urlHeading = page.locator(".network-request-url");
  await expect(urlHeading).toHaveText(longUrl);
  await page.getByRole("button", { name: "Copy URL" }).click();
  await expect(page.getByRole("status")).toContainText("URL copied.");
  await page.setViewportSize({ width: 640, height: 720 });
  await row.hover();
  await expect(tooltip).toBeVisible();
  const narrowBounds = await tooltip.boundingBox();
  expect(narrowBounds).not.toBeNull();
  expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(narrowBounds!.y + narrowBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});
