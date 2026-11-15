/**
 * Bundles the sidecar and the engine (TypeScript source, `.ts` imports, workspace packages) into
 * plain ESM in apps/sidecar/dist: server.mjs (the HTTP server) and worker.mjs (the per-run worker
 * thread that server.mjs starts from the same directory).
 */
import { build } from "esbuild";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildSidecar(outdir = path.join(root, "dist")) {
  await build({
    absWorkingDir: root,
    entryPoints: { server: "src/server.ts", worker: "src/worker.ts" },
    outdir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    sourcemap: true,
    logLevel: "warning",
    // Some bundled CommonJS dependencies (Ajv) call require().
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
  return outdir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSidecar();
  process.stdout.write("sidecar built\n");
}
