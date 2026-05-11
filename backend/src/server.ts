import { buildApp } from "./app.js";

const port = Number(process.env.PORT) || 8000;
const host = process.env.HOST ?? "127.0.0.1";

const app = buildApp();

app.listen(port, host, () => {
  console.log(`Listening on http://${host}:${port}`);
});
