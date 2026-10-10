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
}
export interface Capabilities {
  available: boolean;
  ready: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}
export interface SessionInput {
  exceptionState?: "none" | "uncaught" | "all";
  target: string;
  entry?: string;
  files: { id: string; name: string; bytes: string }[];
  breakpoints: Breakpoint[];
  approvals: string[];
}
export type DebugCommand = (
  | {
      action:
        | "pause"
        | "resume"
        | "stepInto"
        | "stepOver"
        | "stepOut"
        | "stop"
        | "extend";
    }
  | { action: "breakpoint"; breakpoint: Breakpoint }
  | { action: "removeBreakpoint"; id: string }
  | { action: "exceptions"; state: "none" | "uncaught" | "all" }
  | { action: "evaluate"; expression: string; callFrameId?: string }
  | { action: "properties"; objectId: string }
  | { action: "approve"; origin: string }
  | { action: "snapshot"; scopes: { name: string; objectId: string }[] }
  | { action: "pausePolicy"; skip: boolean }
  | { action: "liveEdit"; url: string; source: string; dryRun: boolean }
  | {
      action: "input";
      type:
        "mousePressed" | "mouseReleased" | "mouseMoved" | "keyDown" | "keyUp";
      x?: number;
      y?: number;
      key?: string;
      text?: string;
    }
) & { target?: string };
