import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256, uid } from "../../src/model";

describe("crypto helpers on non-secure LAN origins", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates UUIDs when randomUUID is not exposed", () => {
    let generation = 0;
    vi.stubGlobal("crypto", {
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(++generation);
        return array;
      },
    });
    expect(uid()).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
    expect(uid()).not.toBe(uid());
  });

  it("retains SHA-256 integrity checks without SubtleCrypto", async () => {
    vi.stubGlobal("crypto", {});
    expect(await sha256(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
