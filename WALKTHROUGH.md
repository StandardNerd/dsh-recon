# Walkthrough: how `dsh-form-recon` works, start to finish

This doc assumes you can code, but have never used Playwright, never poked
at `dsh`'s plugin system, and maybe haven't thought about CSRF tokens or
JSON Schema in a while. It walks through every file in the order the *data*
flows through them, not the order they sit in the folder — that's the order
that actually makes sense when you're learning it for the first time.

---

## 1. The one-picture version

```
 login()  ->  discoverPages()  ->  analyzePage()  ->  inspectSecurity()  ->  probeFormValidation()  ->  writeArtifacts()
 (auth.ts)    (discover.ts)        (analyze.ts)        (security.ts)          (probe.ts, optional)      (artifacts/write.ts)
    |               |                    |                    |                       |                        |
    v               v                    v                    v                       v                        v
 opens a        finds every         for each page,      checks response         for each risky        writes report.md,
 session        same-site link      pulls out every      headers for CSRF,      field, submits         report.json, and
 (cookies       it can reach        <form> and its       rate limits, and       bad data and sees      one schema/VECS/
 carried by     from the start      fields, flags        security headers      what happens            story file per form
 the browser    page                JS-only forms
 context)
```

Everything runs inside **one Playwright browser tab** (a `Page` object)
that gets reused for the whole pipeline — that's what makes the login
session carry through automatically to every later step, the same way it
would if you were doing this by hand in a real browser.

---

## 2. Five concepts worth knowing before you read the code

**Playwright** is a library that drives a real (headless, meaning
invisible) Chromium browser from code. `page.goto(url)` navigates it,
`page.fill(selector, text)` types into a field, `page.click(selector)`
clicks something, `page.$$eval(selector, fn)` runs a function *inside the
browser* against every matching element and returns the result to your
Node.js code. That last one is how almost all of the form-reading in this
project works — the code that reads field attributes is written as a
JavaScript function, but it executes in the browser's DOM, not in Node.

**CSS selectors** are just "how you point at an element" -- `#email` means
"the element with `id="email"`", `[name="foo"]` means "the element with
`name="foo"`", `form:nth-of-type(2)` means "the second `<form>` on the
page". `src/core/dom-selectors.ts` builds these strings so the rest of the
code can say "go click this field" without repeating that logic everywhere.

**HTML5 constraint validation** is the browser's built-in form validation --
when a field has `required` or `pattern="..."`, the browser itself refuses
to submit and shows a little bubble with a message. That message is
readable from code as `element.validationMessage`. This project reads that
value directly (see `probe.ts`) instead of trying to guess what the browser
would say.

**CSRF tokens** are hidden form fields (usually named something like
`csrf_token` or `authenticity_token`) that prove a form submission came
from the app's own page, not from some other website tricking your browser
into submitting on your behalf. Their presence (or absence) is a basic
security signal, which is why `security.ts` checks for them.

