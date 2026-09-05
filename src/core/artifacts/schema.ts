import type { FormField, FormModel } from "../../types.js";

function fieldToJsonSchema(field: FormField): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  switch (field.type) {
    case "number":
    case "range":
      schema.type = "number";
      if (field.min !== undefined) schema.minimum = Number(field.min);
      if (field.max !== undefined) schema.maximum = Number(field.max);
      break;
    case "checkbox":
      schema.type = "boolean";
      break;
    case "email":
      schema.type = "string";
      schema.format = "email";
      break;
    case "date":
      schema.type = "string";
      schema.format = "date";
      break;
    case "select-one":
      schema.type = "string";
      if (field.options) schema.enum = field.options.map((o) => o.value);
      break;
    default:
      schema.type = "string";
  }

  if (field.pattern) schema.pattern = field.pattern;
  if (field.minLength !== undefined) schema.minLength = field.minLength;
  if (field.maxLength !== undefined) schema.maxLength = field.maxLength;
  if (field.label) schema.title = field.label;
  if (field.placeholder) schema.description = field.placeholder;

  return schema;
}

/**
 * Produces a JSON Schema (draft 2020-12 style) describing one form's
 * submittable payload — excludes CSRF/hidden bookkeeping fields by default.
 */
export function formToJsonSchema(form: FormModel): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of form.fields) {
    if (!field.name || field.suspectedCsrfToken) continue;
    properties[field.name] = fieldToJsonSchema(field);
    if (field.required) required.push(field.name);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: form.name ?? form.id ?? `form-${form.formIndex}`,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    "x-form-meta": {
      pageUrl: form.pageUrl,
      action: form.action,
      method: form.method.toUpperCase(),
      renderedByJs: form.renderedByJs,
    },
  };
}
