import { readFile } from "node:fs/promises";
import { runFormRecon } from "./core/index.js";
import type { ReconConfig } from "./types.js";

// Usage: tsx src/cli.ts path/to/recon.config.json
//
// The config file is plain JSON for standard/no-code auth. If you need
// `oauth` or `custom` auth (which take functions), import `runFormRecon`
// directly from a small .ts script instead of going through this CLI —
// see README.md for an example.

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: tsx src/cli.ts <recon.config.json>");
    process.exit(1);
  }

  const raw = await readFile(configPath, "utf-8");
  const config = JSON.parse(raw) as ReconConfig;

  console.log(`Starting recon on ${config.baseUrl} ...`);
  const result = await runFormRecon(config);
  const totalForms = result.pages.reduce((n, p) => n + p.forms.length, 0);
  console.log(`Done. Crawled ${result.pages.length} pages, found ${totalForms} forms.`);
  console.log(`Artifacts written to ${config.outDir}`);
}

main().catch((err) => {
  console.error("Recon failed:", err);
  process.exit(1);
});
