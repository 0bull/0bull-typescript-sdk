import { asObject } from "../core.js";
import type { ControllerSession } from "../types.js";
import { Resource } from "./resource.js";

export class SessionResource extends Resource {
  /**
   * Create a phone-controller session: the phones you can use and a short-lived `socket_url`.
   * REST only. Most callers want `client.socket()` instead.
   */
  create(): Promise<ControllerSession> {
    return this.transport.execute({
      rest: { method: "GET", path: "/v1/phone-controller" },
      parseRest: (response) => asObject<ControllerSession>(response.json()),
    });
  }
}
