export type RunEntry = {
  id: number;
  label: string;
  ok: boolean;
  detail: string;
  at: number;
};

/**
 * The SDK rejects with EIP-1193 `{ code, message }`, bare `{ error }` objects
 * and Errors; each is turned into text a tester can act on.
 */
export function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const {
      code,
      message,
      error: detail,
    } = error as { code?: unknown; message?: unknown; error?: unknown };
    if (typeof message === "string" && code !== undefined) {
      return `${String(code)}: ${message}`;
    }
    if (typeof message === "string") return message;
    if (typeof detail === "string") return detail;
  }
  return String(error);
}

export function createRunLog() {
  let entries: RunEntry[] = [];
  let nextId = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const record = (label: string, ok: boolean, detail: string): RunEntry => {
    const entry = { id: nextId++, label, ok, detail, at: Date.now() };
    entries = [entry, ...entries];
    notify();
    return entry;
  };

  return {
    entries: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    record,
    async run(label: string, action: () => Promise<string>): Promise<RunEntry> {
      try {
        return record(label, true, await action());
      } catch (error) {
        return record(label, false, describeError(error));
      }
    },
    clear() {
      entries = [];
      notify();
    },
  };
}

export type RunLog = ReturnType<typeof createRunLog>;
