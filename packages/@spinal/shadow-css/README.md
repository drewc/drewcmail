# @spinal/shadow-css

A Vite plugin that lets you write (or import) ordinary, document-oriented CSS and use it inside **Shadow DOM** —
and quietly puts back into the document the few things a shadow root cannot hold.

It works on any stylesheet imported with `?inline`. It is exercised daily against **Tailwind CSS 4** and
**Font Awesome 7** in the ECM SPA, which is where every rule below was learned the hard way.

## The problem

Web components that adopt a stylesheet into their shadow root (`adoptedStyleSheets`, or a `<style>` in the
template) get almost everything — but not everything:

| CSS | in a shadow root |
|---|---|
| `@font-face { … }` | **ignored.** Fonts only register when the rule is in the *document*. Icon fonts render as tofu boxes. |
| `@property --x { … }` | **not supported** in shadow-root stylesheets. Tailwind 4 declares ~40 of them (`--tw-border-style`, `--tw-translate-x`, …); without them utilities like `border` or `translate-*` silently do nothing. |
| `:root { --var: … }` | matches nothing — the shadow root has no `:root`. Variables the sheet defines on `:root` are missing. |
| `@supports (-webkit-hyphens: none) { … }` | Tailwind's Safari sniff around its `@property` fallback layer; misfires in Shadow DOM. |

Everything else — selectors, utilities, keyframes, media queries — is fine.

## What the plugin does

For every module that matches `*.css?inline`:

1. **Lifts** `@font-face` and `@property` rules out of the sheet (configurable) into a single *lift file* that
   belongs to the document.
2. Rewrites `:root` selectors to `:host, :root`, so variables defined "on the document" also apply to the host.
3. Replaces the `@supports (-webkit-hyphens: none)` condition with `(display: block)` (always true).
4. Returns the transformed CSS — this is what your components adopt.

The lift file, `.spinal/spinal-lift.css`, is a real CSS file. You import it once, in the document:

```ts
// the app shell, or main.ts — anywhere that runs in the document, not in a component
import 'virtual:spinal-lift.css'
```

`virtual:spinal-lift.css` resolves straight to that file, so Vite treats it like any other stylesheet: bundled
into `dist/assets/index-*.css`, `url()`s inside the lifted `@font-face` rules resolved to hashed assets
(`/assets/fa-solid-900-abc123.woff2`), hot-reloaded in dev.

## Usage

```js
// vite.config.js
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { cssShadowDOM } from './packages/@spinal/shadow-css/index.ts'

export default defineConfig(({ command }) => ({
  plugins: [
    tailwindcss(),
    cssShadowDOM({ command }),          // options: see below
  ],
}))
```

```ts
// a base element every component extends
import { LitElement, unsafeCSS, adoptStyles } from 'lit'
import tailwind from './tailwind.css?inline'                     // "@import 'tailwindcss';"
import fontawesome from './fontawesome/css/all.min.css?inline'

const sheets = [unsafeCSS(tailwind), unsafeCSS(fontawesome)]

export class BaseElement extends LitElement {
  connectedCallback() {
    super.connectedCallback()
    adoptStyles(this.shadowRoot!, sheets)   // shadow-safe: fonts and @property already lifted
  }
}
```

```ts
// the document side, once
import 'virtual:spinal-lift.css'
```

That's all. Icons render, Tailwind utilities work, `:root` variables reach the components.

### Options

```ts
cssShadowDOM(env, {
  hoistRules: ['font-face', 'property'],          // at-rules to lift into the document
  removeSupports: ['(-webkit-hyphens: none)'],    // @supports conditions to neutralise
})
```

`processCss({ code, rules, supports })` is exported too, for tests or one-off transforms.

## The `.spinal/` directory — commit it

```
.spinal/
  spinal-lift.css   the lift file (generated every build, imported as virtual:spinal-lift.css)
  liftCache.json    per source file: the lifted rules that have no url() (the @property rules)
```

Why a cache? The lift file must be complete *before* Vite bundles it, but Vite transforms modules in an order the
plugin does not control. So at `buildStart` the plugin regenerates the lift file from what it knows:

- the **url()-free rules** (`@property`) come from the cache — for Tailwind they exist only in the *compiled*
  module (the source is just `@import "tailwindcss"`), so they cannot be re-read from disk;
- the **url() rules** (`@font-face`) are re-read from the **original source files** each time, with their relative
  `url()`s rewritten to be relative to `.spinal/`, so Vite resolves and hashes the font files itself. (Reading
  them from the transformed module would give per-build `__VITE_ASSET__` placeholders, which are worthless in
  the next build.)

The transform then keeps both files current. Commit `.spinal/` so a fresh checkout's *first* build already has
the fonts and properties; don't hand-edit it — every build rewrites it. Deleting it is safe: the first build
after that produces a lift file without `@property` rules (they arrive once Tailwind has been compiled), the
second build is complete.

## Verifying a build

```sh
pnpm build
grep -o '@font-face' dist/assets/index-*.css | wc -l   # your fonts (Font Awesome 7 Free: 10)
grep -o '@property'  dist/assets/index-*.css | wc -l   # Tailwind's (~43)
grep -o '@font-face' dist/assets/index-*.js  | wc -l   # 0 — nothing left inside the shadow-root sheets
```

In the browser: `[...document.fonts].map(f => f.family + ' ' + f.status)` lists the lifted faces, and
`document.styleSheets` contains the bundled `index-*.css` — no runtime injection needed.

## Effects and limits

- **Scope:** only modules ending in `.css?inline` are transformed. Plain `import './x.css'` (document CSS) is left
  alone — it already lives in the document.
- **Deduplication:** two components importing the same sheet share one lifted copy; the lift file is keyed by
  source file.
- **Cascade:** lifted `@font-face` / `@property` are global by nature, which is exactly what you want. Nothing else
  leaves the shadow root; encapsulation of ordinary rules is untouched.
- **`:host, :root`:** a sheet's `:root` block now also styles every host element that adopts it. For Tailwind
  this is the `--color-*`/`--spacing` theme variables — intended. If a sheet sets `:root { background: … }`
  you will see it on the hosts too; keep such sheets out of `?inline`.
- **HMR:** editing a `?inline` sheet re-transforms it and, if the lifted rules changed, rewrites the lift file,
  which Vite hot-reloads in the document.
- **Not handled:** `@import` inside a `?inline` sheet is resolved by Vite before this plugin sees it (fine);
  `@layer` and `@container` pass through unchanged (they work in Shadow DOM).

## History

Earlier versions compared the transformed CSS with itself (so the strip never applied), served the lift file
through a `\0virtual` module holding an `@import` (which rolldown's CSS pipeline dropped from production
bundles) and cached `__VITE_ASSET__` placeholders. `vite dev` looked fine while `vite build` shipped without
`@font-face` — no icons in production. The current design (real lift file, cache of url()-free rules,
`@font-face` re-read from source) is what fixed it.
