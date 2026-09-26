import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import { api } from '../api.ts'
import { addressOf, formatAddress, humanSize } from '../format.ts'
import type { Draft, Identity } from '../types.ts'

type Attachment = { filename: string; contentType: string; content: string; size: number }

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
  r.onerror = () => reject(r.error)
  r.readAsDataURL(file)
})

/**
 * <mail-compose>: a compose window, docked bottom-right like Gmail's. Sends through
 * the server (msmtp) and emits `close` when sent or discarded.
 */
@customElement('mail-compose')
export class Compose extends BaseElement {
  @property({ attribute: false }) draft: Draft = {}
  /** our From addresses and their names (the first is the default) */
  @property({ attribute: false }) identities: Identity[] = []
  @state() private d: Draft = {}
  @state() private attachments: Attachment[] = []
  @state() private sending = false
  @state() private error = ''
  @state() private minimised = false
  @state() private showCc = false

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('draft')) {
      this.d = { ...this.draft }
      this.showCc = !!(this.draft.cc || this.draft.bcc)
    }
    if ((changed.has('identities') || changed.has('draft')) && this.identities.length) {
      // a reply's From is ours with notmuch's single user.name: send with that address's own name
      const ours = this.d.from && this.identities.find(i => i.email.toLowerCase() === addressOf(this.d.from))
      if (ours) this.d = { ...this.d, from: formatAddress(ours) }
      else if (!this.d.from) this.d = { ...this.d, from: formatAddress(this.identities[0]) }
    }
  }

  firstUpdated() {
    const focus = this.d.to ? 'textarea' : 'input[name=to]'
    ;(this.renderRoot.querySelector(focus) as HTMLElement | null)?.focus()
    const ta = this.renderRoot.querySelector('textarea')
    ta?.setSelectionRange(0, 0)
  }

  private fromOptions() {
    const opts = this.identities.map(formatAddress)
    if (this.d.from && !opts.includes(this.d.from)) opts.unshift(this.d.from)
    return opts
  }

  private set(key: keyof Draft) {
    return (e: Event) => { this.d = { ...this.d, [key]: (e.target as HTMLInputElement).value } }
  }

  private async attach(e: Event) {
    const input = e.target as HTMLInputElement
    const files = [...(input.files ?? [])]
    input.value = ''
    const added = await Promise.all(files.map(async f => ({
      filename: f.name, contentType: f.type || 'application/octet-stream', content: await readBase64(f), size: f.size,
    })))
    this.attachments = [...this.attachments, ...added]
  }

  private async send() {
    if (!this.d.from) { this.error = 'No From address — add one under Accounts → Send as'; return }
    if (!this.d.to && !this.d.cc && !this.d.bcc) { this.error = 'Add a recipient'; return }
    this.sending = true
    this.error = ''
    try {
      await api.send({ ...this.d, from: this.d.from, attachments: this.attachments.map(({ size: _, ...a }) => a) })
      this.emit('toast', { text: 'Message sent' })
      this.emit('changed')
      this.dispatchEvent(new CustomEvent('close'))
    } catch (e) {
      this.error = (e as Error).message
    } finally {
      this.sending = false
    }
  }

  private discard() {
    const dirty = (this.d.text ?? '') !== (this.draft.text ?? '') || this.attachments.length
    if (!dirty || confirm('Discard this message?')) this.dispatchEvent(new CustomEvent('close'))
  }

  private onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.send() }
    if (e.key === 'Escape') { e.stopPropagation(); this.minimised = true }
  }

  render() {
    const field = 'w-full border-b border-slate-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-sky-500 dark:border-slate-700'
    const title = this.d.subject || 'New message'
    return html`
      <section class="flex w-[min(36rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-t-xl rounded-b-md border border-slate-300 bg-white shadow-2xl dark:border-slate-600 dark:bg-slate-800"
               @keydown=${this.onKey}>
        <header class="flex cursor-pointer items-center gap-2 bg-slate-800 px-3 py-2 text-sm text-white dark:bg-slate-950" @click=${() => { this.minimised = !this.minimised }}>
          <span class="flex-1 truncate font-medium">${title}</span>
          <button title=${this.minimised ? 'Expand' : 'Minimise'}><i class="${fa(this.minimised ? 'window-maximize' : 'window-minimize')}"></i></button>
          <button title="Discard" @click=${(e: Event) => { e.stopPropagation(); this.discard() }}><i class="${fa('xmark')}"></i></button>
        </header>
        ${this.minimised ? nothing : html`
          <div class="flex items-center">
            <span class="pl-3 text-sm text-slate-500">From</span>
            <select class="${field} border-0" .value=${this.d.from ?? ''} @change=${this.set('from')}>
              ${this.fromOptions().map(o => html`<option .value=${o} ?selected=${o === this.d.from}>${o}</option>`)}
            </select>
          </div>
          <div class="flex items-center border-t border-slate-200 dark:border-slate-700">
            <input name="to" class="${field}" placeholder="To" .value=${this.d.to ?? ''} @input=${this.set('to')}>
            ${this.showCc ? nothing : html`<button class="border-b border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:underline dark:border-slate-700" @click=${() => { this.showCc = true }}>Cc/Bcc</button>`}
          </div>
          ${this.showCc ? html`
            <input class="${field}" placeholder="Cc" .value=${this.d.cc ?? ''} @input=${this.set('cc')}>
            <input class="${field}" placeholder="Bcc" .value=${this.d.bcc ?? ''} @input=${this.set('bcc')}>` : nothing}
          <input class="${field}" placeholder="Subject" .value=${this.d.subject ?? ''} @input=${this.set('subject')}>
          <textarea class="h-72 max-h-[50vh] resize-y bg-transparent p-3 font-mono text-[13px] outline-none" .value=${this.d.text ?? ''} @input=${this.set('text')}></textarea>

          ${this.attachments.length ? html`
            <ul class="flex flex-wrap gap-2 px-3 pb-2">
              ${this.attachments.map((a, i) => html`
                <li class="flex items-center gap-2 rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-700">
                  <i class="${fa('paperclip')}"></i>${a.filename}<span class="text-slate-400">${humanSize(a.size)}</span>
                  <button title="Remove" @click=${() => { this.attachments = this.attachments.filter((_, j) => j !== i) }}><i class="${fa('xmark')}"></i></button>
                </li>`)}
            </ul>` : nothing}
          ${this.error ? html`<p class="mx-3 mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">${this.error}</p>` : nothing}

          <footer class="flex items-center gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-700">
            <button class="flex items-center gap-2 rounded-full bg-sky-600 px-5 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
                    ?disabled=${this.sending} @click=${this.send} title="Send (Ctrl+Enter)">
              ${this.sending ? html`<i class="${fa('spinner')} fa-spin"></i>` : html`<i class="${fa('paper-plane')}"></i>`} Send
            </button>
            <label class="cursor-pointer rounded-md px-2 py-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" title="Attach files">
              <i class="${fa('paperclip')}"></i><input type="file" multiple class="hidden" @change=${this.attach}>
            </label>
            <span class="flex-1"></span>
            <button class="rounded-md px-2 py-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" title="Discard" @click=${this.discard}><i class="${fa('trash')}"></i></button>
          </footer>`}
      </section>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-compose': Compose } }
