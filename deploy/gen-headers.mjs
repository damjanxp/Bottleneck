// Prints the frontend's security headers as a Caddy snippet, derived from vercel.json (the single
// source), so Vercel and Caddy can never drift. Used at image build time by deploy/caddy.Dockerfile:
//   node deploy/gen-headers.mjs > security-headers.caddy
import { readFileSync } from "node:fs";

const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const rule = (source) => vercel.headers.find((h) => h.source === source)?.headers ?? [];
const q = (s) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const all = rule("/(.*)");
if (all.length === 0) throw new Error("vercel.json has no '/(.*)' headers");

const lines = ["(security_headers) {", "\theader {"];
for (const { key, value } of all) lines.push(`\t\t${q(key)} ${q(value)}`);
lines.push("		-Server", "	}", "}", "");
process.stdout.write(lines.join("\n"));
