import { test, expect } from "@playwright/test";
test("real Windows VM: attach before execution, capture workers, isolate network and destroy guest", async ({
  page,
}) => {
  test.setTimeout(240000);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Investigation workflow" })
    .getByRole("button", { name: "Debug", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check companion / reconnect" })
    .click();
  const capabilities = await page.evaluate(async () => {
    const { token } = await (await fetch("/api/bootstrap")).json();
    return (
      await fetch("/api/capabilities", {
        headers: { Authorization: "Bearer " + token },
      })
    ).json();
  });
  expect(capabilities.ready, JSON.stringify(capabilities.checks)).toBe(true);
  const source =
    'const marker = "fresh";\nconsole.log(marker);\nnew Worker("worker.js");\nfetch("https://example.com/");';
  await page
    .getByLabel("Import evidence files", { exact: true })
    .setInputFiles([
      {
        name: "index.html",
        mimeType: "text/html",
        buffer: Buffer.from('<script src="app.js"></script>'),
      },
      {
        name: "app.js",
        mimeType: "text/javascript",
        buffer: Buffer.from(source),
      },
      {
        name: "worker.js",
        mimeType: "text/javascript",
        buffer: Buffer.from('console.log("worker captured");'),
      },
    ]);
  await page
    .getByRole("navigation", { name: "Investigation workflow" })
    .getByRole("button", { name: "Debug", exact: true })
    .click();
  await page.getByLabel("Debug entrypoint").selectOption("index.html");
  await page.getByLabel("Breakpoint URL").fill("http://127.0.0.1:8765/app.js");
  await page.getByLabel("Breakpoint line").fill("2");
  await page
    .getByRole("button", { name: "Add breakpoint", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(page.locator(".debug-toolbar strong").first()).toHaveText(
    "Paused",
    { timeout: 120000 },
  );
  await page.getByLabel("Watch expression").fill("marker");
  await page.getByRole("button", { name: "Evaluate in guest" }).click();
  await expect(
    page.locator(".debug-grid").getByText('"fresh"', { exact: false }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "step Over", exact: true }).click();
  await page.getByRole("button", { name: "resume", exact: true }).click();
  await expect(
    page
      .locator(".debug-workspace details")
      .filter({ hasText: "blocked" })
      .first(),
  ).toBeVisible({ timeout: 30000 });
  await page
    .locator(".debug-workspace details")
    .filter({ hasText: "worker captured" })
    .first()
    .locator("summary")
    .click();
  await expect(
    page
      .locator(".debug-workspace")
      .getByText("worker captured", { exact: false })
      .first(),
  ).toBeVisible();
  await expect(page.getByAltText("Guest browser preview")).toBeVisible();
  await page.getByRole("button", { name: "Stop and destroy VM" }).click();
  await expect(page.locator(".debug-toolbar strong").first()).toHaveText(
    "stopped",
  );
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(page.locator(".debug-toolbar strong").first()).toHaveText(
    "Paused",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: "Stop and destroy VM" }).click();
});
