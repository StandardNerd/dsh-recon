import type { Page } from "playwright";
import type { AuthConfig } from "../types.js";

/**
 * Logs into the target app using whichever auth mode is configured.
 * Throws if the post-login success selector never appears.
 */
export async function login(page: Page, auth: AuthConfig): Promise<void> {
  switch (auth.mode) {
    case "standard":
      await page.goto(auth.loginUrl, { waitUntil: "domcontentloaded" });
      await page.fill(auth.usernameSelector, auth.username);
      await page.fill(auth.passwordSelector, auth.password);
      await Promise.all([
        page.waitForLoadState("networkidle"),
        page.click(auth.submitSelector),
      ]);
      break;

    case "oauth":
      await page.goto(auth.authorizeUrl, { waitUntil: "domcontentloaded" });
      await auth.driveFlow(page);
      break;

    case "custom":
      await auth.run(page);
      break;
  }

  await page.waitForSelector(auth.successSelector, { timeout: 15_000 }).catch(() => {
    throw new Error(
      `Login did not reach success state (selector "${auth.successSelector}" never appeared). ` +
        `Check credentials, selectors, or whether MFA/CAPTCHA interrupted the flow.`
    );
  });
}
