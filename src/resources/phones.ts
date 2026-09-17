import {
  asObject,
  invalid,
  noContent,
  type Operation,
  pathSegment,
  requireRange,
  unwrap,
} from "../core.js";
import {
  type CommandOp,
  HOTKEYS,
  type Hotkey,
  type MacroParams,
  type Phone,
  type Run,
} from "../types.js";
import { Resource } from "./resource.js";
import { parseRun } from "./runs.js";

export interface PhoneImageParams {
  /** 120-2000. */
  width?: number;
}

export interface PhoneTapParams {
  /** 0-1. */
  fx: number;
  /** 0-1. */
  fy: number;
}

export interface PhoneSwipeParams {
  /** 0-1. */
  fx1: number;
  /** 0-1. */
  fy1: number;
  /** 0-1. */
  fx2: number;
  /** 0-1. */
  fy2: number;
  /** 1-500. */
  steps?: number;
}

export interface RunCommandParams {
  /** Required for `clipboard_set`. */
  text?: string;
  /** Required for `open_url`. */
  url?: string;
  /** Required for `brightness`; 0-1. */
  level?: number;
  /** Required for `wifi`, `airplane`, `cellular`, `flashlight`. */
  on?: boolean;
}

export interface RunMacroParams {
  /** Exactly one of `workflow` or `steps` is required. */
  workflow?: string;
  /** Only valid with `workflow`. */
  params?: MacroParams;
  /** At most 200 entries; each requires a string `action`. */
  steps?: Record<string, unknown>[];
}

const COMMAND_OPS: readonly CommandOp[] = [
  "clipboard_set",
  "clipboard_get",
  "open_url",
  "reboot",
  "clear_photos",
  "get_ip",
  "brightness",
  "wifi",
  "airplane",
  "cellular",
  "flashlight",
];

const REQUIRED_FIELD: Partial<Record<CommandOp, keyof RunCommandParams>> = {
  clipboard_set: "text",
  open_url: "url",
  brightness: "level",
  wifi: "on",
  airplane: "on",
  cellular: "on",
  flashlight: "on",
};

function asArray<T>(data: unknown): T[] {
  if (!Array.isArray(data)) throw new TypeError("Expected an array in the API response");
  return data as T[];
}

function input(slot: string, body: Record<string, unknown>): Operation<void> {
  return {
    rest: { method: "POST", path: `/v1/phones/${pathSegment(slot)}/input`, json: body },
    socket: { fun: "/app/phones/input", data: { slot, ...body } },
    parseRest: noContent,
    parseSocket: noContent,
  };
}

function run(slot: string, suffix: string, body: Record<string, unknown>): Operation<Run> {
  return {
    rest: { method: "POST", path: `/v1/phones/${pathSegment(slot)}/${suffix}`, json: body },
    socket: { fun: `/app/phones/${suffix}`, data: { slot, ...body } },
    ...parseRun,
  };
}

export class Phones extends Resource {
  /** List visible phones. */
  list(): Promise<Phone[]> {
    return this.transport.execute({
      rest: { method: "GET", path: "/v1/phones" },
      socket: { fun: "/app/phones/list", data: {} },
      parseRest: (response) => asArray<Phone>(unwrap(response)),
      parseSocket: (data) => asArray<Phone>(data),
    });
  }

  /** Capture the phone screen as a JPEG; width must be 120-2000. */
  snapshot(slot: string, params: PhoneImageParams = {}): Promise<Uint8Array> {
    requireRange("width", params.width, 120, 2000);
    return this.transport.execute({
      rest: {
        method: "GET",
        path: `/v1/phones/${pathSegment(slot)}/snapshot`,
        query: { width: params.width },
      },
      socket: { fun: "/app/phones/snapshot", data: { slot, width: params.width } },
      parseRest: (response) => response.bytes,
      parseSocket: (data) => Buffer.from(asObject<{ image: string }>(data).image, "base64"),
    });
  }

