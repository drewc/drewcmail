# @spinal/shadow-css (`packages/@spinal/shadow-css`)

Copied from ecm-live (`app/spa/packages/@spinal/shadow-css`); keep the two in step. Used by `vite.config.js`
(imported by path — the package's `exports` point at an `index.js` that does not exist).

A Vite plugin (`cssShadowDOM()` in `vite.config.js`) that makes document-oriented CSS usable inside Shadow DOM
and lifts back into the document what cannot live in a shadow root. One file: `index.ts`.

## What it does

Components import stylesheets with `?inline` and adopt them into their shadow roots (`src/components/base.ts`:
`tailwind.css` and `@fortawesome/fontawesome-free/css/all.min.css`).
For every `*.css?inline` module the plugin's `transform()`:

1. **strips `@font-face` and `@property`** — browsers only register fonts declared in the *document* (inside a
   shadow root the rule is ignored → icon fonts render as tofu), and `@property` is not supported in shadow-root
   sheets (Tailwind 4 emits ~40 of them, e.g. `--tw-border-style`; without them borders/transforms break);
2. rewrites `:root` selectors to `:host, :root` so document-level variables apply in the shadow root;
3. neutralises Tailwind's `@supports (-webkit-hyphens: none)` sniff (misfires in Shadow DOM).

The stripped rules are written to the **lift file `.spinal/spinal-lift.css`**, a real CSS file. `src/main.ts` imports
`virtual:spinal-lift.css`; `resolveId()` maps that name straight to the lift file, so Vite handles it like any
other document stylesheet: bundled into `dist/assets/index-*.css`, `url()`s in the lifted `@font-face` rules
resolved and hashed (`/assets/fa-solid-900-*.woff2`), HMR in dev.

## Ordering and the cache

The lift file must be complete before Vite bundles it, but module transform order is not ours to choose. So
`.spinal/liftCache.json` remembers, per `?inline` source, the url()-free lifted rules (`@property` — for Tailwind
these exist only in the *compiled* module, the source file is just `@import "tailwindcss"`), and at `buildStart`
the lift file is regenerated from that plus the `url()` rules (`@font-face`) **re-read from the original files**
with their relative `url()`s rewritten to be relative to `.spinal/`. The transform keeps cache and file current.
**Commit `.spinal/`** (it is) so a fresh checkout builds right the first time; never hand-edit it.

## How to check a build

```sh
pnpm build
grep -o '@font-face' dist/assets/index-*.css | wc -l   # 10 (Font Awesome faces)
grep -o '@property'  dist/assets/index-*.css | wc -l   # ~28 here (Tailwind; grows with the utilities used)
grep -o '@font-face' dist/assets/index-*.js  | wc -l   # 0 — nothing left in the shadow-root sheets
```
The cache keys Font Awesome by its pnpm store path (`node_modules/.pnpm/@fortawesome+fontawesome-free@<version>/…`):
after upgrading it, the first build lacks the fonts and the second is complete — build twice and commit `.spinal/`.

## History

An earlier version never actually stripped the rules, served the lift file through a `\0virtual` module whose `@import` rolldown dropped from the production bundle, and cached per-build `__VITE_ASSET__` placeholders — dev looked right, production had no icons. Keep the lift file a real CSS file and the cache url()-free.
