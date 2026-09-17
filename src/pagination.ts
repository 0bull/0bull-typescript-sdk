import type { PageData } from "./core.js";

/** One page of results. `for await` over a page walks it and every following page. */
export class Page<T> implements AsyncIterable<T> {
  readonly items: T[];
  readonly currentPage: number;
  readonly lastPage: number;
  readonly perPage: number;
  readonly total: number;
  readonly #fetch: (page: number) => Promise<Page<T>>;

  constructor(data: PageData<T>, fetch: (page: number) => Promise<Page<T>>) {
    this.items = data.items;
    this.currentPage = data.current_page;
    this.lastPage = data.last_page;
    this.perPage = data.per_page;
    this.total = data.total;
    this.#fetch = fetch;
  }

  hasNextPage(): boolean {
    return this.currentPage < this.lastPage;
  }

  /** Fetch the next page, or `null` on the last page. */
  async nextPage(): Promise<Page<T> | null> {
    return this.hasNextPage() ? this.#fetch(this.currentPage + 1) : null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page: Page<T> | null = this;
    while (page) {
      yield* page.items;
      page = await page.nextPage();
    }
  }
}
