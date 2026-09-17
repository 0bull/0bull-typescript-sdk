import type { Transport } from "../core.js";
import type { HttpTransport } from "../http.js";

/** A resource runs operations on its transport (REST or socket); `http` serves signed uploads. */
export abstract class Resource {
  constructor(
    protected readonly transport: Transport,
    protected readonly http: HttpTransport,
  ) {}
}
