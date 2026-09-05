import type { FormModel } from "../../types.js";

function guessIntent(form: FormModel): string {
  const names = form.fields.map((f) => f.name.toLowerCase()).join(" ");
  if (/password/.test(names) && /email|username/.test(names)) return "authenticate";
  if (/password/.test(names) && /confirm/.test(names)) return "set or reset a password";
  if (/card|cvv|expiry|billing/.test(names)) return "submit payment details";
  if (/search|query|q\b/.test(names)) return "search for content";
  if (/email/.test(names) && form.fields.length <= 2) return "subscribe or request contact";
  return "submit information";
}

/**
 * Generates a lightweight Gherkin-style user story + acceptance criteria per
 * form, seeded from field names/constraints. Meant as a first draft for a
 * requirements reviewer, not a final spec.
 */
export function formToUserStory(form: FormModel): string {
  const title = form.name ?? form.id ?? `Form ${form.formIndex}`;
  const intent = guessIntent(form);
  const requiredFields = form.fields.filter((f) => f.required && !f.suspectedCsrfToken);

  const lines: string[] = [];
  lines.push(`## User Story — ${title}`);
  lines.push("");
  lines.push(`**As a** user of the application`);
  lines.push(`**I want to** ${intent} via the "${title}" form`);
  lines.push(`**So that** I can complete the corresponding workflow at ${form.pageUrl}`);
  lines.push("");
  lines.push("### Acceptance criteria (draft — confirm against real behavior)");
  lines.push("");
  for (const f of requiredFields) {
    lines.push(`- Given the "${f.label ?? f.name}" field is empty, when I submit, then the form should not succeed.`);
  }
  for (const f of form.fields.filter((f) => f.pattern || f.type === "email")) {
    lines.push(`- Given "${f.label ?? f.name}" has an invalid format, when I submit, then a validation error should appear.`);
  }
  if (form.fields.some((f) => f.suspectedDependency)) {
    lines.push(
      `- Given the conditional field(s) (${form.fields
        .filter((f) => f.suspectedDependency)
        .map((f) => f.name)
        .join(", ")}), when their controlling field changes, then visibility/required-ness should update accordingly — verify the exact trigger manually.`
    );
  }
  lines.push(`- Given all required fields are valid, when I submit, then the request should be sent as \`${form.method.toUpperCase()} ${form.action}\`.`);

  return lines.join("\n");
}
