export const CAPTURE_LIMIT = 50 * 1024 * 1024;
export interface Breakpoint {
  id: string;
  url: string;
  line: number;
  condition: string;
}
export interface Observation {
  sequence: number;
  time: string;
  kind: string;
  data: unknown;
}
export interface WasmStringDecoder {
  direction: "js-to-wasm" | "wasm-to-js";
  functionName: string;
  memoryName: string;
  pointerArgument: number;
  lengthArgument?: number;
}
export interface CapturedRequest {
  id: string;
  requestId: string;
  sequence: number;
  startTimestamp?: number;
  url: string;
  method: string;
  resourceType?: string;
  startedAt: string;
  durationMs?: number;
  status?: number;
  mimeType?: string;
  transferBytes?: number;
  requestHeaders?: { name: string; value: string }[];
  responseHeaders?: { name: string; value: string }[];
  requestPayloadAvailable?: boolean;
  initiator?: { type?: string; url?: string; line?: number; column?: number };
  frameId?: string;
  targetType?: string;
  blockedReason?: string;
  redirectFrom?: string;
  evidenceId?: string;
  truncated?: boolean;
}
export interface DebugSession {
  id: string;
  createdAt: string;
  target: string;
  status:
    "starting" | "running" | "paused" | "stopped" | "failed" | "disconnected";
  approvals: string[];
  observations: Observation[];
  requests?: CapturedRequest[];
  capturedBytes: number;
  truncated: boolean;
  wasmBridgeMonitor?: boolean;
  wasmModuleCapture?: boolean;
  wasmStringDecoders?: WasmStringDecoder[];
}
