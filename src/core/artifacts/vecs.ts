import type { FormModel, ValidationObservation } from "../../types.js";

function fieldConstraints(f: FormModel["fields"][number]): string[] {
  const c: string[] = [];
  if (f.required) c.push("required");
  if (f.pattern) c.push(`pattern: \`${f.pattern}\``);
  if (f.minLength !== undefined) c.push(`minLength: ${f.minLength}`);
  if (f.maxLength !== undefined) c.push(`maxLength: ${f.maxLength}`);
  if (f.min !== undefined) c.push(`min: ${f.min}`);
  if (f.max !== undefined) c.push(`max: ${f.max}`);
  if (f.disabled) c.push("disabled by default");
  return c.length > 0 ? c : ["—"];
}

function observationsFor(fieldName: string, all: ValidationObservation[] | undefined): ValidationObservation[] {
  if (!all) return [];
  return all.filter((o) => o.fieldName === fieldName);
}

/** Builds the "Errors" cell from real observations when we have them, else falls back to an inferred guess. */
function errorsCell(fieldName: string, f: FormModel["fields"][number], obs: ValidationObservation[]): string {
  if (obs.length === 0) {
    const inferred = [
      f.required ? `"${f.label ?? f.name} is required"` : null,
      f.pattern ? "format/pattern mismatch message" : null,
      f.minLength || f.maxLength ? "length-out-of-range message" : null,
    ]
      .filter(Boolean)
      .join("; ");
    return inferred ? `⚠️ inferred: ${inferred}` : "—";
  }

  const parts: string[] = [];
  for (const o of obs) {
    if (o.observedErrorTexts.length > 0) {
      parts.push(`✅ observed (${o.testCase}): "${o.observedErrorTexts[0]}"`);
    } else if (o.clientValidationMessage) {
      parts.push(`✅ browser validation (${o.testCase}): "${o.clientValidationMessage}"`);
    } else if (o.requestAttempted && !o.requestAllowedLive) {
      parts.push(`⚠️ dry-run (${o.testCase}): no client block; server text not captured — rerun with allowRealSubmissions`);
    } else if (o.possiblySucceeded) {
      parts.push(`🚩 (${o.testCase}): no error found and page navigated away — value may have been accepted, verify manually`);
    }
  }
  return parts.length > 0 ? parts.join("<br>") : "—";
}

/**
 * Generates a VECS doc: Validations / Errors (observed where the probe ran,
 * otherwise inferred) / Constraints / States, one table row per form field.
 */
export function formToVecsMarkdown(form: FormModel): string {
  const title = form.name ?? form.id ?? `Form ${form.formIndex}`;
  const lines: string[] = [];

  lines.push(`# VECS — ${title}`);
  lines.push("");
  lines.push(`- **Page:** ${form.pageUrl}`);
  lines.push(`- **Action:** \`${form.method.toUpperCase()} ${form.action}\``);
  if (form.enctype) lines.push(`- **Encoding:** \`${form.enctype}\``);
  lines.push(`- **Rendered by JS:** ${form.renderedByJs ? "yes (not in initial HTML)" : "no"}`);

  const skipNote = form.validationObservations?.find((o) => o.testCase === "skipped");
  if (skipNote) {
    lines.push("");
    lines.push(`> ⚠️ Validation probe skipped this form: ${skipNote.notes}`);
  }

  lines.push("");
  lines.push("| Field | Type | Validations / Constraints | Errors | States |");
  lines.push("|---|---|---|---|---|");

  for (const f of form.fields) {
    if (f.suspectedCsrfToken) continue; // documented separately as a security concern, not a UX field
    const constraints = fieldConstraints(f).join("; ");
    const obs = observationsFor(f.name, form.validationObservations);
    const errors = errorsCell(f.name, f, obs);
    const states = [
      f.disabled ? "disabled" : null,
      f.suspectedDependency ? `conditional (${f.suspectedDependency.onAttributes.join(", ")})` : null,
    ]
      .filter(Boolean)
      .join("; ") || "static/always visible";

    lines.push(`| ${f.name || "(unnamed)"} | ${f.type} | ${constraints} | ${errors} | ${states} |`);
  }

  lines.push("");
  if (form.validationObservations && form.validationObservations.some((o) => o.testCase !== "skipped")) {
    lines.push(
      "> Rows marked ✅ come from an actual submission attempt (the validation probe). " +
        "⚠️ rows are either inferred from HTML attributes only, or ran in dry-run mode " +
        "(request intercepted before it reached the server). 🚩 rows need manual verification — " +
        "the probe couldn't tell whether the bad value was actually rejected."
    );
  } else {
    lines.push(
      "> Error message text below is **inferred from validation attributes**, not observed — " +
        "run with `probeValidation: true` to replace these with real submission results."
    );
  }

  return lines.join("\n");
}
