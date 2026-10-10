import { build } from "esbuild";
await build({
  entryPoints: ["companion/server.ts"],
  outfile: "dist-companion/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node24",
});
