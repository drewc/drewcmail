import type { Message, Part } from './types.ts'

/**
 * Picking what to show from a notmuch message body: which part of an alternative,
 * which parts are attachments, and making an HTML part safe to put in an iframe.
 */

export const isMultipart = (p: Part) => p['content-type'].startsWith('multipart/')
const children = (p: Part) => (Array.isArray(p.content) && isMultipart(p) ? p.content as Part[] : [])

export function* walk(parts: Part[] = []): Generator<Part> {
  for (const p of parts) {
    yield p
    yield* walk(children(p))
  }
}

/** parts with a filename, or explicitly attachments — shown as a list, not inline */
export const isAttachment = (p: Part) =>
  !isMultipart(p) && p['content-type'] !== 'message/rfc822' && (!!p.filename || p['content-disposition'] === 'attachment')

export const attachments = (m: Message) => [...walk(m.body)].filter(isAttachment)

/** content-id → part number, for cid: URLs in HTML parts */
export function cidMap(m: Message): Map<string, number> {
  const map = new Map<string, number>()
  for (const p of walk(m.body)) if (p['content-id']) map.set(p['content-id'].replace(/^<|>$/g, ''), p.id)
  return map
}

/** the parts to render inline, in order: text/plain and text/html leaves, and nested messages */
export type Leaf =
  | { kind: 'text'; text: string }
  | { kind: 'html'; html: string }
  | { kind: 'message'; headers: Record<string, string>; body: Leaf[] }
  | { kind: 'note'; text: string }

export function leaves(parts: Part[] = [], preferHtml = true): Leaf[] {
  const out: Leaf[] = []
  for (const p of parts) {
    const type = p['content-type'].toLowerCase()
    if (type === 'multipart/alternative') {
      const alts = children(p)
      const pick = (t: string) => alts.find(a => a['content-type'].toLowerCase() === t || (isMultipart(a) && [...walk([a])].some(x => x['content-type'] === t)))
      const choice = (preferHtml ? pick('text/html') ?? pick('text/plain') : pick('text/plain') ?? pick('text/html')) ?? alts[alts.length - 1]
      if (choice) out.push(...leaves([choice], preferHtml))
    } else if (type === 'multipart/related') {
      // the root is the first part; the rest are resources it refers to by cid:
      out.push(...leaves(children(p).slice(0, 1), preferHtml))
    } else if (type === 'multipart/encrypted') {
      out.push({ kind: 'note', text: 'This message is encrypted.' })
    } else if (isMultipart(p)) {
      out.push(...leaves(children(p), preferHtml))
    } else if (type === 'message/rfc822' && Array.isArray(p.content)) {
      for (const m of p.content as { headers: Record<string, string>; body: Part[] }[])
        out.push({ kind: 'message', headers: m.headers, body: leaves(m.body, preferHtml) })
    } else if (isAttachment(p)) {
      continue
    } else if (type === 'text/html' && typeof p.content === 'string') {
      out.push({ kind: 'html', html: p.content })
    } else if (type.startsWith('text/') && typeof p.content === 'string') {
      out.push({ kind: 'text', text: p.content })
    }
  }
  return out
}

export const hasHtml = (m: Message) => [...walk(m.body)].some(p => p['content-type'] === 'text/html')

/** the plain text of a message, for quoting in a reply and for the collapsed preview */
export function plainText(m: Pick<Message, 'body'>): string {
  return leaves(m.body, false).map(l =>
    l.kind === 'text' ? l.text : l.kind === 'html' ? htmlToText(l.html) : '').join('\n').trim()
}

export function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('style, script, head').forEach(e => e.remove())
  doc.querySelectorAll('br').forEach(e => e.replaceWith('\n'))
  doc.querySelectorAll('p, div, tr, li, h1, h2, h3, h4, blockquote').forEach(e => e.append('\n'))
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

const REMOTE = /^(https?:)?\/\//i

/**
 * Make an email's HTML fit for a sandboxed iframe (no scripts run there anyway —
 * the sandbox has no allow-scripts): drop active content, point cid: images at the
 * part URLs, and block remote resources unless `remote` is set. Returns the srcdoc
 * and whether anything remote was blocked.
 */
export function prepareHtml(html: string, cid: (id: string) => string | undefined, remote: boolean) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, base, form, meta[http-equiv], link:not([rel~=stylesheet])').forEach(e => e.remove())
  let blocked = false
  for (const el of doc.querySelectorAll<HTMLElement>('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (/^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
    }
    for (const name of ['src', 'background', 'poster']) {
      const v = el.getAttribute(name)
      if (!v) continue
      if (/^cid:/i.test(v)) {
        const url = cid(decodeURIComponent(v.slice(4)))
        if (url) el.setAttribute(name, url)
      } else if (REMOTE.test(v) && !remote) {
        blocked = true
        el.setAttribute(`data-blocked-${name}`, v)
        el.removeAttribute(name)
      }
    }
    if (el.hasAttribute('srcset') && !remote) { blocked = true; el.removeAttribute('srcset') }
    if (el.getAttribute('style')?.match(/url\(/i) && !remote) blocked = true
  }
  if (!remote && doc.querySelector('link[rel~=stylesheet], style')?.textContent?.match(/url\(|@import/i)) blocked = true

  // the CSP backs up the rewriting above: only this origin (cid: parts) and data: unless remote
  const src = remote ? `${location.origin} data: https: http:` : `${location.origin} data:`
  const csp = `default-src 'none'; img-src ${src}; style-src 'unsafe-inline' ${remote ? 'https: http:' : ''}; font-src ${src}; media-src ${src}`
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">` +
    `<style>html{color-scheme:light}body{margin:0;padding:4px;font:14px/1.5 system-ui,sans-serif;color:#1e293b;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}</style>`
  return { srcdoc: `<!doctype html><html><head>${head}${doc.head.innerHTML}</head><body>${doc.body.innerHTML}</body></html>`, blocked }
}
