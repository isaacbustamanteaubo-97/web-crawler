import { type Request, type Response, Router } from "express";

export const healthRouter = Router();

healthRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});
