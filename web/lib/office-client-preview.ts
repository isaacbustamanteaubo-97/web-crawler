/** Formatos con vista previa en el navegador (sin Google ni LibreOffice). */
export type OfficeClienteTipo = "docx" | "hoja";

const EXT_DOCX = new Set(["docx"]);
const EXT_HOJA = new Set(["xls", "xlsx", "xlsm", "xlsb", "ods"]);

export function extDeNombreArchivo(nombre: string): string {
  const i = nombre.lastIndexOf(".");
  return i >= 0 ? nombre.slice(i + 1).toLowerCase() : "";
}

export function officeClienteTipo(nombre: string): OfficeClienteTipo | null {
  const e = extDeNombreArchivo(nombre);
  if (EXT_DOCX.has(e)) return "docx";
  if (EXT_HOJA.has(e)) return "hoja";
  return null;
}

export function etiquetaOfficeCliente(tipo: OfficeClienteTipo): string {
  return tipo === "docx" ? "Word" : "Excel / hoja de cálculo";
}
