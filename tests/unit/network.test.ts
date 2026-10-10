import { describe, it, expect } from "vitest";
import {
  publicAddress,
  approvedOrigin,
  brokerRequest,
} from "../../companion/network";
describe("VM network broker boundary", () => {
  it("rejects loopback, private, link-local, multicast, metadata and transition addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "198.18.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fe80::1",
      "fc00::1",
      "2001:db8::1",
      "2002:7f00:1::",
    ])
      expect(publicAddress(address), address).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("requires explicit HTTP origin approvals and standard ports", () => {
    expect(approvedOrigin("https://example.com/a")).toBe("https://example.com");
    for (const origin of [
      "file:///etc/passwd",
      "https://user:pass@example.com",
      "http://localhost",
      "http://test.local",
      "https://example.com:8443",
      "http://example.com:443",
      "https://example.com:80",
    ])
      expect(() => approvedOrigin(origin)).toThrow();
  });
  it("blocks unapproved and private destinations before making a request", async () => {
    await expect(
      brokerRequest({ url: "https://example.com" }, new Set()),
    ).rejects.toThrow("not been approved");
    await expect(
      brokerRequest({ url: "http://127.0.0.1" }, new Set(["http://127.0.0.1"])),
    ).rejects.toThrow("destination rejected");
  });
});
