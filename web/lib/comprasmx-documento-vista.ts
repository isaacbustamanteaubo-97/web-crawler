/** Utilidades compartidas para vista previa de anexos en el front. */

export function extDeNombreArchivo(nombre: string): string {
  const i = nombre.lastIndexOf(".");
  return i >= 0 ? nombre.slice(i + 1).toLowerCase() : "";
}

export function esZipAnexoListado(nombre: string): boolean {
  return nombre.toLowerCase().endsWith(".zip");
}

export function categoriaVistaDocumento(nombre: string): "pdf" | "imagen" | "texto" | "otro" {
  const e = extDeNombreArchivo(nombre);
  if (e === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)) return "imagen";
  if (["txt", "csv", "json", "xml", "log", "md"].includes(e)) return "texto";
  return "otro";
}

export function claveDocumentoExport(expediente: string, nombre: string): string {
  return `${expediente}\u0001${nombre}`;
}
