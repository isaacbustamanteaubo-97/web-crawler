/** Límites alineados con el formulario Compras MX en el front. */
export const PALABRA_CLAVE_MIN_CHARS = 2;
export const PALABRA_CLAVE_MAX_CHARS = 120;
export const PALABRAS_CLAVE_MAX_COUNT = 40;

/** Comparación sin mayúsculas ni acentos para detectar duplicados. */
export function clavePalabraClave(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function normalizarPalabraClave(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export type ValidacionPalabraClave =
  | { ok: true; valor: string }
  | { ok: false; error: string };

export function validarNuevaPalabraClave(
  raw: string,
  existentes: readonly string[],
): ValidacionPalabraClave {
  const valor = normalizarPalabraClave(raw);
  if (!valor) {
    return { ok: false, error: "Escribe una palabra o frase antes de agregar." };
  }
  if (/\r|\n/.test(raw)) {
    return { ok: false, error: "Solo se agrega un término a la vez (sin saltos de línea)." };
  }
  if (valor.length < PALABRA_CLAVE_MIN_CHARS) {
    return {
      ok: false,
      error: `Mínimo ${PALABRA_CLAVE_MIN_CHARS} caracteres (sin contar espacios al inicio o final).`,
    };
  }
  if (valor.length > PALABRA_CLAVE_MAX_CHARS) {
    return {
      ok: false,
      error: `Máximo ${PALABRA_CLAVE_MAX_CHARS} caracteres por palabra clave.`,
    };
  }
  if (!/\p{L}/u.test(valor)) {
    return { ok: false, error: "Debe incluir al menos una letra." };
  }
  if (existentes.length >= PALABRAS_CLAVE_MAX_COUNT) {
    return {
      ok: false,
      error: `No puedes agregar más de ${PALABRAS_CLAVE_MAX_COUNT} palabras clave.`,
    };
  }
  const clave = clavePalabraClave(valor);
  if (existentes.some((e) => clavePalabraClave(e) === clave)) {
    return { ok: false, error: "Esa palabra clave ya está en la lista." };
  }
  return { ok: true, valor };
}