  /** Read on-screen text; width must be 120-2000. */
  ocr(slot: string, params: PhoneImageParams = {}): Promise<string> {
    requireRange("width", params.width, 120, 2000);
    return this.transport.execute({
      rest: {
        method: "GET",
        path: `/v1/phones/${pathSegment(slot)}/ocr`,
        query: { width: params.width },
      },
      socket: { fun: "/app/phones/ocr", data: { slot, width: params.width } },
      parseRest: (response) => asObject<{ text: string }>(response.json()).text,
      parseSocket: (data) => asObject<{ text: string }>(data).text,
    });
  }

  /** Tap at fractional screen coordinates (0-1). */
  tap(slot: string, params: PhoneTapParams): Promise<void> {
    requireRange("fx", params.fx, 0, 1);
    requireRange("fy", params.fy, 0, 1);
    return this.transport.execute(input(slot, { op: "tap", fx: params.fx, fy: params.fy }));
  }

  /** Swipe between fractional coordinates (0-1), using 1-500 steps if supplied. */
  swipe(slot: string, params: PhoneSwipeParams): Promise<void> {
    requireRange("fx1", params.fx1, 0, 1);
    requireRange("fy1", params.fy1, 0, 1);
    requireRange("fx2", params.fx2, 0, 1);
    requireRange("fy2", params.fy2, 0, 1);
    requireRange("steps", params.steps, 1, 500);
    return this.transport.execute(
      input(slot, {
        op: "swipe",
        fx1: params.fx1,
        fy1: params.fy1,
        fx2: params.fx2,
        fy2: params.fy2,
        steps: params.steps,
      }),
    );
  }

  /** Send a documented phone hotkey. */
  hotkey(slot: string, key: Hotkey): Promise<void> {
    if (!HOTKEYS.includes(key)) invalid("Unknown hotkey");
    return this.transport.execute(input(slot, { op: "hotkey", key }));
  }

  /** Type text on the phone. */
  type(slot: string, text: string): Promise<void> {
    return this.transport.execute(input(slot, { op: "type", text }));
  }

  /** Queue a command with its required text, URL, 0-1 level, or on value. */
  runCommand(slot: string, op: CommandOp, params: RunCommandParams = {}): Promise<Run> {
    if (!COMMAND_OPS.includes(op)) invalid("Unknown command op");
    const required = REQUIRED_FIELD[op];
    if (required !== undefined && params[required] === undefined) {
      invalid(`${op} requires ${required}`);
    }
    requireRange("level", params.level, 0, 1);
    return this.transport.execute(
      run(slot, "commands", {
        op,
        text: params.text,
        url: params.url,
        level: params.level,
        on: params.on,
      }),
    );
  }

  /** Queue one workflow with scalar params, or up to 200 action steps. */
  runMacro(slot: string, params: RunMacroParams = {}): Promise<Run> {
    if ((params.workflow === undefined) === (params.steps === undefined)) {
      invalid("Provide exactly one of workflow or steps");
    }
    if (params.params !== undefined) {
      if (params.workflow === undefined) invalid("params requires workflow");
      const bad = Object.values(params.params).some(
        (value) => !["string", "number", "boolean"].includes(typeof value),
      );
      if (bad) invalid("params values must be string, number, or boolean");
    }
    if (params.steps !== undefined) {
      if (params.steps.length > 200) invalid("steps must contain at most 200 entries");
      if (params.steps.some((step) => typeof step?.action !== "string")) {
        invalid("Each step requires a string action");
      }
    }
    return this.transport.execute(
      run(slot, "macros", {
        workflow: params.workflow,
        params: params.params,
        steps: params.steps,
      }),
    );
  }

  /** Queue an agent task containing 1-2000 characters. */
  runAgent(slot: string, task: string): Promise<Run> {
    if (task.length === 0 || task.length > 2000) invalid("task must contain 1-2000 characters");
    return this.transport.execute(run(slot, "agent-runs", { task }));
  }
}
