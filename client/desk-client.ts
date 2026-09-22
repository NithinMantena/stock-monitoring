export class DeskError extends Error {
  code: string;
  status: number;
  requestKey?: string;
  constructor(message: string, code: string, status = 0, requestKey?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.requestKey = requestKey;
  }
}
export type RequestOptions = {
  body?: unknown;
  key?: string;
  signal?: AbortSignal;
  text?: boolean;
};
export class DeskClient {
  base: string;
  private token: () => string;
  private fetcher: typeof fetch;
  constructor(
    base: string,
    token: () => string = () => "",
    fetcher: typeof fetch = fetch,
  ) {
    this.token = token;
    this.fetcher = fetcher;
    this.base = base.replace(/\/$/, "");
    if (!this.base.startsWith("/")) {
      const url = new URL(this.base);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(url.hostname)
          ))
      )
        throw new Error("Use an HTTPS API URL or a loopback development API.");
    }
  }
  async request<T = any>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      /(^|\/)\.\.?(\/|$)/.test(path)
    )
      throw new Error("Invalid API path.");
    const write = method !== "GET",
      key = write ? options.key || crypto.randomUUID() : undefined;
    let response: Response;
    try {
      const signals = [
        AbortSignal.timeout(write ? 120000 : 30000),
        ...(options.signal ? [options.signal] : []),
      ];
      const token = this.token();
      response = await this.fetcher(this.base + path, {
        method,
        redirect: "error",
        signal: AbortSignal.any(signals),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
    } catch {
      throw new DeskError(
        write
          ? `The write result is uncertain. Refresh the record before retrying; reuse request key ${key}.`
          : "Could not connect to Research Desk. Check your connection and retry.",
        write ? "write_outcome_unknown" : "connection_failed",
        0,
        key,
      );
    }
    if (!response.ok) {
      const json = await response.json().catch(() => null);
      throw new DeskError(
        json?.error ||
          (response.status === 401
            ? "Your session expired. Please sign in again."
            : `Research Desk is temporarily unavailable (${response.status}). Please retry.`),
        json?.code || "http_error",
        response.status,
        key,
      );
    }
    if (options.text) return (await response.text()) as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new DeskError(
        "The server returned an unreadable response. Inspect current state before retrying a write.",
        "invalid_response",
        response.status,
        key,
      );
    }
  }
}
