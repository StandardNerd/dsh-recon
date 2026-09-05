import type { FormField, FormModel } from "../types.js";

// Best-effort attribute-value escaping for building CSS attribute selectors
// from arbitrary field names/values. Not a full CSS.escape polyfill — good
// enough for typical form field names, but a name/value with unusual
// characters may need a manually adjusted selector.
function escapeAttr(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

function escapeId(id: string): string {
  return id.replace(/([^\w-])/g, "\\$1");
}

/** CSS selector scoping to a specific `<form>` on the page, by its crawl-time index. */
export function formSelector(form: Pick<FormModel, "formIndex">): string {
  return `form:nth-of-type(${form.formIndex + 1})`;
}

/**
 * Builds a selector for one field within its form. Prefers `id` (most
 * reliable), then `name` (+ `value` for radio buttons, since radios in a
 * group share a name), then falls back to tag+type (ambiguous if the form
 * has more than one field of that exact type — flagged as a caveat in
 * ValidationObservation.notes when it's used).
 */
export function fieldSelector(form: FormModel, field: FormField): string {
  if (field.id) return `#${escapeId(field.id)}`;

  const scope = formSelector(form);
  if (field.name) {
    if (field.type === "radio" && field.defaultValue) {
      return `${scope} [name="${escapeAttr(field.name)}"][value="${escapeAttr(field.defaultValue)}"]`;
    }
    return `${scope} [name="${escapeAttr(field.name)}"]`;
  }

  return `${scope} ${field.tag}[type="${escapeAttr(field.type)}"]`;
}
