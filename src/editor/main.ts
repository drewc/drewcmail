import Squire from 'squire-rte'
import { sanitizeHtml } from '../body.ts'

/**
 * editor.html: the body of a message being written — Squire (Fastmail's editor, which
 * works on the HTML itself, so forwarded mail keeps its layout) in a frame of its own.
 * Squire uses the global window/document, so it cannot run inside a shadow root or
 * drive another frame; and the frame keeps a quoted message's CSS off the compose
 * window. The page's CSP runs only our script, and loads remote images only when the
 * frame is opened with ?remote (the user asked to see them; they load without a referrer).
 * <mail-rich-editor> talks to it through `window.mailEditor` (same origin).
 */

// before there is any content (it only ever comes through the API below): a meta CSP added now is enforced
const remote = new URLSearchParams(location.search).has('remote')
const csp = document.createElement('meta')
csp.httpEquiv = 'Content-Security-Policy'
csp.content = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'${remote ? ' https: http:' : ''}; ` +
  `img-src 'self' data: blob:${remote ? ' https: http:' : ''}; font-src 'self' data:${remote ? ' https: http:' : ''}; connect-src 'self' ws: wss:`
document.head.prepend(csp)

export type Command =
  | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'removeAllFormatting'
  | 'makeUnorderedList' | 'makeOrderedList' | 'removeList' | 'increaseListLevel' | 'decreaseListLevel'
  | 'increaseQuoteLevel' | 'decreaseQuoteLevel' | 'undo' | 'redo'

export type Handlers = {
  change?: () => void
  /** the formats at the cursor changed */
  path?: () => void
  /** Ctrl/Cmd+Enter */
  submit?: () => void
  escape?: () => void
  /** whether the body has remote images (hidden unless the frame was opened with ?remote) */
  remote?: (has: boolean) => void
  /** files dropped or pasted that are not images: attachments */
  files?: (files: File[]) => void
}

export type EditorApi = {
  setHTML(html: string): void
  /** add at the end (the quoted text, shown) */
  append(html: string): void
  /** the message: its <style>s, then the body */
  getHTML(): string
  isEmpty(): boolean
  focus(): void
  command(name: Command): void
  link(url: string | null): void
  color(kind: 'text' | 'highlight', value: string | null): void
  image(src: string): void
  formats(): Record<string, boolean>
  setPlaceholder(text: string): void
  on(handlers: Handlers): void
}

const root = document.getElementById('editor')!
let handlers: Handlers = {}

/** a quoted message's <style>s: they apply here, in <head>, and go out ahead of the body */
const styles: string[] = []

function fragment(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const s of doc.querySelectorAll('style')) {
    const css = s.textContent ?? ''
    if (!styles.includes(css)) {
      styles.push(css)
      const el = document.createElement('style')
      el.textContent = css
      document.head.append(el)
    }
    s.remove()
  }
  sanitizeHtml(doc)
  const frag = document.createDocumentFragment()
  frag.append(...[...doc.body.childNodes].map(n => document.importNode(n, true)))
  return frag
}

const editor = new Squire(root, {
  blockTag: 'DIV',
  sanitizeToDOMFragment: html => fragment(html),
  didError: e => console.error('editor:', e),
})

const readDataUrl = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result))
  r.onerror = () => reject(r.error)
  r.readAsDataURL(f)
})

async function takeFiles(files: File[]) {
  const images = files.filter(f => f.type.startsWith('image/'))
  const rest = files.filter(f => !f.type.startsWith('image/'))
  for (const f of images) editor.insertImage(await readDataUrl(f), { alt: f.name })
  if (rest.length) handlers.files?.(rest)
}

const REMOTE = /^\s*(https?:)?\/\//i
const hasRemote = () =>
  [...root.querySelectorAll('[src], [background], [srcset]')].some(el =>
    REMOTE.test(el.getAttribute('src') ?? '') || REMOTE.test(el.getAttribute('background') ?? '') || el.hasAttribute('srcset')) ||
  [...root.querySelectorAll<HTMLElement>('[style*="url("]')].some(el => /url\(\s*['"]?\s*(https?:)?\/\//i.test(el.getAttribute('style') ?? '')) ||
  styles.some(css => /url\(\s*['"]?\s*(https?:)?\/\/|@import/i.test(css))
let hadRemote = false
const blank = () => {
  root.classList.toggle('blank', api.isEmpty())
  const has = hasRemote()
  if (has !== hadRemote) { hadRemote = has; handlers.remote?.(has) }
}
editor.addEventListener('input', () => { blank(); handlers.change?.() })
editor.addEventListener('pathChange', () => handlers.path?.())
editor.addEventListener('pasteImage', (e: Event) => {
  const items = (e as CustomEvent<{ clipboardData: DataTransfer }>).detail.clipboardData.items
  void takeFiles([...items].map(i => i.getAsFile()).filter((f): f is File => !!f))
})
document.addEventListener('drop', e => {
  const files = [...e.dataTransfer?.files ?? []]
  if (!files.length) return
  e.preventDefault(); e.stopPropagation()
  void takeFiles(files)
}, true)
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handlers.submit?.() }
  else if (e.key === 'Escape') handlers.escape?.()
}, true)

const api: EditorApi = {
  setHTML(html) { editor.setHTML(html); blank() },
  append(html) {
    editor.setHTML(editor.getHTML() + html)
    blank()
    handlers.change?.()
  },
  getHTML() {
    return (styles.length ? `<style>${styles.join('\n')}</style>` : '') + editor.getHTML()
  },
  isEmpty() { return !root.textContent?.trim() && !root.querySelector('img') },
  focus() { editor.focus(); editor.moveCursorToStart() },
  command(name) { editor[name](); editor.focus() },
  link(url) { if (url) editor.makeLink(url); else editor.removeLink(); editor.focus() },
  color(kind, value) { if (kind === 'text') editor.setTextColor(value); else editor.setHighlightColor(value); editor.focus() },
  image(src) { editor.insertImage(src, {}); editor.focus() },
  formats() {
    return Object.fromEntries(['B', 'I', 'U', 'S', 'UL', 'OL', 'BLOCKQUOTE', 'A'].map(t => [t, editor.hasFormat(t)]))
  },
  setPlaceholder(text) { root.dataset.placeholder = text },
  on(h) { handlers = h },
}

declare global { interface Window { mailEditor?: EditorApi } }
window.mailEditor = api
window.dispatchEvent(new Event('mail-editor-ready'))
