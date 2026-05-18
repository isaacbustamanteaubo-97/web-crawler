import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import morgan from "morgan";
import { comprasmxRouter } from "./routes/comprasmx.js";
import { healthRouter } from "./routes/health.js";

function parseCorsOrigin(): cors.CorsOptions["origin"] {
  if (process.env.CORS_ORIGIN === "*") return true;
  const raw = process.env.CORS_ORIGIN;
  if (raw) return raw.split(",").map((s) => s.trim());
  return true;
}

function morganPreset(): string {
  const preset = process.env.MORGAN_FORMAT;
  if (preset === "dev" || preset === "combined" || preset === "tiny" || preset === "common") return preset;
  return process.env.NODE_ENV === "production" ? "combined" : "dev";
}

export function buildApp() {
  const app = express();

  app.use(cors({ origin: parseCorsOrigin() }));
  app.use(morgan(morganPreset()));
  app.use(express.json());

  app.use(healthRouter);
  app.use("/comprasmx", comprasmxRouter);

  const onError: ErrorRequestHandler = (
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    console.error(err);
    const detail = err instanceof Error ? err.message : String(err);
    const expose =
      process.env.NODE_ENV !== "production" || process.env.COMPRASMX_EXPOSE_API_ERRORS === "1";
    res.status(500).json({
      error: expose && detail ? detail : "Internal Server Error",
    });
  };
  app.use(onError);

  return app;
}
