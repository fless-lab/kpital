import { buildApp } from "./app";

const app = buildApp();

app.listen({ port: 3000, host: "0.0.0.0" }).catch((e) => {
  console.error(e);
  process.exit(1);
});