**JSON Schema** is just a standard way to describe "what shape of data is
valid here" as JSON -- `{"type": "string", "format": "email", "required":
true}` and so on. Lots of tools (form generators, API validators, test data
generators) can consume it directly, which is why it's one of the output
formats.

---

## 3. Walking the files in execution order

### `src/types.ts` -- the shared vocabulary

Nothing runs here -- it's just TypeScript `interface` definitions. Worth
skimming once so the shapes below make sense: `FormField` (one input),
`FormModel` (one `<form>` and all its fields), `SecurityFindings`,
`ValidationObservation` (one probe result), and `ReconConfig` (everything
you pass in to configure a run).

### `src/core/auth.ts` -- getting logged in

```ts
export async function login(page: Page, auth: AuthConfig): Promise<void>
```

Three modes, picked by `auth.mode`:

- **`standard`** -- the fully automatic path. You give it CSS selectors for
  the username field, password field, and submit button, plus a
  `successSelector` that only exists once you're actually logged in (a
  dashboard heading, a logout button, anything reliable). It fills, clicks,
  and then waits for that selector to appear -- if it never shows up within
  15 seconds, `login()` throws with a message telling you to check your
  selectors or credentials.
- **`oauth`** -- you write a small function (`driveFlow`) that does whatever
  your provider's login screen needs; the harness just calls it and then
  checks the same `successSelector`. This can't be generic because every
  OAuth provider's consent screen looks different.
- **`custom`** -- same idea as OAuth but for anything else weird (multi-step
  forms, a CAPTCHA you solve some other way, etc.) -- you own the whole
  `run(page)` function.

### `src/core/discover.ts` -- finding pages to crawl

```ts
export async function discoverPages(page, startUrl, maxPages, requestDelayMs): Promise<string[]>
```

This is a textbook **breadth-first search** over links: start at
`startUrl`, visit it, collect every `<a href>` on the page, keep the ones
pointing at the same origin (so it won't wander off to
`accounts.google.com` or wherever), and repeat until it's visited
`maxPages` pages or run out of new links. `requestDelayMs` just adds a
pause between visits so you're not hammering the target.

Because it reuses the same `page` (and therefore the same browser context
and cookies) that `login()` just authenticated, every page it visits is
visited *as the logged-in user* -- no extra work needed for that.

### `src/core/analyze.ts` -- reading every form on a page

This is the densest file, so here's the shape of it:

```ts
export async function analyzePage(page: Page, url: string): Promise<FormModel[]>
```

It does something slightly clever to catch JavaScript-rendered forms:

1. Navigate to the page and immediately extract all `<form>` elements --
   this is what exists in the *raw server HTML*, before any JavaScript has
   had a chance to add more forms to the page.
2. Wait for the network to go quiet (`networkidle` -- Playwright's way of
   saying "nothing's loading anymore").
3. Extract forms *again*.
4. Any form present in step 3 but not step 1 gets `renderedByJs: true`.

The actual field-reading happens in `extractForms`, inside a
`page.$$eval(...)` call -- remember, that function body runs *in the
browser*, which is why you'll see plain DOM APIs like
`document.querySelector` and `el.getAttribute(...)` instead of Playwright
calls. For every `<input>`, `<select>`, and `<textarea>` inside a form, it
reads:

- `name`, `id`, `type`, `required`, `disabled`, `placeholder`
- validation attributes: `pattern`, `minLength`, `maxLength`, `min`, `max`, `step`
- the associated `<label>` text (checked two ways: `label[for=id]` and a
  parent `<label>` wrapping the input)
- for `<select>`, all the `<option>` values/labels
- whether it carries any change/conditional-render attributes
  (`onchange`, `data-show-if`, Alpine's `x-show`, etc.) -- if so, it's
  flagged as a **suspected dependency** (see `suspectedDependency` in
  `types.ts`). This is a *flag*, not proof -- the code can see "something
  reactive is attached here" but can't resolve what actually controls it.
- whether a hidden field's name looks like a CSRF token (`csrf`, `_token`,
  `authenticity_token`, etc.) -- flagged as `suspectedCsrfToken`, and
  excluded from the "real" fields shown in the VECS docs and JSON Schema
  later, since it's plumbing, not user input.

### `src/core/security.ts` -- a quick security posture check

```ts
export async function inspectSecurity(page, url, forms): Promise<SecurityFindings>
```

This re-navigates to the page (to get a fresh `Response` object with
headers) and checks three things: does any form on the page have a
CSRF-token-shaped hidden field (cross-referencing what `analyze.ts` already
flagged), are there rate-limit headers (`Retry-After`,
`X-RateLimit-Remaining`, etc.), and are the standard hardening headers
present (`Content-Security-Policy`, `X-Frame-Options`, and so on -- these
are recorded even when *absent*, specifically so a gap is visible in the
report rather than just missing).

### `src/core/probe.ts` -- the optional "does this actually work" pass

This one's worth its own section below (S5), since it's the newest and
most involved piece.

### `src/core/artifacts/*.ts` -- turning `FormModel` into documents

Three independent generators, each taking a `FormModel` and returning a
string or object:

- **`schema.ts`** -> `formToJsonSchema(form)` -- maps each field's type/
  constraints onto standard JSON Schema keywords (`type`, `format`,
  `pattern`, `minLength`, `enum` for selects, etc.), skips CSRF fields, and
  tucks crawl metadata (page URL, action, method) under an `x-form-meta`
  key so the schema stays valid JSON Schema while still carrying that
  context.
- **`vecs.ts`** -> `formToVecsMarkdown(form)` -- one Markdown table per form,
  one row per field: constraints, error text (real if the probe ran,
  inferred otherwise -- see S5), and "states" (disabled / conditional /
  normal).
- **`stories.ts`** -> `formToUserStory(form)` -- guesses the form's *intent*
  from its field names (login? payment? search? newsletter signup?) and
  writes a story like "As a / I want to / So that" plus a handful of Given/
  When/Then acceptance criteria seeded from the required fields and
  patterns it found.

`write.ts` calls all three for every form, plus writes a top-level
`report.json` (the full `ReconResult`, unmodified -- the machine-readable
output) and `report.md` (a human-readable summary with links to each
form's generated files).

### `src/core/index.ts` -- the conductor

`runFormRecon(config)` is the one function that calls everything above, in
order, for every page the crawler finds:

```
launch browser -> login -> discoverPages -> for each page:
  analyzePage -> inspectSecurity -> (if enabled) probeFormValidation
-> writeArtifacts -> close browser
```

It's deliberately plain -- no `dsh` imports at all -- so you can call it
from a one-line script, from the CLI, or eventually from the real harness,
and it behaves identically.

### `src/cli.ts` -- running it without `dsh` at all

Just reads a JSON config file and calls `runFormRecon`. This exists so you
can develop and debug the whole pipeline with `npm run cli -- config.json`
before you've even looked at how `dsh` plugins register themselves.

### `src/adapter/dsh-plugin.ts` -- the (unverified) harness binding

This is the one file that pretends to know `dsh`'s plugin API, and it says
so in a comment at the top -- it's built on the general Cordis pattern
(`export const name`, `export function apply(ctx, config)`, register a
capability on `ctx`), but the specific call
(`ctx.tool?.define?.("form_recon.run", {...})`) is a best guess, not a
verified fact, because `dsh` is only a few weeks old. Everything it does is
delegate to `runFormRecon` -- so once you find the real registration call
in `dsh`'s own docs or an existing tool plugin, this file is the only thing
you need to touch.

---

## 4. Following one form through the whole pipeline

Say the crawler hits `https://staging.example.com/signup` and finds:

```html
<form id="signup" method="post" action="/api/signup">
  <input type="hidden" name="csrf_token" value="abc123">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required>
  <label for="pw">Password</label>
  <input id="pw" name="pw" type="password" required minlength="8">
  <button type="submit">Create account</button>
</form>
```

1. **`analyze.ts`** produces a `FormModel` with two real fields (`email`,
   `pw`) and one CSRF field, `renderedByJs: false` (it's in the raw HTML).
2. **`security.ts`** sees the `csrf_token` hidden field -> `hasCsrfToken:
   true`. It also checks the page's response headers.
3. If `probeValidation` is on, **`probe.ts`** tries, e.g., submitting with
   `email` empty (missing-required) and with `email` set to
   `"not-an-email"` (invalid-format), each time filling `pw` with a valid
   dummy value first.
4. **`schema.ts`** emits:
   ```json
   {
     "type": "object",
     "properties": {
       "email": { "type": "string", "format": "email", "title": "Email" },
       "pw": { "type": "string", "minLength": 8, "title": "Password" }
     },
     "required": ["email", "pw"]
   }
   ```
5. **`vecs.ts`** emits a table row for `email` showing either
   `warning inferred: "Email is required"` (if the probe never ran) or
   something like `observed (missing-required): "Please fill out this
   field"` (the browser's real HTML5 message, if it did).
6. **`stories.ts`** guesses this is a signup/auth form from the field names
   and writes a story like "As a user, I want to authenticate via the
   'signup' form, so that I can complete the corresponding workflow..."
   with acceptance criteria for the two required fields.

---

## 5. The validation prober, in detail

The problem it solves: everything above *infers* error messages from HTML
attributes. `required` almost certainly produces some "this field is
required" message, but the exact wording is a guess. The prober replaces
guesses with the real thing -- at a cost, because it means actually
submitting the form.

For one field, one test case, here's what happens inside the loop in
`probeFormValidation`:

1. **Reset.** Navigate back to the form's page fresh, so nothing carries
   over from the previous field's test.
2. **Fill everything else validly.** Every *other* field gets a plausible
   valid value (`validValueFor()` -- a real-looking email, a number inside
   `min`/`max`, today's date, etc.), so the *only* thing that could cause a
   validation failure is the field under test.
3. **Break the target field.** Either clear it (`missing-required`) or set
   it to something that violates its own constraint (`invalid-format` --
   `"not-an-email"` for an email field, a too-long string for `maxLength`,
   and so on).
4. **Snapshot the page's error-looking text** (anything matching
   `[role="alert"]`, `.error`, `[aria-live]`, etc.) *before* submitting --
   this is the baseline to diff against.
5. **Arm a network interceptor** for exactly this form's submit URL --
   `page.route(matcher, handler)`. This is the safety mechanism: the
   handler runs the instant a matching request is about to be sent, and by
   default it just calls `route.abort()` -- the request never leaves the
   browser. If `allowRealSubmissions: true`, it instead calls
   `route.fetch()` (send it for real, get the response) and
   `route.fulfill({response})` (hand that real response back to the page as
   if nothing special happened).
6. **Click submit**, wait ~600ms for anything to render.
7. **Read `validationMessage`** directly off the field -- if the browser's
   own constraint validation blocked the submission, this is non-empty and
   *no* network request will have fired at all.
8. **Snapshot error text again**, diff against the baseline -- anything new
   is a strong signal it's a real, freshly-rendered error message.
9. **Decide `possiblySucceeded`**: this is only set when a live submission
   was allowed, nothing was flagged as an error, and the browser ended up
   navigating away from the form page -- i.e., the "invalid" data might
   have gone through as a real signup/whatever. This is the one result
   that genuinely needs a human to go check, since the tool has no way to
   know your app's success/failure conventions.
10. **Remove the interceptor** and move to the next test case.

Two safety defaults exist specifically because step 5/9 can have real
consequences: `allowRealSubmissions` defaults to `false` (so nothing ever
reaches the server unless you say so explicitly), and `looksDestructive()`
skips any form whose action or button text mentions delete/purchase/charge/
cancel-subscription/etc., *even if* you've turned real submissions on --
because "accidentally probe the delete-account form with
allowRealSubmissions: true" is exactly the kind of mistake this exists to
prevent.

---

## 6. Try it on something safe first

Before pointing this at anything real, it's worth running it against a
throwaway target you fully control, just to see the output shape. A
two-file local test app works fine:

```bash
mkdir practice-target && cd practice-target
cat > server.js <<'EOF'
const http = require("http");
http.createServer((req, res) => {
  if (req.url === "/login" && req.method === "GET") {
    res.end(`<html><body>
      <form id="login" method="post" action="/login">
        <input id="user" name="user" type="text" required>
        <input id="pass" name="pass" type="password" required minlength="6">
        <button type="submit">Sign in</button>
      </form>
    </body></html>`);
  } else if (req.url === "/login" && req.method === "POST") {
    res.writeHead(302, { Location: "/dashboard" });
    res.end();
  } else if (req.url === "/dashboard") {
    res.end(`<html><body><h1 id="dashboard-root">Welcome</h1>
      <form id="contact" method="post" action="/contact">
        <input id="email" name="email" type="email" required>
        <textarea id="msg" name="msg" required minlength="10"></textarea>
        <button type="submit">Send</button>
      </form>
    </body></html>`);
  } else {
    res.writeHead(404); res.end();
  }
}).listen(3000, () => console.log("http://localhost:3000"));
EOF
node server.js
```

Then, in the plugin folder:

```bash
npm install
cat > recon.config.json <<'EOF'
{
  "baseUrl": "http://localhost:3000/dashboard",
  "outDir": "./out",
  "maxPages": 5,
  "headless": true,
  "probeValidation": true,
  "auth": {
    "mode": "standard",
    "loginUrl": "http://localhost:3000/login",
    "usernameSelector": "#user",
    "passwordSelector": "#pass",
    "submitSelector": "button[type=submit]",
    "successSelector": "#dashboard-root",
    "username": "anything",
    "password": "anything"
  }
}
EOF
npm run cli -- recon.config.json
```

Then open `out/report.md` and `out/forms/` and see what came out. Because
this toy server accepts any credentials and doesn't render real error
messages, you'll mostly see dry-run rows in the VECS doc -- that's
expected, and a good way to *see* the difference between dry-run and a real
target before you rely on it.

---

## 7. Troubleshooting

- **`login() ... never appeared`** -- your `successSelector` doesn't exist,
  or one of the other selectors is wrong. Run with `headless: false` in the
  config temporarily and watch the browser do its thing.
- **A field never gets filled during probing** -- check whether it's a
  custom component (a React date-picker, a styled dropdown library) rather
  than a plain `<input>`/`<select>`; `dom-selectors.ts` only targets native
  form controls.
- **Everything shows up as dry-run** -- that's correct behavior when
  `allowRealSubmissions` is unset or `false`. Only turn it on against a
  target you're sure it's fine to actually submit to.
- **The crawler stops early** -- `maxPages` defaults to 25; raise it, or
  check whether the app's navigation uses `<button onclick>` instead of
  real `<a href>` links, which `discoverPages` won't follow.

---

## 8. Where to go from here

- Point `src/adapter/dsh-plugin.ts` at the real registration API once
  you've checked `dsh`'s own docs -- everything else keeps working
  unchanged.
- The `suspectedDependency` flag is deliberately shallow (it just notices
  *that* something reactive is attached). A fun follow-up project: actually
  toggle the suspected controlling field and see what changes, the same
  way `probe.ts` toggles field values to observe results.
- `looksDestructive()` and the dummy-value generators in `probe.ts` are
  simple heuristics -- tune the regexes/values for your own app's
  conventions as you use this for real.
