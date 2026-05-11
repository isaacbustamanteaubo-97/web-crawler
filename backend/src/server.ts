import { buildApp } from "./app.js";
import { warmComprasmxBrowser } from "./services/comprasmx.js";

const port = Number(process.env.PORT) || 8000;
const host = process.env.HOST ?? "127.0.0.1";

const app = buildApp();

app.listen(port, host, () => {
  console.log(`Listening on http://${host}:${port}`);
  void warmComprasmxBrowser().catch((err) => {
    console.warn("[comprasmx] No se pudo precalentar Chromium; el primer snapshot lanzará el navegador.", err);
  });
});
