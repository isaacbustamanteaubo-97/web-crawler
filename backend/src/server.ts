import "./loadEnv.js";
import { buildApp } from "./app.js";
import { iniciarLimpiezaNocturnaAnexos } from "./jobs/midnightAnexosCleanup.js";
import { almacenAnexosActivo } from "./services/anexoStorage.js";
import { driveAuthMode } from "./services/driveStorage.js";
import { warmComprasmxBrowser } from "./services/comprasmx.js";

const port = Number(process.env.PORT) || 8000;
const host = process.env.HOST ?? "127.0.0.1";

const app = buildApp();

app.listen(port, host, () => {
  console.log(`Listening on http://${host}:${port}`);
  const almacen = almacenAnexosActivo();
  const driveAuth = driveAuthMode();
  console.log(
    `[comprasmx] Almacenamiento de anexos: ${almacen}${almacen === "drive" ? ` (auth: ${driveAuth})` : ""}`,
  );
  if (almacen === "drive" && driveAuth === "service_account") {
    console.warn(
      "[comprasmx] Cuenta de servicio sin cupo en Mi unidad (Gmail). Usa OAuth: yarn drive:oauth-setup",
    );
  }
  iniciarLimpiezaNocturnaAnexos();
  if (process.env.COMPRASMX_WARM_BROWSER === "1") {
    void warmComprasmxBrowser().catch((err) => {
      console.warn("[comprasmx] No se pudo precalentar Chromium.", err);
    });
  }
});
