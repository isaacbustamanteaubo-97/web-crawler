import { type NextFunction, type Request, type Response, Router } from "express";
import { fetchComprasmxSnapshot, fechaIsoAMexicoDdMmYyyy, parseFechaFiltradoDdMmYyyy } from "../services/comprasmx.js";

export const comprasmxRouter = Router();

function firstQueryString(q: unknown): string | undefined {
  const raw = Array.isArray(q) ? q[0] : q;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** `undefined` si no viene query → usa reglas por defecto del servicio (dev = visible). */
function parseHeadedQuery(q: unknown): boolean | undefined {
  const raw = Array.isArray(q) ? q[0] : q;
  if (typeof raw !== "string") return undefined;
  const v = raw.toLowerCase();
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no", "headless"].includes(v)) return false;
  return undefined;
}

/** `fecha=DD/MM/AAAA` | `fechaISO=YYYY-MM-DD` | `fechaDesde`+`fechaHasta` */
function parseFechasQuery(req: Request): { desde: string; hasta: string } | undefined {
  const iso = firstQueryString(req.query.fechaISO);
  if (iso) {
    const p = fechaIsoAMexicoDdMmYyyy(iso);
    if (!p) return undefined;
    return { desde: p, hasta: p };
  }
  const fecha = firstQueryString(req.query.fecha);
  if (fecha) {
    const p = parseFechaFiltradoDdMmYyyy(fecha);
    if (!p) return undefined;
    return { desde: p, hasta: p };
  }
  const fd = firstQueryString(req.query.fechaDesde);
  const fh = firstQueryString(req.query.fechaHasta);
  if (!fd && !fh) return undefined;
  const pd = fd ? parseFechaFiltradoDdMmYyyy(fd) : null;
  const ph = fh ? parseFechaFiltradoDdMmYyyy(fh) : null;
  if (!pd || !ph) return undefined;
  return { desde: pd, hasta: ph };
}

comprasmxRouter.get("/snapshot", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const headedExplicit = parseHeadedQuery(req.query.headed);

    const fechas = parseFechasQuery(req);
    if (firstQueryString(req.query.fechaISO) && !fechas) {
      res.status(400).json({ error: "Query 'fechaISO' inválida. Usa YYYY-MM-DD, ej. 2026-05-08" });
      return;
    }
    if (firstQueryString(req.query.fecha) && !fechas) {
      res.status(400).json({
        error: "Query 'fecha' inválida. Usa DD/MM/AAAA, ej. 08/05/2026. En URL codifica barras: ?fecha=08%2F05%2F2026",
      });
      return;
    }
    if (
      (firstQueryString(req.query.fechaDesde) || firstQueryString(req.query.fechaHasta)) &&
      !fechas
    ) {
      res.status(400).json({
        error:
          "Usa ambos 'fechaDesde' y 'fechaHasta' en DD/MM/AAAA, o un solo 'fecha' para el mismo día.",
      });
      return;
    }

    const data = await fetchComprasmxSnapshot({
      ...(headedExplicit !== undefined ? { headed: headedExplicit } : {}),
      ...(fechas ? { fechaPublicacionDesde: fechas.desde, fechaPublicacionHasta: fechas.hasta } : {}),
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});
