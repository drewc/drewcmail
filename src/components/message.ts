import { html, css, nothing, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import { api, idQuery } from '../api.ts'
import { attachments, cidMap, hasHtml, leaves, plainText, prepareHtml, type Leaf } from '../body.ts'
import { displayName, HIDDEN_TAGS, humanSize, longDate, shortDate } from '../format.ts'
import type { Message } from '../types.ts'

const URL_RE = /(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g

/** plain text with links, and quoted runs (> …) folded away when long */
function renderText(text: string): TemplateResult {
  const linkify = (s: string) => s.split(URL_RE).map((chunk, i) =>
    i % 2 ? html`<a href=${chunk} target="_blank" rel="noopener noreferrer" class="text-sky-700 underline dark:text-sky-400">${chunk}</a>` : chunk)
  const blocks: { quote: boolean; lines: string[] }[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const quote = /^\s*>/.test(line)
    const last = blocks[blocks.length - 1]
    if (last && last.quote === quote) last.lines.push(line)
    else blocks.push({ quote, lines: [line] })
  }
  return html`<div class="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">${blocks.map(b => {
    const body = linkify(b.lines.join('\n'))
    if (!b.quote) return html`<div>${body}</div>`
    const q = html`<div class="border-l-2 border-slate-300 pl-3 text-slate-500 dark:border-slate-600 dark:text-slate-400">${body}</div>`
    return b.lines.length > 4
      ? html`<details><summary class="cursor-pointer text-xs text-slate-400 select-none">show ${b.lines.length} quoted lines</summary>${q}</details>`
      : q
  })}</div>`
}

/**
 * <mail-message>: one message of a thread — collapsed to a line, or expanded with
 * headers, body, attachments and actions. Emits compose/changed/toast.
 */
@customElement('mail-message')
export class MailMessage extends BaseElement {
  static styles = [...(BaseElement.styles as []), css`iframe { display: block; width: 100%; border: 0; }`]

  @property({ attribute: false }) message!: Message
  @property({ type: Boolean, reflect: true }) open = false
  @state() private preferHtml = true
  @state() private remote = false
  @state() private details = false
  @state() private addingTag = false
  /** the ⋮ menu by the date: reply, reply all, forward, add tag */
  @state() private menu = false

  /** a click elsewhere closes it, and so does another message's menu opening (its click stops short of window) */
  private closeMenu = (e: Event) => { if ((e as CustomEvent).detail !== this) this.menu = false }

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('click', this.closeMenu)
    window.addEventListener('mail-message-menu', this.closeMenu)
  }

  disconnectedCallback() {
    window.removeEventListener('click', this.closeMenu)
    window.removeEventListener('mail-message-menu', this.closeMenu)
    super.disconnectedCallback()
  }

  private toggleMenu(e: Event) {
    e.stopPropagation()   // not the header's click, which folds the message
    window.dispatchEvent(new CustomEvent('mail-message-menu', { detail: this }))
    this.menu = !this.menu
    if (this.menu) this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('[role=menuitem]')?.focus())
  }

  private renderMenu() {
    const item = (icon: string, text: string, act: () => void) => html`
      <button role="menuitem" class="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm whitespace-nowrap hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:hover:bg-slate-700 dark:focus:bg-slate-700"
              @click=${() => { this.menu = false; act() }}><i class="${fa(icon)} w-4 text-center text-slate-500"></i>${text}</button>`
    return html`
      <div role="menu" @click=${(e: Event) => e.stopPropagation()}
           @keydown=${(e: KeyboardEvent) => {
             if (e.key === 'Escape') { e.stopPropagation(); this.menu = false; return }
             if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
             e.preventDefault()
             const items = [...this.renderRoot.querySelectorAll<HTMLElement>('[role=menuitem]')]
             const at = items.indexOf(this.shadowRoot?.activeElement as HTMLElement)
             items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
           }}
           class="absolute top-full right-0 z-30 mt-1 w-44 rounded-lg border border-slate-200 bg-white py-1 text-slate-700 shadow-xl dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
        ${item('reply', 'Reply', () => this.reply('sender'))}
        ${item('reply-all', 'Reply all', () => this.reply('all'))}
        ${item('share', 'Forward', () => this.forward())}
        <hr class="my-1 border-slate-200 dark:border-slate-700">
        ${item('tag', 'Add tag', () => { this.addingTag = true })}
      </div>`
  }

  private get tags() { return this.message.tags.filter(t => !HIDDEN_TAGS.has(t) || t === 'unread') }

  private async tag(add: string[], remove: string[]) {
    try {
      await api.tag(idQuery(this.message.id), add, remove)
      this.emit('changed')
    } catch (e) { this.emit('toast', { text: (e as Error).message }) }
  }

  async reply(to: 'all' | 'sender') {
    try {
      const r = await api.reply(this.message.id, to)
      const h = r['reply-headers']
      const quoted = plainText(r.original).split('\n').map(l => `> ${l}`).join('\n')
      this.emit('compose', {
        from: h.From, to: h.To, cc: h.Cc, subject: h.Subject,
        inReplyTo: h['In-reply-to'], references: h.References,
        text: `\n\nOn ${longDate(this.message.timestamp)}, ${this.message.headers.From} wrote:\n${quoted}\n`,
      })
    } catch (e) { this.emit('toast', { text: (e as Error).message }) }
  }

  private forward() {
    const h = this.message.headers
    const header = ['From', 'Date', 'Subject', 'To', 'Cc'].filter(k => h[k]).map(k => `${k}: ${h[k]}`).join('\n')
    this.emit('compose', {
      subject: /^fwd?:/i.test(h.Subject ?? '') ? h.Subject : `Fwd: ${h.Subject ?? ''}`,
      text: `\n\n---------- Forwarded message ----------\n${header}\n\n${plainText(this.message)}\n`,
    })
  }

  private renderHtml(source: string) {
    const cids = cidMap(this.message)
    const { srcdoc, blocked } = prepareHtml(source, id => {
      const part = cids.get(id)
      return part == null ? undefined : new URL(api.partUrl(this.message.id, part), location.origin).href
    }, this.remote)
    // allow-same-origin (without allow-scripts) only so we can measure the height
    const fit = (e: Event) => {
      const frame = e.target as HTMLIFrameElement
      const doc = frame.contentDocument
      if (!doc) return
      const size = () => { frame.style.height = `${doc.documentElement.scrollHeight}px` }
      size()
      new ResizeObserver(size).observe(doc.body)
    }
    return html`
      ${blocked ? html`
        <div class="mb-2 flex items-center gap-3 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <i class="${fa('image')}"></i> Remote images are hidden.
          <button class="font-semibold underline" @click=${() => { this.remote = true }}>Show them</button>
        </div>` : nothing}
      <div class="overflow-hidden rounded-md bg-white">
        <iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"
                .srcdoc=${srcdoc} @load=${fit} title="message body"></iframe>
      </div>`
  }

  private renderLeaf(l: Leaf): TemplateResult {
    switch (l.kind) {
      case 'text': return renderText(l.text)
      case 'html': return this.renderHtml(l.html)
      case 'note': return html`<p class="text-sm text-slate-500 italic"><i class="${fa('lock')}"></i> ${l.text}</p>`
      case 'message': return html`
        <div class="mt-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
          <p class="mb-2 text-xs text-slate-500">
            <b>${l.headers.Subject}</b><br>From ${l.headers.From} · ${l.headers.Date}
          </p>
          ${l.body.map(b => this.renderLeaf(b))}
        </div>`
    }
  }

  private renderAttachments() {
    const list = attachments(this.message)
    if (!list.length) return nothing
    return html`
      <ul class="mt-4 flex flex-wrap gap-2">
        ${list.map(p => {
          const image = p['content-type'].startsWith('image/')
          return html`
            <li class="flex max-w-64 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-2 pl-3 text-sm dark:border-slate-700 dark:bg-slate-800">
              ${image
                ? html`<img src=${api.partUrl(this.message.id, p.id)} alt="" class="h-8 w-8 rounded object-cover">`
                : html`<i class="${fa(p['content-type'] === 'application/pdf' ? 'file-pdf' : 'file')} text-slate-400"></i>`}
              <a href=${api.partUrl(this.message.id, p.id, !image)} target="_blank" rel="noopener" class="min-w-0 flex-1 truncate hover:underline" title=${p.filename ?? ''}>
                ${p.filename ?? p['content-type']}</a>
              <span class="text-xs whitespace-nowrap text-slate-400">${humanSize(p['content-length'])}</span>
              <a href=${api.partUrl(this.message.id, p.id, true)} title="Download" class="text-slate-400 hover:text-slate-600"><i class="${fa('download')}"></i></a>
            </li>`
        })}
      </ul>`
  }

  private addTag(e: Event) {
    e.preventDefault()
    const input = (e.target as HTMLFormElement).elements.namedItem('tag') as HTMLInputElement
    // comma-separated: a tag may have spaces (Gmail labels do)
    const tags = input.value.split(',').map(t => t.trim()).filter(Boolean)
    this.addingTag = false
    if (tags.length) this.tag(tags, [])
  }

  private renderTags() {
    return html`
      <div class="flex flex-wrap items-center gap-1">
        ${this.tags.map(t => html`
          <span class="flex items-center gap-1 rounded bg-slate-200 py-0.5 pr-1 pl-1.5 text-[11px] text-slate-700 dark:bg-slate-700 dark:text-slate-300">
            ${t}<button title="Remove tag" class="opacity-50 hover:opacity-100" @click=${(e: Event) => { e.stopPropagation(); this.tag([], [t]) }}><i class="${fa('xmark')}"></i></button>
          </span>`)}
        ${this.addingTag
          ? html`<form @submit=${this.addTag} @click=${(e: Event) => e.stopPropagation()}>
              <input name="tag" autofocus placeholder="tag, another" @blur=${() => { this.addingTag = false }}
                     class="w-24 rounded border border-slate-300 px-1.5 py-0.5 text-xs dark:border-slate-600"></form>`
          : html`<span class="relative">
              <button title="More" aria-haspopup="menu" aria-expanded=${this.menu} @click=${this.toggleMenu}
                      class="rounded px-1.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700">
                <i class="${fa('ellipsis-vertical')}"></i></button>
              ${this.menu ? this.renderMenu() : nothing}
            </span>`}
      </div>`
  }

  render() {
    const m = this.message
    const h = m.headers
    const from = displayName(h.From)
    const unread = m.tags.includes('unread')
    if (!this.open) return html`
      <button class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60" @click=${() => { this.open = true }}>
        <span class="w-40 shrink-0 truncate text-sm ${unread ? 'font-bold' : 'font-medium'}">${from}</span>
        <span class="min-w-0 flex-1 truncate text-sm text-slate-500">${plainText(m).slice(0, 200)}</span>
        ${attachments(m).length ? html`<i class="${fa('paperclip')} text-xs text-slate-400"></i>` : nothing}
        <span class="shrink-0 text-xs text-slate-500">${shortDate(m.timestamp)}</span>
      </button>`

    const starred = m.tags.includes('flagged')
    const btn = 'rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200'
    return html`
      <article class="px-4 py-3">
        <header class="flex cursor-pointer items-start gap-3" @click=${() => { this.open = false }}>
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-600 font-semibold text-white">${from.slice(0, 1).toUpperCase()}</div>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <span class="truncate font-semibold">${from}</span>
              <span class="truncate text-xs text-slate-500">${h.From?.match(/<([^>]+)>/)?.[1] ?? ''}</span>
            </div>
            <button class="max-w-full truncate text-left text-xs text-slate-500 hover:underline" @click=${(e: Event) => { e.stopPropagation(); this.details = !this.details }}>
              to ${[h.To, h.Cc].filter(Boolean).map(a => a.split(',').map(x => displayName(x)).join(', ')).join(', ') || 'undisclosed recipients'}
              <i class="${fa(this.details ? 'caret-up' : 'caret-down')}"></i>
            </button>
            ${this.details ? html`
              <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-slate-600 dark:text-slate-400" @click=${(e: Event) => e.stopPropagation()}>
                ${['From', 'To', 'Cc', 'Reply-To', 'Date', 'Subject'].filter(k => h[k]).map(k => html`<dt class="text-right text-slate-400">${k}</dt><dd class="break-all">${h[k]}</dd>`)}
                <dt class="text-right text-slate-400">Id</dt><dd class="break-all">${m.id}</dd>
                <dt class="text-right text-slate-400">File</dt><dd class="break-all">${m.filename.join(', ')}</dd>
              </dl>` : nothing}
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1">
            <span class="text-xs text-slate-500" title=${h.Date ?? ''}>${longDate(m.timestamp)}</span>
            ${this.renderTags()}
          </div>
        </header>

        <div class="mt-3 pl-12">
          ${hasHtml(m) ? html`
            <div class="mb-2 flex justify-end">
              <button class="text-xs text-slate-400 hover:text-slate-600" @click=${() => { this.preferHtml = !this.preferHtml }}>
                <i class="${fa(this.preferHtml ? 'align-left' : 'code')}"></i> ${this.preferHtml ? 'Plain text' : 'HTML'}
              </button>
            </div>` : nothing}
          ${leaves(m.body, this.preferHtml).map(l => this.renderLeaf(l))}
          ${this.renderAttachments()}

          <div class="mt-4 flex flex-wrap gap-1 text-sm">
            <button class="${btn}" @click=${() => this.reply('sender')}><i class="${fa('reply')}"></i> Reply</button>
            <button class="${btn}" @click=${() => this.reply('all')}><i class="${fa('reply-all')}"></i> Reply all</button>
            <button class="${btn}" @click=${this.forward}><i class="${fa('share')}"></i> Forward</button>
            <span class="flex-1"></span>
            <button class="${btn}" title=${starred ? 'Unstar' : 'Star'} @click=${() => this.tag(starred ? [] : ['flagged'], starred ? ['flagged'] : [])}>
              <i class="${fa('star', starred ? 'solid' : 'regular')} ${starred ? 'text-amber-400' : ''}"></i></button>
            <button class="${btn}" title="Mark unread" @click=${() => this.tag(['unread'], [])}><i class="${fa('envelope')}"></i></button>
            <a class="${btn}" title="View source" href=${api.rawUrl(m.id)} target="_blank" rel="noopener"><i class="${fa('file-code')}"></i></a>
          </div>
        </div>
      </article>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-message': MailMessage } }
