import { type ClientOptions, HttpTransport } from "./http.js";
import { Accounts } from "./resources/accounts.js";
import { Billing } from "./resources/billing.js";
import { Phones } from "./resources/phones.js";
import { Runs } from "./resources/runs.js";
import { SessionResource } from "./resources/session.js";
import { Submissions } from "./resources/submissions.js";
import { Uploads } from "./resources/uploads.js";
import { UserResource } from "./resources/user.js";
import { Socket, type SocketOptions } from "./socket.js";

/** 0bull REST client. */
export class ZeroBull {
  readonly user: UserResource;
  readonly accounts: Accounts;
  readonly uploads: Uploads;
  readonly submissions: Submissions;
  readonly phones: Phones;
  readonly runs: Runs;
  readonly billing: Billing;
  readonly session: SessionResource;
  readonly #http: HttpTransport;

  constructor(options: ClientOptions = {}) {
    const http = new HttpTransport(options);
    this.#http = http;
    this.user = new UserResource(http, http);
    this.accounts = new Accounts(http, http);
    this.uploads = new Uploads(http, http);
    this.submissions = new Submissions(http, http);
    this.phones = new Phones(http, http);
    this.runs = new Runs(http, http);
    this.billing = new Billing(http, http);
    this.session = new SessionResource(http, http);
  }

  /** Create an unconnected socket; call `connect()` before using it. */
  socket(options: SocketOptions = {}): Socket {
    return new Socket(this.#http, options);
  }
}
