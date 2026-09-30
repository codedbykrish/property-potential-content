/**
 * Reads the text of one listing page you supply, as a research source for facts.
 * It never downloads the page's photos (they belong to the agent or photographer),
 * and it refuses property portals whose terms forbid automated access.
 */

const BLOCKED_HOSTS = ["rightmove.co.uk", "zoopla.co.uk", "onthemarket.com", "primelocation.com"];

export function checkListingUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`Unsupported URL scheme: ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  const blocked = BLOCKED_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
  if (blocked) {
    throw new Error(
      `${blocked} listings aren't supported: its terms forbid automated access. ` +
        `Use the estate agent's own page, or put the facts in the brief's "facts" section.`,
    );
  }
}

/** Turns listing HTML into readable text. Drops scripts, styles, images and navigation chrome. */
export function htmlToText(html: string): string {
  let s = html;
  // Keep JSON-LD: agent sites often publish price, beds and address there.
  const jsonLd = [...s.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim());
  s = s.replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<img[^>]*>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&pound;/g, "£")
    .replace(/&#163;/g, "£")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const text = jsonLd.length ? `${s}\n\n[Structured data]\n${jsonLd.join("\n")}` : s;
  return text.slice(0, 60_000);
}

export async function fetchListing(url: string, fetchImpl: typeof fetch = fetch): Promise<{ html: string; text: string }> {
  checkListingUrl(url);
  const res = await fetchImpl(url, {
    headers: {
      "user-agent": "PropertyPotentialContentAgent/0.1 (single page research; contact via propertypotential)",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Fetching ${url} failed: HTTP ${res.status}`);
  const html = await res.text();
  return { html, text: htmlToText(html) };
}
