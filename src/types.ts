// Response shapes mirror the API. Enum-like fields are typed `string` so values the API adds
// later still type-check; the documented values are exported as unions for inputs.

export type Platform = "tiktok" | "instagram" | "youtube";

export interface User {
  id: number;
  name: string;
  email: string;
  email_verified_at: string | null;
}

export interface Account {
  id: string;
  platform: string;
  handle: string | null;
  slot: string | null;
  notes: string | null;
  google_email?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export const HOTKEYS = [
  "home",
  "app_switcher",
  "control_center",
  "notifications",
  "back",
  "run_shortcut",
  "enter",
  "backspace",
  "copy",
  "cut",
  "paste",
  "select_all",
] as const;
export type Hotkey = (typeof HOTKEYS)[number];

export type CommandOp =
  | "clipboard_set"
  | "clipboard_get"
  | "open_url"
  | "reboot"
  | "clear_photos"
  | "get_ip"
  | "brightness"
  | "wifi"
  | "airplane"
  | "cellular"
  | "flashlight";

export type MacroParams = Record<string, string | number | boolean>;

export interface Phone {
  slot: string;
  name: string;
  video_live: boolean;
  input_present: boolean;
  can_control: boolean;
  model: string | null;
  os_version: string | null;
}

export type RunKind = "macro" | "command" | "agent";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export interface Run {
  id: string;
  slot: string;
  kind: string;
  status: string;
  label: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: the API leaves run results open.
  result: Record<string, any> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
}

export type SubmissionStatus =
  | "scheduled"
  | "pending"
  | "ingesting"
  | "driving"
  | "published"
  | "drafted"
  | "failed"
  | "cancelled";
export const TERMINAL_SUBMISSION_STATUSES: ReadonlySet<string> = new Set([
  "published",
  "drafted",
  "failed",
  "cancelled",
]);

export interface SubmissionFailure {
  step: string | null;
  message: string;
}

export interface Submission {
  id: number;
  platform: string;
  account_id: string | null;
  caption: string | null;
  draft: boolean;
  status: string;
  attempts: number;
  failure: SubmissionFailure | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface UploadURL {
  upload_id: string;
  upload_url: string;
  expires_at: string;
}

export type BillingRequestStatus = "pending" | "approved" | "declined" | "failed" | "expired";

export interface PendingOrder {
  id: number;
  country: string;
  phones: number;
  availability: string;
  placed_at: string;
}

export interface BillingLine {
  id: number;
  status: string;
  cancelling: boolean;
  renews_at: string | null;
}

export interface BillingSummary {
  subscribed: boolean;
  phones: number;
  price_per_phone: number;
  monthly?: number | null;
  on_grace_period?: boolean | null;
  pending_orders: PendingOrder[];
  lines?: BillingLine[];
  hint?: string | null;
}

export interface RentalItem {
  country: string;
  quantity: number;
}

export interface Rental {
  checkout_url: string;
  phones: number;
  items: RentalItem[];
  next: string;
}

export interface PhoneCountChange {
  applied: boolean;
  request_id: string;
  from_phones: number;
  to_phones: number;
  next: string;
  approval_url?: string | null;
  charge_now?: number | null;
  charge_on_assignment?: number | null;
  monthly_after?: number | null;
  pricing_unavailable?: boolean | null;
  expires_at?: string | null;
}

export interface BillingRequest {
  request_id: string;
  status: string;
  to_phones: number;
  approval_url: string;
  expires_at: string;
  resolved_at: string | null;
}

export interface SessionPhone {
  id: string;
  name: string;
  video_live: boolean;
  input_present: boolean;
  can_control: boolean;
  model: string | null;
  os_version: string | null;
}

export interface ControllerSession {
  phones: SessionPhone[];
  socket_url: string;
  farm_online: boolean;
}

/** A push from the WebSocket. */
export type Event =
  | { type: "run"; run: Run }
  | { type: "submission"; submission: Submission }
  | { type: "billing_request"; request: BillingRequest };
