import type { Page } from "playwright";
import type { FormField, FormModel, ValidationObservation, ValidationTestCase } from "../types.js";
import { fieldSelector } from "./dom-selectors.js";

const ERROR_TEXT_SELECTOR =
  '[role="alert"], [aria-live], .error, .Error, .invalid-feedback, .field-error, .form-error, [class*="error" i]';

const DESTRUCTIVE_HINTS =
  /delete|remove|cancel|unsubscribe|deactivate|purchase|checkout|\bpay\b|payment|charge|transfer|withdraw|close.?account/i;

/** Heuristic: does this form look like it deletes something, moves money, or ends a subscription? */
export function looksDestructive(form: FormModel): boolean {
  if (form.method.toUpperCase() === "DELETE") return true;
  const haystack = [form.action, form.name ?? "", ...form.submitButtons.map((b) => b.text)].join(" ");
  return DESTRUCTIVE_HINTS.test(haystack);
}

function validValueFor(field: FormField): string {
  switch (field.type) {
    case "email":
      return "dsh-probe@example.com";
    case "number":
    case "range": {
      const min = field.min !== undefined ? Number(field.min) : 0;
      const max = field.max !== undefined ? Number(field.max) : min + 10;
      return String(Math.round((min + max) / 2));
    }
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "tel":
      return "+15551234567";
    case "url":
      return "https://example.com";
    case "select-one":
      return field.options?.[1]?.value ?? field.options?.[0]?.value ?? "";
    default: {
      const minLen = field.minLength ?? 3;
      const text = "Probe value".padEnd(minLen, "x");
      return field.maxLength ? text.slice(0, field.maxLength) : text;
    }
  }
}

/** Deliberately bad value for the "invalid-format" test case (not used for "missing-required"). */
function invalidValueFor(field: FormField): string {
  if (field.type === "email") return "not-an-email";
  if (field.type === "number" || field.type === "range") {
    if (field.max !== undefined) return String(Number(field.max) + 1000);
    if (field.min !== undefined) return String(Number(field.min) - 1000);
    return "not-a-number";
  }
  if (field.type === "date") return "not-a-date";
  if (field.type === "url") return "not a url";
  if (field.pattern) return "###PATTERN-VIOLATION###";
  if (field.maxLength) return "X".repeat(field.maxLength + 20);
  return "";
}

/** True if this field can meaningfully be given an "invalid-format" value at all. */
function hasFormatConstraint(field: FormField): boolean {
  return Boolean(
    field.pattern ||
      field.maxLength ||
      ["email", "number", "range", "date", "url"].includes(field.type)
  );
}

async function setFieldValue(
  page: Page,
  form: FormModel,
  field: FormField,
  mode: "valid" | "invalid" | "empty"
): Promise<void> {
  if (field.suspectedCsrfToken || field.disabled || field.type === "hidden") return;
  if (!field.name && !field.id) return; // nothing reliable to target

  const selector = fieldSelector(form, field);

  try {
    if (field.tag === "select") {
      const value = mode === "empty" ? "" : mode === "valid" ? validValueFor(field) : field.options?.[0]?.value ?? "";
      if (value) await page.selectOption(selector, value);
      return;
    }
    if (field.type === "checkbox") {
      if (mode === "empty") await page.uncheck(selector);
      else await page.check(selector);
      return;
    }
    if (field.type === "radio") {
      if (mode !== "empty") await page.check(selector);
      return; // "empty" = leave the group unchecked
    }

    const value = mode === "empty" ? "" : mode === "valid" ? validValueFor(field) : invalidValueFor(field);
    await page.fill(selector, value);
  } catch {
    // Selector didn't resolve — likely a custom component replacing the native
    // control, or a nameless/idless field. Skipped silently; the resulting
    // observation will just show no effect from this field.
  }
}

async function fillFormValidly(page: Page, form: FormModel, exceptField: string): Promise<void> {
  for (const field of form.fields) {
    if (field.name === exceptField) continue;
    await setFieldValue(page, form, field, "valid");
  }
}

async function snapshotErrorTexts(page: Page): Promise<Set<string>> {
  const texts: string[] = await page
    .$$eval(ERROR_TEXT_SELECTOR, (els) => els.map((e) => e.textContent?.trim() ?? "").filter(Boolean))
    .catch(() => [] as string[]);
  return new Set(texts);
}

