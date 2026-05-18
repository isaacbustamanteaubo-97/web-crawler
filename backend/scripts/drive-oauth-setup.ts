/**
 * Obtiene GOOGLE_OAUTH_REFRESH_TOKEN para subir a Drive con tu cuenta (Gmail personal).
 *
 * 1. En GCP → Credenciales → Crear credenciales → ID de cliente OAuth → Aplicación de escritorio
 *    (o Web con URI http://127.0.0.1:53682/oauth2callback)
 * 2. En .env pon GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET
 * 3. yarn drive:oauth-setup
 */
import "../src/loadEnv.js";
import { createServer } from "node:http";
import { OAuth2Client } from "google-auth-library";

const PORT = Number(process.env.GOOGLE_OAUTH_SETUP_PORT) || 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    console.error("Define GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET en backend/.env");
    process.exit(1);
  }

  const oauth2 = new OAuth2Client(clientId, clientSecret, REDIRECT);
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const c = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (err) {
        res.end(`<p>Error: ${err}</p><p>Puedes cerrar esta ventana.</p>`);
        reject(new Error(err));
      } else if (c) {
        res.end("<p>Autorización correcta. Puedes cerrar esta ventana y volver a la terminal.</p>");
        resolve(c);
      } else {
        res.end("<p>Falta code en la URL.</p>");
        reject(new Error("Sin code"));
      }
      server.close();
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.log("\nAbre esta URL en el navegador (cuenta de Google con tus 15 GB):\n");
      console.log(authUrl);
      console.log(`\nEsperando callback en ${REDIRECT} …\n`);
    });
    server.on("error", reject);
  });

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      "No llegó refresh_token. Revoca el acceso en https://myaccount.google.com/permissions y vuelve a ejecutar.",
    );
    process.exit(1);
  }

  console.log("\nAñade a backend/.env:\n");
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log("\nMantén GOOGLE_DRIVE_ENABLED=1 y GOOGLE_DRIVE_ROOT_FOLDER_ID con tu carpeta en Mi unidad.\n");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
