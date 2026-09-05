import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReconResult } from "../../types.js";
import { formToJsonSchema } from "./schema.js";
import { formToVecsMarkdown } from "./vecs.js";
import { formToUserStory } from "./stories.js";

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "form";
}

/**
 * Writes the full machine-readable report (report.json), a human-readable
 * summary (report.md), and per-form artifacts (schema/VECS/story) under
 * `outDir/forms/`.
 */
export async function writeArtifacts(result: ReconResult, outDir: string): Promise<void> {
  const formsDir = path.join(outDir, "forms");
  await mkdir(formsDir, { recursive: true });

  await writeFile(path.join(outDir, "report.json"), JSON.stringify(result, null, 2), "utf-8");

  const summaryLines: string[] = [];
  summaryLines.push(`# Form Recon Report — ${result.baseUrl}`);
  summaryLines.push(`Crawled at: ${result.crawledAt}`);
  summaryLines.push("");
  summaryLines.push(`Pages crawled: ${result.pages.length}`);
  summaryLines.push(`Total forms found: ${result.pages.reduce((n, p) => n + p.forms.length, 0)}`);
  summaryLines.push("");

  for (const page of result.pages) {
    summaryLines.push(`## ${page.url}`);
    summaryLines.push(
      `- CSRF token present: ${page.security.hasCsrfToken ? "yes (" + page.security.csrfFieldNames.join(", ") + ")" : "**no — review**"}`
    );
    summaryLines.push(
      `- Rate-limit headers observed: ${
        Object.keys(page.security.rateLimitHeaders).length > 0
          ? Object.entries(page.security.rateLimitHeaders)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
          : "none observed"
      }`
    );
    const missingHardening = Object.entries(page.security.securityHeaders)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missingHardening.length > 0) {
      summaryLines.push(`- Missing hardening headers: ${missingHardening.join(", ")}`);
    }
    summaryLines.push(`- Forms submit over HTTPS: ${page.security.formsSubmitOverHttps ? "yes" : "**no — review**"}`);

    for (const form of page.forms) {
      const name = form.name ?? form.id ?? `form-${form.formIndex}`;
      const base = slug(`${new URL(page.url).pathname}-${name}`);

      await writeFile(
        path.join(formsDir, `${base}.schema.json`),
        JSON.stringify(formToJsonSchema(form), null, 2),
        "utf-8"
      );
      await writeFile(path.join(formsDir, `${base}.vecs.md`), formToVecsMarkdown(form), "utf-8");
      await writeFile(path.join(formsDir, `${base}.story.md`), formToUserStory(form), "utf-8");

      summaryLines.push(
        `  - Form "${name}" (${form.fields.length} fields, ${form.renderedByJs ? "JS-rendered" : "server-rendered"}) → \`forms/${base}.*\``
      );
    }
    summaryLines.push("");
  }

  await writeFile(path.join(outDir, "report.md"), summaryLines.join("\n"), "utf-8");
}
