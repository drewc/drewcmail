import type { Message, Part, PartRef } from './types.ts'

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

/** drop active content: scripts, frames, plugins, forms, handlers, javascript: URLs (stylesheet links only if `links`) */
export function sanitizeHtml(doc: Document, links = false) {
  doc.querySelectorAll(`script, noscript, iframe, frame, frameset, object, embed, applet, base, form, meta, title, ${links ? 'link:not([rel~=stylesheet])' : 'link'}`)
    .forEach(e => e.remove())
  for (const el of doc.querySelectorAll<HTMLElement>('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (/^\s*(javascript|vbscript):/i.test(attr.value)) el.removeAttribute(attr.name)
    }
  }
}

/**
 * Make an email's HTML fit for a sandboxed iframe (no scripts run there anyway —
 * the sandbox has no allow-scripts): drop active content, point cid: images at the
 * part URLs, and block remote resources unless `remote` is set. Returns the srcdoc
 * and whether anything remote was blocked.
 */
export function prepareHtml(html: string, cid: (id: string) => string | undefined, remote: boolean) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  sanitizeHtml(doc, true)
  let blocked = false
  for (const el of doc.querySelectorAll<HTMLElement>('*')) {
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

/** a calendar invitation's part: text/calendar (inline, with its content) or an .ics attachment (fetched) */
export const calendarPart = (m: Pick<Message, 'body'>) => {
  const parts = [...walk(m.body)]
  return parts.find(p => p['content-type'].toLowerCase() === 'text/calendar' && typeof p.content === 'string')
    ?? parts.find(p => /^(text\/calendar|application\/ics)$/i.test(p['content-type']) || /\.ics$/i.test(p.filename ?? ''))
}

/** outgoing HTML → its text/plain alternative: quotes as `> `, list items as `- `, links as `text <url>` */
export function mailText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const block = new Set(['P', 'DIV', 'LI', 'PRE', 'H1', 'H2', 'H3', 'H4', 'TR', 'BLOCKQUOTE', 'OL', 'UL'])
  const walk = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? ''
    if (!(n instanceof Element)) return ''
    if (['STYLE', 'SCRIPT', 'HEAD', 'TITLE'].includes(n.tagName)) return ''
    if (n.tagName === 'BR') return '\n'
    if (n.tagName === 'IMG') return n.getAttribute('alt') ? `[${n.getAttribute('alt')}]` : ''
    let s = [...n.childNodes].map(walk).join('')
    if (n.tagName === 'A') {
      const href = n.getAttribute('href') ?? ''
      if (href && href !== s && `mailto:${s}` !== href) s = `${s} <${href}>`
    }
    if (n.tagName === 'LI') s = `${n.parentElement?.tagName === 'OL' ? `${[...n.parentElement.children].indexOf(n) + 1}.` : '-'} ${s}`
    if (n.tagName === 'BLOCKQUOTE') s = s.replace(/\n+$/, '').split('\n').map(l => (l.startsWith('>') ? `>${l}` : `> ${l}`)).join('\n')
    if (n.tagName === 'TD' || n.tagName === 'TH') return `${s.trim()} `
    return block.has(n.tagName) ? `${s.replace(/\n+$/, '')}\n` : s
  }
  return walk(doc.body).replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** plain text as editor HTML: one paragraph per line */
export const textToHtml = (text: string) =>
  text.replace(/\r\n/g, '\n').split('\n').map(l => `<p>${l ? escapeHtml(l) : '<br>'}</p>`).join('')

// ── replying and forwarding with the original as it was (Gmail's markup) ──────────────────


/**
 * A message's body as HTML to quote: its HTML parts (sanitised, <style>s kept, cid:
 * images pointing at their parts so the editor shows them), text parts as lines,
 * attached messages with their headers. `parts` are the inline images it refers to.
 */
