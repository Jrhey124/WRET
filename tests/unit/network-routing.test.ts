import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
const mock = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mock.lookup }));
vi.mock("node:http", () => ({ default: { request: mock.request } }));
vi.mock("node:https", () => ({ default: { request: mock.request } }));
import { brokerRequest } from "../../companion/network";
let response: EventEmitter & {
  headers: any;
  statusCode: number;
  destroy: () => void;
};
beforeEach(() => {
  mock.lookup.mockReset();
  mock.request.mockReset();
  mock.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  response = Object.assign(new EventEmitter(), {
    headers: {},
    statusCode: 200,
    destroy: vi.fn(),
  });
  mock.request.mockImplementation((_url, _options, callback) => {
    const request = Object.assign(new EventEmitter(), {
      end: () => {
        callback(response);
        queueMicrotask(() => {
          response.emit("data", Buffer.from("fixture"));
          response.emit("end");
        });
      },
      destroy: vi.fn(),
    });
    return request;
  });
});
describe("broker DNS pinning, redirects and capture limits", () => {
  it("rejects an entire DNS answer when any address is private", async () => {
    mock.lookup.mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(
      brokerRequest(
        { url: "https://approved.example" },
        new Set(["https://approved.example"]),
      ),
    ).rejects.toThrow("destination rejected");
    expect(mock.request).not.toHaveBeenCalled();
  });
  it("pins the validated address and leaves redirects for a separately approved request", async () => {
    response.statusCode = 302;
    response.headers = { location: "https://other.example/resource" };
    const result = await brokerRequest(
      { url: "https://approved.example/start" },
      new Set(["https://approved.example"]),
    );
    expect(result.status).toBe(302);
    expect(mock.request).toHaveBeenCalledTimes(1);
    const options = mock.request.mock.calls[0][1],
      resolved = vi.fn();
    options.lookup("approved.example", {}, resolved);
    expect(resolved).toHaveBeenCalledWith(null, "1.1.1.1", 4);
    await expect(
      brokerRequest(
        { url: "https://other.example/resource" },
        new Set(["https://approved.example"]),
      ),
    ).rejects.toThrow("not been approved");
  });
  it("rejects transfers above 25 MiB and removes hop-by-hop request headers", async () => {
    mock.request.mockImplementation((_url, _options, callback) =>
      Object.assign(new EventEmitter(), {
        end: () => {
          callback(response);
          queueMicrotask(() =>
            response.emit("data", Buffer.alloc(25 * 1024 * 1024 + 1)),
          );
        },
        destroy: vi.fn(),
      }),
    );
    await expect(
      brokerRequest(
        {
          url: "https://approved.example",
          headers: {
            Host: "localhost",
            Connection: "upgrade",
            "Proxy-Authorization": "secret",
          },
        },
        new Set(["https://approved.example"]),
      ),
    ).rejects.toThrow("exceeds 25 MiB");
    expect(mock.request.mock.calls[0][1].headers).toEqual({
      "accept-encoding": "identity",
    });
    expect(response.destroy).toHaveBeenCalled();
  });
  it("delivers larger resources but retains only the first 1 MiB as response evidence", async () => {
    mock.request.mockImplementation((_url, _options, callback) =>
      Object.assign(new EventEmitter(), {
        end: () => {
          callback(response);
          queueMicrotask(() => {
            response.emit("data", Buffer.alloc(1024 * 1024 + 10));
            response.emit("end");
          });
        },
        destroy: vi.fn(),
      }),
    );
    const result = await brokerRequest(
      { url: "https://approved.example" },
      new Set(["https://approved.example"]),
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.from(result.capturedBody, "base64").length).toBe(1024 * 1024);
    expect(Buffer.from(result.body, "base64").length).toBe(1024 * 1024 + 10);
  });
});
