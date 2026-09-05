/**
 * ⚠️ VERIFY BEFORE USE
 * -----------------------------------------------------------------------
 * `dsh` is built on Cordis, where plugins typically export a `name` and an
 * `apply(ctx, config)` function, and register capabilities by calling
 * something on `ctx` (e.g. `ctx.tool.define(...)`, `ctx.plugin(...)`, or a
 * service-specific API). The exact tool-registration call for dsh
 * specifically isn't something I can verify from here — dsh is too new/
 * fast-moving for that to be reliable from memory.
 *
 * Check `docs/architecture.md` and an existing tool plugin (e.g.
 * `dsh-tool-csv`) in the official repo for the real registration API, then
 * adjust the marked section below. Everything else in this package (the
 * `core/*` modules) is plain TypeScript with no dependency on that API, so
 * it will keep working regardless of how the binding layer changes.
 * -----------------------------------------------------------------------
 */

import { z } from "zod";
import { runFormRecon } from "../core/index.js";
import type { ReconConfig } from "../types.js";

export const name = "form-recon";

// Only the JSON-serializable subset of ReconConfig is exposed as tool input —
// oauth/custom auth (which need live functions) aren't expressible over a
// tool-call JSON schema, so this binding only supports "standard" auth.
// Wire those modes up directly via `runFormRecon` in a wrapper script instead.
const toolInputSchema = z.object({
  baseUrl: z.string().url(),
  loginUrl: z.string().url(),
  usernameSelector: z.string(),
  passwordSelector: z.string(),
  submitSelector: z.string(),
  successSelector: z.string(),
  username: z.string(),
  password: z.string(),
  maxPages: z.number().int().positive().max(200).optional(),
  outDir: z.string(),
  probeValidation: z.boolean().optional(),
  allowRealSubmissions: z.boolean().optional(),
  maxFieldsPerFormToProbe: z.number().int().positive().max(50).optional(),
});

type ToolInput = z.infer<typeof toolInputSchema>;

async function handleFormReconRun(input: ToolInput) {
  const config: ReconConfig = {
    baseUrl: input.baseUrl,
    outDir: input.outDir,
    maxPages: input.maxPages,
    headless: true,
    // Defaults stay safe even if the caller omits these: no probing at all
    // unless explicitly requested, and never a live submission without an
    // explicit, separate opt-in.
    probeValidation: input.probeValidation ?? false,
    allowRealSubmissions: input.allowRealSubmissions ?? false,
    maxFieldsPerFormToProbe: input.maxFieldsPerFormToProbe,
    auth: {
      mode: "standard",
      loginUrl: input.loginUrl,
      usernameSelector: input.usernameSelector,
      passwordSelector: input.passwordSelector,
      submitSelector: input.submitSelector,
      successSelector: input.successSelector,
      username: input.username,
      password: input.password,
    },
  };

  const result = await runFormRecon(config);
  const totalForms = result.pages.reduce((n, p) => n + p.forms.length, 0);

  return {
    summary: `Crawled ${result.pages.length} pages, found ${totalForms} forms. Artifacts written to ${input.outDir}.`,
    reportPath: `${input.outDir}/report.md`,
  };
}

// --- Replace this section with the real dsh/Cordis registration call ---
export function apply(ctx: any, _config?: unknown) {
  ctx.tool?.define?.("form_recon.run", {
    description:
      "Log into a web app, crawl its forms, and generate requirements-engineering artifacts (JSON Schema, VECS docs, user stories).",
    inputSchema: toolInputSchema,
    handler: handleFormReconRun,
  });
}
// -------------------------------------------------------------------