export interface ProbeOptions {
  allowRealSubmissions: boolean;
  skipDestructive: boolean;
  maxFieldsToProbe: number;
}

/**
 * For each constrained field in `form`, tries a "missing required" and/or
 * "invalid format" submission and records what happened. Dry-run by default
 * (see ProbeOptions.allowRealSubmissions) — the network request is
 * intercepted and aborted the instant it fires, so nothing reaches the
 * server unless you explicitly opt in.
 */
export async function probeFormValidation(page: Page, form: FormModel, options: ProbeOptions): Promise<ValidationObservation[]> {
  if (options.skipDestructive && looksDestructive(form)) {
    return [
      {
        fieldName: "*",
        testCase: "skipped" as ValidationTestCase,
        clientBlocked: false,
        requestAttempted: false,
        requestAllowedLive: false,
        observedErrorTexts: [],
        possiblySucceeded: false,
        notes:
          "Skipped: this form's action/labels match a destructive or payment pattern " +
          "(delete/purchase/charge/transfer/...). Set skipDestructiveForms:false to override " +
          "— but review the form by hand first.",
      },
    ];
  }

  const submit = form.submitButtons[0];
  if (!submit) return [];

  const candidates = form.fields
    .filter((f) => !f.suspectedCsrfToken && !f.disabled && (f.required || hasFormatConstraint(f)))
    .slice(0, options.maxFieldsToProbe);

  const actionUrlBase = form.action.split("?")[0];
  const matchesAction = (url: URL) => url.href.split("?")[0] === actionUrlBase;

  const observations: ValidationObservation[] = [];

  for (const field of candidates) {
    const testCases: ValidationTestCase[] = [
      ...(field.required ? (["missing-required"] as const) : []),
      ...(hasFormatConstraint(field) ? (["invalid-format"] as const) : []),
    ];

    for (const testCase of testCases) {
      await page.goto(form.pageUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
      await fillFormValidly(page, form, field.name);
      await setFieldValue(page, form, field, testCase === "missing-required" ? "empty" : "invalid");

      const before = await snapshotErrorTexts(page);

      let requestSeen = false;
      let responseStatus: number | undefined;

      await page.route(matchesAction, async (route) => {
        requestSeen = true;
        if (options.allowRealSubmissions) {
          const response = await route.fetch().catch(() => undefined);
          if (response) {
            responseStatus = response.status();
            await route.fulfill({ response }).catch(() => route.continue());
          } else {
            await route.continue();
          }
        } else {
          await route.abort("failed");
        }
      });

      try {
        await page.click(submit.selector, { timeout: 3_000 });
        await page.waitForTimeout(600);
      } catch {
        // Click or the resulting (likely aborted) navigation failed — expected in dry-run mode.
      }

      const html5Message = await page
        .$eval(fieldSelector(form, field), (el) => (el as HTMLInputElement).validationMessage || undefined)
        .catch(() => undefined);

      const after = await snapshotErrorTexts(page);
      const newTexts = [...after].filter((t) => !before.has(t));

      await page.unroute(matchesAction).catch(() => {});

      const stillOnFormPage = page.url().split("?")[0] === form.pageUrl.split("?")[0];
      const possiblySucceeded =
        options.allowRealSubmissions && requestSeen && newTexts.length === 0 && !html5Message && !stillOnFormPage;

      observations.push({
        fieldName: field.name || "(unnamed field)",
        testCase,
        testValue: testCase === "invalid-format" ? invalidValueFor(field) : "",
        clientBlocked: Boolean(html5Message) && !requestSeen,
        clientValidationMessage: html5Message,
        requestAttempted: requestSeen,
        requestAllowedLive: options.allowRealSubmissions && requestSeen,
        responseStatus,
        observedErrorTexts: newTexts,
        possiblySucceeded,
        notes: possiblySucceeded
          ? "No error surfaced and the page navigated away while a live request was allowed — " +
            "the 'invalid' value may have actually been accepted. Check the target system and " +
            "clean up any record this may have created."
          : requestSeen && !options.allowRealSubmissions
          ? "Client-side validation did not block this — a request would have reached the server " +
            "but was intercepted and aborted (dry run). Set allowRealSubmissions:true to see the real error text."
          : "",
      });
    }
  }

  return observations;
}
