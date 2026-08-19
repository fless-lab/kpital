import { defineConfig } from "tsup";

// Bundle the server into native ESM so `node dist/server.js` runs without the
// ERR_MODULE_NOT_FOUND that plain `tsc` output causes (extensionless relative
// imports). Runtime `dependencies` stay external (tsup externalizes them by
// default), which also keeps argon2's native .node binding out of the bundle.
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
});
