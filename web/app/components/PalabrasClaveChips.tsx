"use client";

import { useCallback, useId, useState, type KeyboardEvent } from "react";
import {
  PALABRA_CLAVE_MAX_CHARS,
  PALABRAS_CLAVE_MAX_COUNT,
  validarNuevaPalabraClave,
} from "@/lib/palabras-clave";

type Props = {
  palabras: string[];
  onChange: (next: string[]) => void;
};

export function PalabrasClaveChips({ palabras, onChange }: Props) {
  const inputId = useId();
  const errorId = useId();
  const [borrador, setBorrador] = useState("");
  const [error, setError] = useState<string | null>(null);

  const intentarAgregar = useCallback(() => {
    const v = validarNuevaPalabraClave(borrador, palabras);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    onChange([...palabras, v.valor]);
    setBorrador("");
    setError(null);
  }, [borrador, onChange, palabras]);

  const quitar = useCallback(
    (indice: number) => {
      onChange(palabras.filter((_, i) => i !== indice));
      setError(null);
    },
    [onChange, palabras],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      intentarAgregar();
    }
  };

  const vacias = palabras.length === 0;
  const alLimite = palabras.length >= PALABRAS_CLAVE_MAX_COUNT;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <label htmlFor={inputId} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Palabras clave
        </label>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Cada chip es un término aislado en el arreglo <code className="text-[11px]">palabrasClave</code> del API.
        </p>
      </div>

      <div
        className={`min-h-[3.25rem] rounded-lg border bg-white p-2 dark:bg-zinc-900 ${
          vacias ? "border-amber-500 dark:border-amber-600" : "border-zinc-300 dark:border-zinc-700"
        }`}
        aria-invalid={vacias}
      >
        {palabras.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Palabras clave agregadas">
            {palabras.map((p, i) => (
              <li key={`${p}-${i}`}>
                <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 py-0.5 pl-2.5 pr-1 text-sm text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100">
                  <span className="truncate">{p}</span>
                  <button
                    type="button"
                    onClick={() => quitar(i)}
                    className="rounded-full p-0.5 text-emerald-800 hover:bg-emerald-200/80 dark:text-emerald-200 dark:hover:bg-emerald-900"
                    aria-label={`Quitar «${p}»`}
                  >
                    <span aria-hidden>×</span>
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-1 py-1 text-xs text-amber-800 dark:text-amber-200">
            Agrega al menos una palabra clave para poder buscar.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start">
        <input
          id={inputId}
          type="text"
          value={borrador}
          maxLength={PALABRA_CLAVE_MAX_CHARS + 8}
          disabled={alLimite}
          placeholder={alLimite ? "Límite de palabras alcanzado" : "Ej. Jardinería, Control de plagas…"}
          onChange={(e) => {
            setBorrador(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          aria-describedby={error ? errorId : undefined}
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 disabled:opacity-60"
        />
        <button
          type="button"
          disabled={alLimite}
          onClick={intentarAgregar}
          className="shrink-0 rounded-lg border border-violet-600 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-900 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-500 dark:bg-violet-950/40 dark:text-violet-200 dark:hover:bg-violet-900/50"
        >
          Agregar palabra
        </button>
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
        {palabras.length} / {PALABRAS_CLAVE_MAX_COUNT} · Enter o «Agregar palabra» · sin duplicados (ignora mayúsculas y
        acentos)
      </p>
    </div>
  );
}
