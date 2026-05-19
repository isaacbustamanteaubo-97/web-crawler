/** Sin ningún evento NDJSON tras iniciar la consulta (portal lento o muchas filas). */
export const COMPRASMX_STREAM_CONEXION_INICIAL_MS = 600_000;

/** Sin eventos de progreso durante una descarga u otra fase larga. */
export const COMPRASMX_STREAM_SIN_AVANCE_MS = 30_000;

export class ComprasmxStreamStallError extends Error {
  constructor(message = "STREAM_STALL") {
    super(message);
    this.name = "ComprasmxStreamStallError";
  }
}

export function esErrorStallStream(err: unknown): boolean {
  return err instanceof ComprasmxStreamStallError || (err instanceof Error && err.message === "STREAM_STALL");
}

/**
 * Lee un chunk del body con límite de inactividad desde el último evento NDJSON procesado.
 */
export async function leerStreamConLimiteInactividad(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: {
    inactivityMs: number;
    getLastEventAt: () => number;
    signal?: AbortSignal;
  },
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const elapsed = Date.now() - opts.getLastEventAt();
  const waitMs = opts.inactivityMs - elapsed;
  if (waitMs <= 0) {
    throw new ComprasmxStreamStallError();
  }

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => reject(new ComprasmxStreamStallError()), waitMs);

    const onAbort = () => {
      clearTimeout(timer);
      reject(opts.signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    reader.read().then(
      (chunk) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(chunk);
      },
      (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** `fetch` con tiempo máximo total (p. ej. exportación o ZIP). */
export async function fetchComprasmxConTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const parent = init?.signal;
  if (parent) {
    if (parent.aborted) {
      throw parent.reason ?? new DOMException("Aborted", "AbortError");
    }
    parent.addEventListener("abort", () => ac.abort(parent.reason), { once: true });
  }
  const timer = setTimeout(() => ac.abort(new ComprasmxStreamStallError("FETCH_TIMEOUT")), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}
