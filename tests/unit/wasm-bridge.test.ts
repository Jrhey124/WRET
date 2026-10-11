import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import wabtFactory from "wabt";

describe("guest WebAssembly bridge instrumentation", () => {
  it("captures both call directions and explicitly configured bounded UTF-8 memory decodes", async () => {
    const guest = await readFile(new URL("../../guest/agent.py", import.meta.url), "utf8");
    const source = guest.match(/BRIDGE_INSTALL = r'''([\s\S]*?)'''/)?.[1];
    expect(source).toBeTruthy();
    const decoders = [{ direction: "wasm-to-js", functionName: "env.log", memoryName: "env.memory", pointerArgument: 0, lengthArgument: 1 }];
    const events: any[] = [];
    const context = vm.createContext({
      __whidraBridgeEvent: (payload: string) => events.push(JSON.parse(payload)),
      performance,
      TextDecoder,
      SharedArrayBuffer,
    });
    vm.runInContext("globalThis.memory = new WebAssembly.Memory({initial: 1}); new Uint8Array(memory.buffer).set([87,105,100,114,97]);", context);
    const instrumented = source!.replace("__WHIDRA_WASM_DECODERS__", JSON.stringify(decoders));
    vm.runInContext(instrumented, context);
    const wabt = await wabtFactory();
    const module = wabt.parseWat("bridge.wat", '(module (import "env" "memory" (memory 1)) (import "env" "log" (func $log (param i32 i32))) (func (export "send") i32.const 0 i32.const 5 call $log))');
    const bytes = Array.from(new Uint8Array(module.toBinary({ write_debug_names: false }).buffer));
    module.destroy();
    context.bytes = bytes;
    context.importedLog = () => {};
    const instantiated = await vm.runInContext("WebAssembly.instantiate(new Uint8Array(bytes), {env:{memory,log:importedLog}})", context);
    context.instance = instantiated.instance;
    vm.runInContext("instance.exports.send()", context);
    expect(events.some((event) => event.phase === "enter" && event.direction === "js-to-wasm" && event.function === "send"), JSON.stringify(events)).toBe(true);
    const boundary = events.find((event) => event.phase === "enter" && event.direction === "wasm-to-js" && event.function === "env.log");
    expect(boundary.args).toEqual([0, 5]);
    expect(boundary.decodedArguments[0]).toMatchObject({ memoryName: "env.memory", text: "Widra", bytes: 5, truncated: false });
    expect(events.some((event) => event.phase === "memoryAvailable" && event.memoryName === "env.memory")).toBe(true);
  });
});
