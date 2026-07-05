/**
 * @file link-preview.js
 * @description URL preview cards for chat (Phase Q2): fetch a page's OpenGraph
 * tags server-side and return { url, title, description, image, siteName }.
 *
 * SSRF hygiene (this server lives next to other local services):
 *   - http/https only, and the hostname must resolve to PUBLIC addresses -
 *     loopback, RFC1918, link-local, CGNAT, and their IPv6 equivalents are all
 *     rejected, so a crafted URL can never probe localhost or the LAN.
 *   - redirects are followed manually (max 3) and EVERY hop re-validates the
 *     same rules - no redirect-to-private-range escape.
 *   - 5s timeout, 128KB body cap, HTML content only.
 *
 * ponytail: hostname is validated by DNS lookup before fetch; the fetch itself
 * re-resolves (a rebinding-TOCTOU window). Acceptable here: the route sits
 * behind the first-party same-origin guard, so the attacker would already be
 * the user. Pin the resolved IP via a custom Agent if this ever goes remote.
 *
 * @author Jarvis (Phase Q2)
 */

const dns = require("node:dns/promises");
const net = require("node:net");

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 128 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

// url → { at, data }. Small enough to keep forever-resident.
const cache = new Map();

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const low = ip.toLowerCase();
  if (low === "::" || low === "::1") return true;
  if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1)
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/** Throws unless the URL is http(s) AND its host resolves only to public IPs. */
async function assertSafeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http/https URLs are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("private addresses are not allowed");
    return url;
  }
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("private hostnames are not allowed");
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error("hostname does not resolve");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("private addresses are not allowed");
  }
  return url;
}

/** Read up to MAX_BODY_BYTES of a response body as text. */
async function readCapped(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      break;
    }
  }
  return out;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

/** Pull og:/twitter: meta + <title> out of an HTML head. Regex is fine here -
 *  we only need the common well-formed cases; anything else yields nulls. */
function parseMeta(html, finalUrl) {
  const meta = {};
  const re =
    /<meta\s+[^>]*?(?:property|name)=["']((?:og|twitter):[\w:]+)["'][^>]*?content=["']([^"']*)["'][^>]*?>/gi;
  const reFlip =
    /<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']((?:og|twitter):[\w:]+)["'][^>]*?>/gi;
  let m;
  while ((m = re.exec(html))) meta[m[1].toLowerCase()] ??= m[2];
  while ((m = reFlip.exec(html))) meta[m[2].toLowerCase()] ??= m[1];
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);

  let image = meta["og:image"] || meta["twitter:image"] || null;
  if (image) {
    try {
      image = new URL(image, finalUrl).href; // resolve relative image URLs
      if (!/^https?:$/.test(new URL(image).protocol)) image = null;
    } catch {
      image = null;
    }
  }
  return {
    url: finalUrl,
    title: decodeEntities(meta["og:title"] || meta["twitter:title"] || titleTag?.[1] || "") || null,
    description:
      decodeEntities(meta["og:description"] || meta["twitter:description"] || "") || null,
    image,
    siteName: decodeEntities(meta["og:site_name"] || "") || null,
  };
}

/**
 * Fetch a preview for `raw`. Returns the parsed card, or throws with an honest
 * message. Results (and failures-as-null are NOT cached; only successes are).
 */
async function fetchLinkPreview(raw) {
  const hit = cache.get(raw);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let url = await assertSafeUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response;
    for (let hop = 0; ; hop++) {
      response = await fetch(url.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "JarvisDashboard/1.0 (+link-preview)", Accept: "text/html" },
      });
      if (response.status >= 300 && response.status < 400) {
        const loc = response.headers.get("location");
        if (!loc || hop >= MAX_REDIRECTS) throw new Error("too many redirects");
        url = await assertSafeUrl(new URL(loc, url).href); // re-validate every hop
        continue;
      }
      break;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get("content-type") || "";
    if (!type.includes("text/html")) throw new Error("not an HTML page");
    const html = await readCapped(response);
    const data = parseMeta(html, url.href);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(raw, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchLinkPreview, __isPrivateIp: isPrivateIp, __assertSafeUrl: assertSafeUrl };
