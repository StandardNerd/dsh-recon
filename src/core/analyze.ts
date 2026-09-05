import type { Page } from "playwright";
import type { FormField, FormModel, FieldOption } from "../types.js";

const CSRF_NAME_HINTS = [
  "csrf",
  "_token",
  "authenticity_token",
  "xsrf",
  "anti-forgery",
  "requestverificationtoken",
];

const DEPENDENCY_ATTRS = [
  "onchange",
  "oninput",
  "onclick",
  "data-show-if",
  "data-depends-on",
  "data-conditional",
  "x-show", // Alpine.js
  ":disabled", // Vue-style binding left in the DOM as a literal attr in some SSR setups
];

function looksLikeCsrf(name: string): boolean {
  const n = name.toLowerCase();
  return CSRF_NAME_HINTS.some((hint) => n.includes(hint));
}

/**
 * Extracts a structural signature for a form so we can tell whether the same
 * form (by action+method+field set) was present before JS finished running.
 */
function signature(form: Pick<FormModel, "action" | "method" | "fields">): string {
  const fieldKey = form.fields
    .map((f) => `${f.name}:${f.tag}:${f.type}`)
    .sort()
    .join("|");
  return `${form.method.toUpperCase()} ${form.action} :: ${fieldKey}`;
}

/**
 * Extracts all <form> elements on the current page along with per-field
 * metadata. Call this twice per page (once at domcontentloaded, once at
 * networkidle) to flag JS-rendered forms — see `analyzePage`.
 */
async function extractForms(page: Page, pageUrl: string): Promise<FormModel[]> {
  const raw = await page.$$eval("form", (forms) =>
    forms.map((form, formIndex) => {
      const el = form as HTMLFormElement;

      const fields = Array.from(el.querySelectorAll("input, select, textarea")).map((node) => {
        const e = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const tag = e.tagName.toLowerCase() as "input" | "select" | "textarea";
        const type = tag === "input" ? (e as HTMLInputElement).type || "text" : tag;

        let label: string | undefined;
        if (e.id) {
          const labelEl = document.querySelector(`label[for="${e.id}"]`);
          label = labelEl?.textContent?.trim();
        }
        if (!label) {
          const closestLabel = e.closest("label");
          label = closestLabel?.textContent?.trim();
        }

        const options: FieldOption[] | undefined =
          tag === "select"
            ? Array.from((e as HTMLSelectElement).options).map((o) => ({
                value: o.value,
                label: o.textContent?.trim() ?? "",
              }))
            : undefined;

        const onAttrs = Array.from(e.attributes)
          .map((a) => a.name)
          .filter((name) =>
            [
              "onchange",
              "oninput",
              "onclick",
              "data-show-if",
              "data-depends-on",
              "data-conditional",
              "x-show",
            ].includes(name)
          );

        return {
          name: e.getAttribute("name") ?? "",
          id: e.id || undefined,
          tag,
          type,
          label,
          required: e.hasAttribute("required"),
          disabled: e.hasAttribute("disabled"),
          placeholder: (e as HTMLInputElement).placeholder || undefined,
          pattern: (e as HTMLInputElement).pattern || undefined,
          minLength:
            (e as HTMLInputElement).minLength && (e as HTMLInputElement).minLength > 0
              ? (e as HTMLInputElement).minLength
              : undefined,
          maxLength:
            (e as HTMLInputElement).maxLength && (e as HTMLInputElement).maxLength > 0
              ? (e as HTMLInputElement).maxLength
              : undefined,
          min: (e as HTMLInputElement).min || undefined,
          max: (e as HTMLInputElement).max || undefined,
          step: (e as HTMLInputElement).step || undefined,
          options,
          defaultValue: (e as HTMLInputElement).defaultValue || undefined,
          onAttrs,
        };
      });

      const submitButtons = Array.from(
        el.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')
      ).map((btn, i) => ({
        text: (btn as HTMLElement).textContent?.trim() || (btn as HTMLInputElement).value || `submit-${i}`,
        selector: `form:nth-of-type(${formIndex + 1}) ${btn.tagName.toLowerCase()}:nth-of-type(${i + 1})`,
      }));

      return {
        id: el.id || undefined,
        name: el.getAttribute("name") || undefined,
        action: el.action || window.location.href,
        method: el.method || "get",
        enctype: el.enctype || undefined,
        fields,
        submitButtons,
      };
    })
  );

  return raw.map((f, i) => ({
    pageUrl,
    formIndex: i,
    id: f.id,
    name: f.name,
    action: f.action,
    method: f.method,
    enctype: f.enctype,
    submitButtons: f.submitButtons,
    renderedByJs: false, // filled in by analyzePage
    fields: f.fields.map(
      (raw): FormField => ({
        name: raw.name,
        id: raw.id,
        tag: raw.tag,
        type: raw.type,
        label: raw.label,
        required: raw.required,
        disabled: raw.disabled,
        placeholder: raw.placeholder,
        pattern: raw.pattern,
        minLength: raw.minLength,
        maxLength: raw.maxLength,
        min: raw.min,
        max: raw.max,
        step: raw.step,
        options: raw.options,
        defaultValue: raw.defaultValue,
        suspectedCsrfToken: raw.type === "hidden" && looksLikeCsrf(raw.name),
        suspectedDependency:
          raw.onAttrs.length > 0
            ? {
                onAttributes: raw.onAttrs,
                note: "Field carries a change/visibility handler or conditional-render attribute — verify manually whether another field's state gates this one.",
              }
            : undefined,
      })
    ),
  }));
}

/**
 * Extracts forms twice (pre- and post-JS-settle) so forms/fields that only
 * exist after client-side rendering are flagged rather than silently merged
 * in as if they were server-rendered.
 */
export async function analyzePage(page: Page, url: string): Promise<FormModel[]> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const early = await extractForms(page, url);
  const earlySigs = new Set(early.map(signature));

  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  const settled = await extractForms(page, url);

  return settled.map((form) => ({
    ...form,
    renderedByJs: !earlySigs.has(signature(form)),
  }));
}
