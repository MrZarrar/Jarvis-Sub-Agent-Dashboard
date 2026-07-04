---
paths:
  - "wiki/index.html"
  - "wiki/script.js"
  - "wiki/i18n-content.js"
---

# Wiki Internationalization Rules

The static wiki (`wiki/index.html`) is fully localized to English, Simplified
Chinese (`zh`), and Vietnamese (`vi`). English is the DOM source of truth;
`wiki/script.js` swaps text at runtime. **Any new or changed user-visible wiki
text MUST ship with `zh` + `vi` translations in the same change** - otherwise it
falls back to English and the page is half-translated.

## When you add or edit content in `wiki/index.html`

- The scannable layer - `.section-label`, `.nav-section`, `h2/h3/h4`,
  `.hero-desc`, `.nav-link`, `.hero-badge` - is keyed by plain text in the `T`
  dictionary inside `wiki/script.js`. Add the new English text as a key with its
  `zh` and `vi` values there.
- Body content - `.main-content p:not(.hero-desc)`, `li`, `td`, `th`,
  `.screenshot-caption`, `.callout-body > strong`, `.route-desc`, and the footer
  (`.wiki-footer .footer-note / .footer-col-title / .footer-col-links a`) - is
  keyed by **whitespace-normalized `innerHTML`** in `wiki/i18n-content.js`
  (`window.__WIKI_CONTENT_I18N`). Add an entry to `zh` and `vi` whose **key is
  the element's `innerHTML` with every whitespace run collapsed to one space and
  ends trimmed**, and whose value keeps every inline tag (`<code>`, `<strong>`,
  `<a>`, `<span>`) in the same position.
- If you introduce a **new content container/class**, add its selector to
  `HTML_SEL` in `wiki/script.js` so the engine translates it.

## What stays English (do NOT translate)

Anything inside `<code>`, commands, file/dir paths, URLs, env-var names, HTTP
methods/status codes, numbers + units, CLI flags, code identifiers, brand/product
names, hook event names (`PreToolUse`, `Stop`, …), and tool names (`Bash`,
`Agent`). Translate only the prose around them. A block that is entirely
code/identifier/product-name needs no entry (it correctly falls back to English).

## Verify, then bust caches

- Verify coverage against the live DOM with `jsdom` (already in
  `client/node_modules`): load `index.html`, run the `HTML_SEL` selectors with
  the same `norm(s) = s.replace(/\s+/g," ").trim()`, and confirm every
  real-prose block matches a dictionary key. Misses that are pure
  code/identifiers are fine; prose misses are bugs.
- The service worker is cache-first. After editing `index.html`, `script.js`, or
  `i18n-content.js`, bump the asset query strings (`script.js?v=N`,
  `i18n-content.js?v=N`) in `index.html` AND bump `CACHE_NAME` in `wiki/sw.js`,
  or returning users keep the stale bundle.
- Run `npm run format` before committing (the static wiki files are Prettier-managed).
