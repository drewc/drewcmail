import type { ConfigEnv, Plugin } from 'vite'
import postcss from 'postcss'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * @spinal/shadow-css — make CSS written for the document work inside Shadow DOM,
 * and lift what cannot live there back into the document.
 *
 * Components import stylesheets with `?inline` and adopt them into their shadow
 * roots (see src/components/base.ts). Two kinds of rule are useless there:
 *   - @font-face: browsers only register fonts declared in the DOCUMENT; inside a
 *     shadow root the rule is ignored and icon fonts render as tofu;
 *   - @property: not supported in shadow root stylesheets (Tailwind 4 emits many).
 * Also `:root` selectors must become `:host, :root`, and Tailwind's
 * `@supports (-webkit-hyphens: none)` guard breaks in Shadow DOM.
 *
 * So, for every `*.css?inline` module:
 *   1. transform():  strip @font-face / @property, fix :root and @supports, and
 *      return the transformed CSS (this is what the shadow roots adopt);
 *   2. the stripped rules go to the LIFT FILE `.spinal/spinal-lift.css`, a real CSS
 *      file that `page.ts` imports as `virtual:spinal-lift.css` — resolveId() maps
 *      the virtual name to that file, so Vite treats it like any other document
 *      stylesheet: bundled into dist/assets/index-*.css, `url()`s in the lifted
 *      @font-face rules rewritten to hashed assets, HMR in dev.
 *
 * Ordering: the lift file must be complete before Vite bundles it, but the order in
 * which modules are transformed is not ours to choose. Hence `.spinal/liftCache.json`
 * remembers, per `?inline` file, the url()-free rules (@property — for Tailwind they
 * exist only in the compiled module) and at buildStart the lift file is regenerated
 * from that plus the url() rules (@font-face) re-read from the ORIGINAL files with
 * their relative url()s rewritten to be relative to .spinal/ — before anything is
 * bundled. The transform keeps the cache and the file current for the next run /
 * for dev HMR (commit .spinal/ so a fresh checkout builds right the first time).
 *
 * History: a previous version compared the transformed CSS with itself (so the strip
 * never applied), fed the lift file through a `\0virtual` module with an `@import`
 * (which rolldown's CSS pipeline dropped from the production bundle) and stored
 * per-build `__VITE_ASSET__` placeholders in the cache. Production shipped without
 * @font-face in the CSS while the shadow roots kept theirs → no icons.
 */

const SPINAL_DIR = '.spinal'
const LIFT_FILE = 'spinal-lift.css'
const CACHE_FILE = 'liftCache.json'
const VIRTUAL_ID = 'virtual:spinal-lift.css'
const INLINE_RE = /\.css\?inline$/

export type ShadowCssOptions = {
  /** at-rules to lift into the document */
  hoistRules?: string[]
  /** @supports conditions to neutralise */
  removeSupports?: string[]
}

export function cssShadowDOM(_env?: ConfigEnv, options: ShadowCssOptions = {}): Plugin[] {
  return [shadowCSS(options)]
}

// ---- CSS processing ----------------------------------------------------------------

function extractAtRules(root: postcss.Root, ruleNames: string[]): postcss.AtRule[] {
  const rules: postcss.AtRule[] = []
  root.walkAtRules(rule => {
    if (ruleNames.includes(rule.name)) { rules.push(rule); rule.remove() }
  })
  return rules
}

/**
 * Tailwind wraps some rules in `@supports (-webkit-hyphens: none)` (a Safari sniff);
 * inside Shadow DOM the condition misfires. Replace it with one that is always true.
 * https://github.com/tailwindlabs/tailwindcss/issues/15005#issuecomment-3722970702
 */
function neutraliseSupports(root: postcss.Root, conditions: string[]) {
  root.walkAtRules('supports', rule => {
    for (const c of conditions) rule.params = rule.params.replace(c, '(display: block)')
  })
}

/** `:root { … }` → `:host, :root { … }` so document-level variables apply in the shadow root too */
function includeHostWhereRoot(root: postcss.Root) {
  root.walkRules(rule => {
    if (rule.selectors.includes(':root') && !rule.selectors.includes(':host')) rule.selector = ':host, ' + rule.selector
  })
}

export function processCss({ code, rules = ['font-face', 'property'], supports = ['(-webkit-hyphens: none)'] }:
  { code: string; rules?: string[]; supports?: string[] }) {
  const root = postcss.parse(code)
  const hoisted = extractAtRules(root, rules)
  neutraliseSupports(root, supports)
  includeHostWhereRoot(root)
  return { code: root.toString(), rules: hoisted.map(r => r.toString()) }
}

const hasUrl = (rule: string) => /url\(/.test(rule)

/**
 * The url()-bearing lifted rules (@font-face) for one source file, read from the
 * ORIGINAL file — not the transformed module, whose url()s Vite has already turned
 * into per-build `__VITE_ASSET__` placeholders. Relative url()s are rewritten to be
 * relative to `.spinal/`, where the lift file lives, so Vite resolves and hashes the
 * assets itself. Rules without url()s (@property) are taken from the transformed
 * module instead: for Tailwind the original file is only `@import "tailwindcss"`.
 */
async function urlRulesFromSource(file: string, rules: string[], spinalDir: string): Promise<string[]> {
  const css = await fs.readFile(file, 'utf8').catch(() => '')
  if (!css) return []
  const root = postcss.parse(css)
  const hoisted = extractAtRules(root, rules).filter(r => hasUrl(r.toString()))
  const fromDir = path.dirname(file)
  return hoisted.map(rule => {
    rule.walkDecls(decl => {
      decl.value = decl.value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
        if (/^(data:|https?:|\/\/|\/|#)/.test(u)) return m
        const abs = path.resolve(fromDir, u)
        let rel = path.relative(spinalDir, abs).split(path.sep).join('/')
        if (!rel.startsWith('.')) rel = './' + rel
        return `url(${q}${rel}${q})`
      })
    })
    return rule.toString()
  })
}

// ---- the plugin --------------------------------------------------------------------

function shadowCSS({ hoistRules = ['font-face', 'property'], removeSupports = ['(-webkit-hyphens: none)'] }: ShadowCssOptions): Plugin {
  let root = process.cwd()
  let spinalDir = path.join(root, SPINAL_DIR)
  let liftFile = path.join(spinalDir, LIFT_FILE)
  let cacheFile = path.join(spinalDir, CACHE_FILE)
  /** source file (absolute, no query) → the rules lifted out of its transformed module */
  let sources = new Map<string, string[]>()
  let writeQueue: Promise<void> = Promise.resolve()

  const clean = (id: string) => id.replace(/[?#].*$/, '')

  async function readCache(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()
    try {
      const json = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
      const src = json?.sources
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        for (const [f, rules] of Object.entries(src)) map.set(path.isAbsolute(f) ? f : path.join(root, f), Array.isArray(rules) ? rules as string[] : [])
      }
    } catch { /* first run */ }
    return map
  }

  async function writeLiftFile() {
    await fs.mkdir(spinalDir, { recursive: true })
    const parts: string[] = []
    for (const file of [...sources.keys()].sort()) {
      // url()-free rules (@property) as transformed; url() rules (@font-face) re-read from the source with paths fixed
      const rules = [...(sources.get(file) ?? []).filter(r => !hasUrl(r)), ...await urlRulesFromSource(file, hoistRules, spinalDir)]
      if (rules.length) parts.push(`/* lifted from ${path.relative(root, file)} */\n${rules.join('\n\n')}`)
    }
    const css = parts.length
      ? `/* generated by @spinal/shadow-css — rules that must live in the document, lifted out of the ?inline sheets */\n\n${parts.join('\n\n')}\n`
      : `/* generated by @spinal/shadow-css — nothing to lift */\n:root { --spinal-no-lifts: true; }\n`
    const old = await fs.readFile(liftFile, 'utf8').catch(() => null)
    if (old !== css) await fs.writeFile(liftFile, css)
    const cache: Record<string, string[]> = {}
    for (const f of [...sources.keys()].sort()) cache[path.relative(root, f)] = (sources.get(f) ?? []).filter(r => !hasUrl(r))
    await fs.writeFile(cacheFile, JSON.stringify({ sources: cache }, null, 2) + '\n')
  }

  return {
    name: 'vite-plugin-spinal-css-shadow-dom',

    configResolved(config) {
      root = config.root
      spinalDir = path.join(root, SPINAL_DIR)
      liftFile = path.join(spinalDir, LIFT_FILE)
      cacheFile = path.join(spinalDir, CACHE_FILE)
    },

    // The lift file is regenerated from the source files before anything is bundled,
    // so the virtual import below is complete regardless of module order.
    async buildStart() {
      sources = await readCache()
      await writeLiftFile()
    },

    // `virtual:spinal-lift.css` IS the lift file: an ordinary CSS module for Vite.
    resolveId(id) {
      if (id === VIRTUAL_ID) return liftFile
      return null
    },

    // Shadow-root sheets: strip what cannot live there, remember the file for the lift.
    async transform(code, id) {
      if (!INLINE_RE.test(id)) return null
      const file = clean(id)
      const { code: transformed, rules } = processCss({ code, rules: hoistRules, supports: removeSupports })
      const before = JSON.stringify(sources.get(file)?.filter(r => !hasUrl(r)) ?? null)
      sources.set(file, rules)
      if (before !== JSON.stringify(rules.filter(r => !hasUrl(r)))) {
        writeQueue = writeQueue.then(writeLiftFile, writeLiftFile)
        await writeQueue
      }
      return transformed === code ? null : { code: transformed, map: null }
    },
  }
}
