import { test, expect } from "@playwright/test";

test("beautifies without altering original evidence, safely renders local HTML, and hands off to Debug", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("evil.invalid")) externalRequests.push(request.url()); });
  await page.goto("/");
  await page.getByLabel("Import evidence files").setInputFiles([
    { name: "site/index.html", mimeType: "text/html", buffer: Buffer.from('<!doctype html><html><head><link rel="stylesheet" href="css/main.css"></head><body onload="window.bad=1"><script>window.bad=2</script><h1>Local page</h1><img src="img/pixel.png"><a href="https://evil.invalid">external</a></body></html>') },
    { name: "site/css/main.css", mimeType: "text/css", buffer: Buffer.from("h1{color:red}") },
    { name: "site/app.js", mimeType: "text/javascript", buffer: Buffer.from("const x={a:1};") },
    { name: "site/img/pixel.png", mimeType: "image/png", buffer: Buffer.from([137,80,78,71]) },
  ]);
  await expect(page.getByRole("button", { name: "Beautify" })).toBeEnabled();
  await page.getByRole("button", { name: /Commands.*Ctrl\+K/ }).click();
  const commands = page.getByRole("combobox", { name: "Search commands" });
  await commands.fill("Beautify selected evidence");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Beautified" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Copy beautified source" })).toBeVisible();
  await page.getByRole("tab", { name: "Original" }).click();
  await expect(page.locator(".monaco-editor")).toContainText("window.bad=2");
  await page.getByRole("tab", { name: "Render" }).click();
  const frame = page.frameLocator('iframe[title="Static HTML preview; scripts disabled"]');
  await expect(frame.getByRole("heading", { name: "Local page" })).toBeVisible();
  await expect.poll(() => frame.locator("body").evaluate((body) => (body.ownerDocument.defaultView as any).bad)).toBeUndefined();
  await expect(page.getByText(/Scripts, forms, navigation, external requests/)).toBeVisible();
  const html = await page.locator('iframe[title="Static HTML preview; scripts disabled"]').getAttribute("srcdoc");
  expect(html).not.toContain("<script"); expect(html).not.toContain("onload="); expect(html).not.toContain("evil.invalid");
  expect(html).toContain("data:image/png;base64,"); expect(html).toContain("color:red");
  expect(externalRequests).toEqual([]);
  await page.getByRole("button", { name: "Interactive preview in VM" }).click();
  await expect(page.getByRole("combobox", { name: "Debug entrypoint" })).toHaveValue("site/index.html");
  await page.getByText(/Evidence sent to the VM/).click();
  await expect(page.getByRole("checkbox", { name: "site/index.html" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "site/css/main.css" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeVisible();
});
