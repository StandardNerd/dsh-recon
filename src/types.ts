// Shared types used across auth, discovery, analysis, and artifact generation.

export type AuthMode = "standard" | "oauth" | "custom";

export interface StandardAuthConfig {
  mode: "standard";
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  /** CSS selector that only appears once login succeeded (e.g. a dashboard element). */
  successSelector: string;
  username: string;
  password: string;
}

export interface OAuthAuthConfig {
  mode: "oauth";
  /** URL that kicks off the OAuth flow (e.g. "Sign in with X" button target). */
  authorizeUrl: string;
  /**
   * OAuth flows vary too much to fully automate generically (consent screens,
   * MFA, provider-specific DOM). Supply a callback that drives Playwright's
   * `page` through your provider's flow; the harness awaits it, then verifies
   * `successSelector` is present.
   */
  driveFlow: (page: import("playwright").Page) => Promise<void>;
  successSelector: string;
}

export interface CustomAuthConfig {
  mode: "custom";
  /** Full custom login routine (e.g. multi-step, MFA, CAPTCHA-gated flows you already solve). */
  run: (page: import("playwright").Page) => Promise<void>;
  successSelector: string;
}

export type AuthConfig = StandardAuthConfig | OAuthAuthConfig | CustomAuthConfig;

export interface ReconConfig {
  baseUrl: string;
  auth: AuthConfig;
  /** Max distinct pages to crawl within the same origin. */
  maxPages?: number;
  /** Delay between page visits, in ms — be polite to the target. */
  requestDelayMs?: number;
  /** Directory to write artifacts into. */
  outDir: string;
  headless?: boolean;

  /**
   * Run the second-pass validation prober (fills each constrained field with
   * bad data and submits, to capture real error text). Defaults to false —
   * this is an active, opt-in step, not part of the basic crawl.
   */
  probeValidation?: boolean;
  /**
   * If true, "bad data" submissions are allowed to actually reach the
   * server so real error text can be captured. If false (default), the
   * network request is intercepted and aborted right as it fires — you
   * still learn whether client-side validation caught it, but nothing is
   * ever sent. Only set this true against apps you're authorized to test,
   * and expect it to occasionally create real records if a field turns out
   * to accept the "invalid" value anyway (see `possiblySucceeded` on each
   * observation).
   */
  allowRealSubmissions?: boolean;
  /** Cap on how many fields per form the prober touches. Default 10. */
  maxFieldsPerFormToProbe?: number;
  /**
   * Skip forms that look destructive/financial (delete, purchase, charge,
   * transfer, ...) during probing, even if allowRealSubmissions is true.
   * Default true. Turn off only for a form you've reviewed by hand.
   */
  skipDestructiveForms?: boolean;
}

export interface FieldOption {
  value: string;
  label: string;
}

export interface FormField {
  name: string;
  id?: string;
  tag: "input" | "select" | "textarea";
  type: string; // text, email, password, checkbox, radio, select-one, textarea, hidden, ...
  label?: string;
  required: boolean;
  disabled: boolean;
  placeholder?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  options?: FieldOption[];
  defaultValue?: string;
  /** Heuristic flag: attribute/handler evidence this field's state depends on another field. */
  suspectedDependency?: {
    onAttributes: string[]; // e.g. ["onchange", "data-show-if"]
    note: string;
  };
  /** Heuristic flag: looks like a CSRF/anti-forgery token field. */
  suspectedCsrfToken: boolean;
}

export interface FormModel {
  pageUrl: string;
  formIndex: number;
  id?: string;
  name?: string;
  action: string;
  method: string;
  enctype?: string;
  fields: FormField[];
  submitButtons: { text: string; selector: string }[];
  /** True if the form only appeared after JS execution / network idle (not in initial HTML). */
  renderedByJs: boolean;
  /** Populated only when `probeValidation` is enabled — see ValidationObservation. */
  validationObservations?: ValidationObservation[];
}

export type ValidationTestCase = "missing-required" | "invalid-format" | "skipped";

export interface ValidationObservation {
  fieldName: string;
  testCase: ValidationTestCase;
  /** The deliberately bad value used, if any (empty string for the "missing" case). */
  testValue?: string;
  /** True if the browser's built-in constraint validation blocked submission before any request fired. */
  clientBlocked: boolean;
  /** Native `validationMessage` text from the browser's constraint validation API, if any. */
  clientValidationMessage?: string;
  /** True if a request matching the form's action was seen at all (live or aborted). */
  requestAttempted: boolean;
  /** True if that request was actually let through to the server rather than aborted. */
  requestAllowedLive: boolean;
  /** HTTP status of the live response, only set when requestAllowedLive is true. */
  responseStatus?: number;
  /** Error-like text that appeared on the page after the attempt that wasn't there before. */
  observedErrorTexts: string[];
  /**
   * True when a live submission was allowed, nothing flagged it as an error,
   * and the page navigated away — i.e. the "invalid" value may have actually
   * been accepted. Worth checking by hand.
   */
  possiblySucceeded: boolean;
  notes: string;
}

export interface SecurityFindings {
  pageUrl: string;
  hasCsrfToken: boolean;
  csrfFieldNames: string[];
  securityHeaders: Record<string, string | undefined>;
  rateLimitHeaders: Record<string, string | undefined>;
  formsSubmitOverHttps: boolean;
}

export interface PageReport {
  url: string;
  forms: FormModel[];
  security: SecurityFindings;
}

export interface ReconResult {
  baseUrl: string;
  crawledAt: string;
  pages: PageReport[];
}