export function originalHtml(m: Message, partUrl: (part: number) => string): { html: string; parts: PartRef[] } {
  const byCid = new Map<string, Part>()
  for (const p of walk(m.body)) if (p['content-id']) byCid.set(p['content-id'].replace(/^<|>$/g, ''), p)
  const parts: PartRef[] = []
  const render = (l: Leaf): string => {
    switch (l.kind) {
      case 'text': return `<div>${escapeHtml(l.text).replace(/\r?\n/g, '<br>')}</div>`
      case 'note': return `<div><i>${escapeHtml(l.text)}</i></div>`
      case 'message': return `<div>${['From', 'Date', 'Subject', 'To'].filter(k => l.headers[k]).map(k => `${k}: ${escapeHtml(l.headers[k])}`).join('<br>')}<br><br>${l.body.map(render).join('')}</div>`
      case 'html': {
        const doc = new DOMParser().parseFromString(l.html, 'text/html')
        sanitizeHtml(doc)
        for (const img of doc.querySelectorAll<HTMLElement>('[src^="cid:" i], [background^="cid:" i]')) {
          for (const attr of ['src', 'background']) {
            const v = img.getAttribute(attr)
            if (!v || !/^cid:/i.test(v)) continue
            const cid = decodeURIComponent(v.slice(4))
            const p = byCid.get(cid)
            if (!p) continue
            const url = partUrl(p.id)
            if (!parts.some(x => x.cid === cid)) parts.push({ message: m.id, part: p.id, filename: p.filename ?? cid, contentType: p['content-type'], size: p['content-length'], cid, url })
            img.setAttribute(attr, url)
          }
        }
        const styles = [...doc.querySelectorAll('style')].map(s => s.outerHTML).join('')
        doc.querySelectorAll('style').forEach(s => s.remove())
        return styles + doc.body.innerHTML
      }
    }
  }
  return { html: leaves(m.body, true).map(render).join(''), parts }
}

/** a reply's quote: "On …, … wrote:" and the original in a blockquote */
export const replyQuote = (attribution: string, original: string) =>
  `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(attribution)}<br></div>` +
  `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${original}</blockquote></div>`

/** a forward: the original's headers, then the original */
export function forwardBlock(headers: Record<string, string>, original: string) {
  const from = headers.From ?? ''
  const name = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim()
  const addr = from.match(/<[^>]*>/)?.[0] ?? ''
  const rows = [
    `From: ${name && addr ? `<strong class="gmail_sendername" dir="auto">${escapeHtml(name)}</strong> <span dir="auto">${escapeHtml(addr)}</span>` : escapeHtml(from)}`,
    ...['Date', 'Subject', 'To', 'Cc'].filter(k => headers[k]).map(k => `${k}: ${escapeHtml(headers[k])}`),
  ]
  return `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>${rows.join('<br>')}<br></div><br><br>${original}</div>`
}

/**
 * The HTML to send: part URLs of quoted inline images back to their cid:, pasted
 * images (data:) to new inline parts. Returns what the HTML still refers to.
 */
export function outgoingHtml(html: string, parts: PartRef[]) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const used: PartRef[] = []
  const images: { cid: string; filename: string; contentType: string; content: string }[] = []
  const stamp = Date.now().toString(36)
  for (const el of doc.querySelectorAll<HTMLElement>('[src], [background]')) {
    for (const attr of ['src', 'background']) {
      const v = el.getAttribute(attr)
      if (!v) continue
      const ref = parts.find(p => p.cid && p.url === v)
      if (ref) {
        el.setAttribute(attr, `cid:${ref.cid}`)
        if (!used.includes(ref)) used.push(ref)
        continue
      }
      const m = v.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s)
      if (!m) continue
      const cid = `image${images.length + 1}.${stamp}@drewcmail`
      images.push({ cid, filename: `image${images.length + 1}.${(m[1].split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`, contentType: m[1], content: m[2] })
      el.setAttribute(attr, `cid:${cid}`)
    }
  }
  const styles = [...doc.head.querySelectorAll('style')].map(s => s.outerHTML).join('')
  return { html: styles + doc.body.innerHTML, used, images }
}
