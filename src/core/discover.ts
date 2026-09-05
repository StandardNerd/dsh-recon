import type { Page } from "playwright";

/**
 * Breadth-first crawl of same-origin links starting at `startUrl`, using the
 * already-authenticated `page`'s browser context for every navigation so the
 * session cookie/token carries over.
 */
export async function discoverPages(
  page: Page,
  startUrl: string,
  maxPages: number,
  requestDelayMs: number
): Promise<string[]> {
  const origin = new URL(startUrl).origin;
  const visited = new Set<string>();
  const queue: string[] = [startUrl];
  const found: string[] = [];

  while (queue.length > 0 && found.length < maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
    } catch {
      continue; // dead link, redirect loop, or timeout — skip and move on
    }

    found.push(page.url()); // record post-redirect canonical URL

    const links: string[] = await page.$$eval("a[href]", (as) =>
      as.map((a) => (a as HTMLAnchorElement).href)
    );

    for (const link of links) {
      try {
        const u = new URL(link);
        if (u.origin === origin && !visited.has(u.href) && !u.href.includes("#")) {
          queue.push(u.href);
        }
      } catch {
        // ignore malformed hrefs (mailto:, javascript:, etc.)
      }
    }

    if (requestDelayMs > 0) {
      await page.waitForTimeout(requestDelayMs);
    }
  }

  return found;
}
