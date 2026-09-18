type ReadResult<T> = {
  data: T;
  error: { code?: string } | null;
  status: number;
};

export class DatabaseReadError extends Error {
  readonly status: 500 | 503;
  constructor(transient: boolean) {
    super(
      transient
        ? "The database is temporarily unavailable. Please try again."
        : "Your desk could not be loaded. Please retry; if this continues, contact support.",
    );
    this.status = transient ? 503 : 500;
  }
}

function isTransient(status: number, code: string) {
  return (
    status === 0 ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    /^08|^53|^57P0[123]$|^PGRST00[0-3]$/.test(code)
  );
}

// Retry only read operations. A timed-out write may already have committed.
export async function readDatabase<T>(
  operation: string,
  query: () => PromiseLike<ReadResult<T>>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const result = await query();
    if (!result.error) return result.data;
    const code = result.error.code || "unknown";
    const transient = isTransient(result.status, code);
    // Never log query values, credentials, database error text or record contents.
    console.warn("Database read unsuccessful", {
      operation,
      code: /^[A-Z0-9]{1,16}$/.test(code) ? code : "unknown",
      status: result.status,
      attempt,
    });
    if (!transient || attempt === 3) throw new DatabaseReadError(transient);
    await new Promise((resolve) =>
      setTimeout(resolve, attempt === 1 ? 150 : 450),
    );
  }
}
