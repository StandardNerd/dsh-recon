# dsh-form-recon

A `dsh` tool plugin that logs into a web app, crawls its same-origin pages,
enumerates every `<form>`, and generates requirements-engineering artifacts:
a JSON Schema, a VECS (Validations/Errors/Constraints/States) doc, and a
draft user story — per form — plus a human-readable summary report.

New to this codebase, Playwright, or `dsh`? See **[WALKTHROUGH.md](./WALKTHROUGH.md)**
for a from-scratch, file-by-file explanation of how everything works.

**Use this only on apps you own or are explicitly authorized to test.** It
authenticates and actively crawls; be as careful with it as you would with
any authenticated scanner (rate-limit it, respect the target's ToS/robots.txt,
don't point it at third-party production systems without permission).

## Layout

```
src/
  types.ts                 shared types
  core/
    auth.ts                 standard / oauth / custom login
    discover.ts              BFS crawl of same-origin pages
    analyze.ts                form + field extraction, JS-render detection
    security.ts               CSRF / rate-limit / hardening header checks
    probe.ts                  optional 2nd pass: submit bad data, capture real errors
    dom-selectors.ts           builds CSS selectors for fields from crawl data
    artifacts/
      schema.ts               FormModel -> JSON Schema
      vecs.ts                  FormModel -> VECS markdown
      stories.ts               FormModel -> draft user story
      write.ts                  writes report.json, report.md, forms/*
    index.ts                   orchestrator: runFormRecon(config)
  cli.ts                      standalone test harness (no dsh required)
  adapter/
    dsh-plugin.ts              thin dsh/Cordis binding — verify against
                                 real dsh docs before relying on it
```

The framework binding is isolated to `adapter/dsh-plugin.ts`. Everything
under `core/` is plain, dependency-light TypeScript you can run, test, and
debug on its own.

## Try it standalone first

```bash
npm install
cat > recon.config.json <<'EOF'
{
  "baseUrl": "https://staging.example.com/dashboard",
  "outDir": "./out",
  "maxPages": 15,
  "headless": true,
  "auth": {
    "mode": "standard",
    "loginUrl": "https://staging.example.com/login",
    "usernameSelector": "#email",
    "passwordSelector": "#password",
    "submitSelector": "button[type=submit]",
    "successSelector": "#dashboard-root",
    "username": "test-user@example.com",
    "password": "REDACTED"
  }
}
EOF
npm run cli -- recon.config.json
```

This writes `out/report.md`, `out/report.json`, and per-form artifacts under
`out/forms/`.

## Auth modes

- **`standard`** — CSS selectors for a username/password form. Fully
  automated, and the only mode exposed through the dsh tool-call schema
  (JSON-only input).
- **`oauth`** — you supply a `driveFlow(page)` callback that drives
  Playwright through your provider's consent screen. Necessarily manual per
  provider; there's no generic way to automate this.
- **`custom`** — you supply a full `run(page)` login routine, for anything
  else (multi-step, MFA you already solve programmatically, etc.).

`oauth` and `custom` take live functions, so they can't be expressed as JSON
tool-call input — call `runFormRecon` directly from a small script if you
need them, rather than going through the dsh tool binding.

## Second pass: real error messages (`probeValidation`)

By default the tool only *infers* error text from HTML attributes
(`required`, `pattern`, etc.) — it never touches the target beyond reading
the DOM. Turning on `probeValidation` adds an active second pass: for each
constrained field, it fills the rest of the form with valid-looking dummy
data, gives that one field a deliberately bad value (empty, if it's
required; malformed, if it has a pattern/type/length constraint), and
submits.

```json
{
  "probeValidation": true,
  "allowRealSubmissions": false,
  "maxFieldsPerFormToProbe": 10,
  "skipDestructiveForms": true
}
```

**This is dry-run by default.** The moment the form's submit request fires,
it's intercepted and aborted before it leaves the browser — so you learn
whether *client-side* validation caught the bad value, without any request
ever reaching the server. Set `allowRealSubmissions: true` to let it
through and capture the real server-rendered error text instead. Only do
this against something you're authorized to actively test.

A few consequences worth knowing before you flip that switch:

- **A "bad" value might not actually be rejected.** If a field has no real
  server-side validation, your deliberately invalid value could get
  accepted — meaning a live run may create a real record. Each observation
  has a `possiblySucceeded` flag for exactly this case (no error appeared,
  and the page navigated away while live submissions were allowed) — treat
  those as "go check by hand," not as confirmed passes.
- **Destructive-looking forms are skipped automatically**, even with
  `allowRealSubmissions: true` — anything whose action/labels match
  delete/purchase/charge/transfer/cancel-subscription patterns. Override
  with `skipDestructiveForms: false` only for a form you've reviewed
  yourself.
- **Selectors are best-effort.** Fields are targeted by `id`, then `name`
  (+ `value` for radio groups), then a tag/type fallback if neither exists.
  Custom form components (React date pickers, combobox libraries) that
  don't expose a native `<input>`/`<select>` under the hood won't be
  fillable this way — those observations will just show no effect.

The VECS docs merge these results in automatically: rows show `✅ observed`
when the probe ran and got a real answer, `⚠️ dry-run` when it only
confirmed client-side behavior, `⚠️ inferred` when the probe never ran for
that field, and `🚩` when a value's fate is genuinely unclear and needs a
human look.

## What's heuristic vs. observed

- **CSRF detection** is name-based (`csrf`, `_token`, `authenticity_token`,
  etc. in hidden fields) — a form using an unconventional token name won't
  be flagged. Check `security.hasCsrfToken === false` results by hand.
- **Field dependencies** ("field A enables field B") are flagged from the
  *presence* of change/conditional-render attributes, not resolved — the
  tool tells you a field looks conditional, not what controls it.
- **Error message text** in the VECS docs is inferred from validation
  attributes (`required`, `pattern`, etc.), not observed from real
  submissions. Treat it as a first draft.
- **JS-rendered form detection** compares the DOM at `domcontentloaded` vs.
  after `networkidle` — forms that appear later (e.g. after a user action,
  not just page load) won't be caught by this pass.

## Wiring into dsh

`src/adapter/dsh-plugin.ts` has a placeholder `apply(ctx, config)` using a
guessed `ctx.tool.define(...)` call. Check the real registration API in the
`dsh` repo's `docs/architecture.md` or an existing tool plugin (e.g.
`dsh-tool-csv`) and adjust that one function — nothing else in the package
depends on it.
