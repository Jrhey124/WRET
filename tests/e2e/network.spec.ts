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
