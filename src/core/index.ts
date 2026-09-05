import { chromium } from "playwright";
import type { PageReport, ReconConfig, ReconResult } from "../types.js";
import { login } from "./auth.js";
import { discoverPages } from "./discover.js";
import { analyzePage } from "./analyze.js";
import { inspectSecurity } from "./security.js";
import { probeFormValidation } from "./probe.js";
import { writeArtifacts } from "./artifacts/write.js";

/**
 * End-to-end pipeline: log in, crawl same-origin pages, analyze every form,
 * inspect security posture, and write all artifacts to disk.
 *
 * This is intentionally framework-agnostic (plain async function, no dsh/
 * Cordis imports) so it can be run and tested standalone via `src/cli.ts`
 * before wiring it into the harness through `src/adapter/dsh-plugin.ts`.
 */
export async function runFormRecon(config: ReconConfig): Promise<ReconResult> {
  const browser = await chromium.launch({ headless: config.headless ?? true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page, config.auth);

    const maxPages = config.maxPages ?? 25;
    const delay = config.requestDelayMs ?? 500;
    const urls = await discoverPages(page, config.baseUrl, maxPages, delay);

    const pages: PageReport[] = [];
    for (const url of urls) {
      const forms = await analyzePage(page, url);
      const security = await inspectSecurity(page, url, forms);

      if (config.probeValidation) {
        for (const form of forms) {
          form.validationObservations = await probeFormValidation(page, form, {
            allowRealSubmissions: config.allowRealSubmissions ?? false,
            skipDestructive: config.skipDestructiveForms ?? true,
            maxFieldsToProbe: config.maxFieldsPerFormToProbe ?? 10,
          });
        }
        // The prober navigates around while testing fields — return to the
        // page URL so the next iteration (and any delay) starts from a known state.
        await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      }

      pages.push({ url, forms, security });
      if (delay > 0) await page.waitForTimeout(delay);
    }

    const result: ReconResult = {
      baseUrl: config.baseUrl,
      crawledAt: new Date().toISOString(),
      pages,
    };

    await writeArtifacts(result, config.outDir);
    return result;
  } finally {
    await browser.close();
  }
}

export * from "../types.js";
