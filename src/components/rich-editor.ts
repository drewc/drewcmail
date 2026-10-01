import { html, css, nothing } from 'lit'
import { customElement, property, query, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import type { Command, EditorApi } from '../editor/main.ts'

/**
 * <mail-rich-editor>: the body of a message — a toolbar here, and Squire in editor.html
 * (an iframe: see src/editor/main.ts for why), driven through its window.mailEditor.
 *
 *   <mail-rich-editor .value=${html} placeholder="…" @change @submit @escape @files=${e => e.detail.files}>
 *   await editor.ready · editor.html() · editor.append(html) · editor.focus() · editor.isEmpty()
 *
 * `value` is read when the frame loads (a draft's starting body); the HTML goes in as
 * it is, <style>s and all, sanitised by the frame. Remote images stay hidden (the frame's
 * CSP) unless `remote`; "Show them" reopens the frame with them, keeping the body.
 */
@customElement('mail-rich-editor')
export class RichEditor extends BaseElement {
  @property() value = ''
  @property() placeholder = ''
  /** load remote images (the frame's CSP allows them) */
  @property({ type: Boolean }) remote = false
  @query('iframe') private frame!: HTMLIFrameElement
  @state() private formats: Record<string, boolean> = {}
  @state() private linking = false
  @state() private hasRemote = false
  /** the body to put back when the frame reloads (remote images turned on) */
  private carry?: string

  private api?: EditorApi
  private resolveReady!: () => void
  /** resolves once the frame's editor is there */
  readonly ready = new Promise<void>(r => { this.resolveReady = r })

  static styles = [...(BaseElement.styles as []), css`
    :host { display: flex; flex-direction: column; min-height: 0; }
    iframe { display: block; flex: 1; width: 100%; min-height: 0; border: 0; background: #fff; }
  `]

  private onLoad() {
    const win = this.frame.contentWindow
    const attach = () => {
      const api = win?.mailEditor
      if (!api || this.api) return
      this.api = api
      api.setPlaceholder(this.placeholder)
      const fire = (name: string, detail?: unknown) => this.dispatchEvent(new CustomEvent(name, { detail }))
      api.on({
        change: () => fire('change'),
        path: () => { this.formats = api.formats() },
        submit: () => fire('submit'),
        escape: () => fire('escape'),
        files: files => fire('files', { files }),
        remote: has => { this.hasRemote = has },
      })
      api.setHTML(this.carry ?? this.value)
      this.carry = undefined
      this.resolveReady()
    }
    if (win?.mailEditor) attach()
    else win?.addEventListener('mail-editor-ready', attach, { once: true })
  }

  html() { return this.api?.getHTML() ?? this.value }
  isEmpty() { return this.api ? this.api.isEmpty() : !this.value.trim() }
  append(html: string) { this.api?.append(html) }
  focus() { this.api?.focus() }

  private showRemote() {
    this.carry = this.api?.getHTML()
    this.api = undefined
    this.remote = true
  }

  private run(c: Command) { this.api?.command(c) }

  private link(e: Event) {
    e.preventDefault()
    const url = ((e.target as HTMLFormElement).elements.namedItem('url') as HTMLInputElement).value.trim()
    this.linking = false
    if (url) this.api?.link(/^[a-z][\w+.-]*:/i.test(url) ? url : /@/.test(url) && !url.includes('/') ? `mailto:${url}` : `https://${url}`)
  }

  private pickImage() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      const r = new FileReader()
      r.onload = () => this.api?.image(String(r.result))
      r.readAsDataURL(f)
    }
    input.click()
  }

  render() {
    const b = (icon: string, title: string, act: () => void, on = false) => html`
      <button type="button" title=${title} @mousedown=${(e: Event) => e.preventDefault()} @click=${act}
              class="flex h-7 w-7 items-center justify-center rounded text-[13px] ${on
                ? 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-200'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-700 dark:hover:text-slate-100'}">
        <i class="${fa(icon)}"></i></button>`
    const sep = html`<span class="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700"></span>`
    const color = (kind: 'text' | 'highlight', icon: string, title: string) => html`
      <label title=${title} class="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded text-[13px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">
        <i class="${fa(icon)}"></i>
        <input type="color" class="absolute inset-0 cursor-pointer opacity-0" .value=${kind === 'text' ? '#dc2626' : '#fde047'}
               @change=${(e: Event) => this.api?.color(kind, (e.target as HTMLInputElement).value)}>
      </label>`
    const f = this.formats
    return html`
      <div class="flex flex-wrap items-center gap-0.5 border-b border-slate-200 px-2 py-1 dark:border-slate-700">
        ${b('bold', 'Bold (Ctrl+B)', () => this.run('bold'), f.B)}
        ${b('italic', 'Italic (Ctrl+I)', () => this.run('italic'), f.I)}
        ${b('underline', 'Underline (Ctrl+U)', () => this.run('underline'), f.U)}
        ${b('strikethrough', 'Strikethrough', () => this.run('strikethrough'), f.S)}
        ${sep}
        ${color('text', 'font', 'Text colour')}
        ${color('highlight', 'highlighter', 'Highlight')}
        ${sep}
        ${b('list-ul', 'Bulleted list', () => this.run(f.UL ? 'removeList' : 'makeUnorderedList'), f.UL)}
        ${b('list-ol', 'Numbered list', () => this.run(f.OL ? 'removeList' : 'makeOrderedList'), f.OL)}
        ${b('outdent', 'Less indent', () => this.run(f.UL || f.OL ? 'decreaseListLevel' : 'decreaseQuoteLevel'))}
        ${b('indent', 'More indent', () => this.run(f.UL || f.OL ? 'increaseListLevel' : 'increaseQuoteLevel'))}
        ${b('quote-right', 'Quote', () => this.run(f.BLOCKQUOTE ? 'decreaseQuoteLevel' : 'increaseQuoteLevel'), f.BLOCKQUOTE)}
        ${sep}
        ${f.A
          ? b('link-slash', 'Remove link', () => this.api?.link(null), true)
          : b('link', 'Link', () => { this.linking = !this.linking })}
        ${b('image', 'Insert image', () => this.pickImage())}
        ${sep}
        ${b('text-slash', 'Remove formatting', () => this.run('removeAllFormatting'))}
        ${b('rotate-left', 'Undo (Ctrl+Z)', () => this.run('undo'))}
      </div>
      ${this.linking ? html`
        <form class="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5 dark:border-slate-700" @submit=${this.link}>
          <i class="${fa('link')} text-xs text-slate-400"></i>
          <input name="url" autofocus placeholder="https://… or an address" class="min-w-0 flex-1 bg-transparent text-sm outline-none"
                 @keydown=${(e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); this.linking = false } }}>
          <button class="text-xs font-medium text-sky-700 dark:text-sky-400">Apply</button>
        </form>` : nothing}
      ${this.hasRemote && !this.remote ? html`
        <div class="flex items-center gap-3 bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <i class="${fa('image')}"></i> Remote images are hidden here (they are sent).
          <button type="button" class="font-semibold underline" @click=${this.showRemote}>Show them</button>
        </div>` : nothing}
      <iframe src=${this.remote ? '/editor.html?remote' : '/editor.html'} title="Message body" @load=${this.onLoad}></iframe>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-rich-editor': RichEditor } }
