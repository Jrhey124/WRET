import { describe, expect, it } from "vitest";
import { acquireWorker } from "../../src/worker-queue";
describe("sample worker budget", () => {
  it("serializes jobs, skips cancelled waiters, and releases each slot once", async () => {
    const release = await acquireWorker();
    const controller = new AbortController();
    const cancelled = acquireWorker(controller.signal);
    const rejection = expect(cancelled).rejects.toThrow("cancelled");
    let started = false;
    const next = acquireWorker().then(release => { started = true; return release; });
    controller.abort(); await rejection;
    await Promise.resolve(); expect(started).toBe(false);
    release(); release();
    const finish = await next; expect(started).toBe(true); finish();
    (await acquireWorker())();
  });
});
