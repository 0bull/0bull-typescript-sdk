import { asObject, unwrap } from "../core.js";
import type { User } from "../types.js";
import { Resource } from "./resource.js";

export class UserResource extends Resource {
  /** Get the authenticated user. REST only. */
  get(): Promise<User> {
    return this.transport.execute({
      rest: { method: "GET", path: "/user" },
      parseRest: (response) => asObject<User>(unwrap(response)),
    });
  }
}
