import type { Page } from "playwright";
import type { FormModel, SecurityFindings } from "../types.js";

const RATE_LIMIT_HEADER_NAMES = [
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "ratelimit-limit",
  "ratelimit-remaining",
];

const HARDENING_HEADER_NAMES = [
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "strict-transport-security",
  "referrer-policy",
  "permissions-policy",
];

/**
 * Inspects the response headers of the current page's main document and
 * cross-references the already-extracted forms for CSRF token fields.
 */
export async function inspectSecurity(
  page: Page,
  url: string,
  forms: FormModel[]
): Promise<SecurityFindings> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const headers = response?.headers() ?? {};

  const rateLimitHeaders: Record<string, string | undefined> = {};
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    if (headers[name]) rateLimitHeaders[name] = headers[name];
  }

  const securityHeaders: Record<string, string | undefined> = {};
  for (const name of HARDENING_HEADER_NAMES) {
    securityHeaders[name] = headers[name]; // include even if undefined, so gaps are visible
  }

  const csrfFieldNames = forms
    .flatMap((f) => f.fields)
    .filter((f) => f.suspectedCsrfToken)
    .map((f) => f.name);

  const formsSubmitOverHttps = forms.every((f) => {
    try {
      return new URL(f.action).protocol === "https:";
    } catch {
      return true; // relative action, inherits page protocol — flagged separately if page itself isn't https
    }
  });

  return {
    pageUrl: url,
    hasCsrfToken: csrfFieldNames.length > 0,
    csrfFieldNames,
    securityHeaders,
    rateLimitHeaders,
    formsSubmitOverHttps: formsSubmitOverHttps && new URL(url).protocol === "https:",
  };
}
