// Fails when the running stack's frontend headers differ from vercel.json.
//   node deploy/check-headers.mjs http://localhost:8080
// (Caddy generates them from vercel.json at build time; this proves it end to end, including the
// Content-Security-Policy that makes `connect-src 'self'` require same-origin API routing.)
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8080";
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const expected = vercel.headers.find((h) => h.source === "/(.*)").headers;

if (base.startsWith("https://localhost")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Caddy's internal CA

let failed = 0;
const res = await fetch(`${base}/`);
if (res.status !== 200) { console.error(`GET / -> ${res.status}`); failed++; }
for (const { key, value } of expected) {
  const got = res.headers.get(key);
  if (got !== value) { console.error(`MISMATCH ${key}\n  expected: ${value}\n  got:      ${got}`); failed++; }
}
if (res.headers.get("server")) { console.error(`unexpected Server header: ${res.headers.get("server")}`); failed++; }
const index = await res.text();
const asset = /\/assets\/[^"']+\.js/.exec(index)?.[0];
if (!asset) { console.error("no /assets/*.js reference in index.html"); failed++; }
else {
  const a = await fetch(`${base}${asset}`);
  const want = vercel.headers.find((h) => h.source === "/assets/(.*)").headers[0];
  if (a.headers.get(want.key) !== want.value) { console.error(`asset ${want.key}: ${a.headers.get(want.key)}`); failed++; }
}
const api = await fetch(`${base}/health/ready`);
if (api.status !== 200) { console.error(`/health/ready -> ${api.status}`); failed++; }

if (failed) { console.error(`${failed} problem(s)`); process.exit(1); }
console.log(`ok: ${expected.length} security headers match vercel.json; assets cached; /health/ready 200 (same origin)`);
