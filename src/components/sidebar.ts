import { html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import { api } from '../api.ts'
import { HIDDEN_TAGS } from '../format.ts'

/** saved searches: [label, icon, query, show-unread-count] */
const FOLDERS: [string, string, string, boolean][] = [
  ['Inbox', 'inbox', 'tag:inbox', true],
  ['Unread', 'envelope', 'tag:unread', true],
  ['Starred', 'star', 'tag:flagged', false],
  ['Sent', 'paper-plane', 'tag:sent', false],
  ['Attachments', 'paperclip', 'tag:attachment', false],
  ['Spam', 'ban', 'tag:spam', false],
  ['Trash', 'trash', 'tag:deleted', false],
  ['All mail', 'box-archive', '*', false],
]
const UNREAD = (q: string) => q === 'tag:unread' ? q : `(${q}) and tag:unread`

/** <mail-sidebar>: compose, saved searches with unread counts, and every other tag */
@customElement('mail-sidebar')
export class Sidebar extends BaseElement {
  @property() q = ''
  @state() private tags: string[] = []
  @state() private counts: Record<string, number> = {}

  connectedCallback() {
    super.connectedCallback()
    this.addEventListener('refresh', () => this.load())
    this.load()
  }

  private async load() {
    try {
      const [tags, counts] = await Promise.all([api.tags(), api.count(FOLDERS.filter(f => f[3]).map(f => UNREAD(f[2])))])
      this.tags = tags.filter(t => !HIDDEN_TAGS.has(t) && !['spam', 'deleted'].includes(t))
      this.counts = counts
    } catch { /* the list still works without counts */ }
  }

  private item(label: string, icon: string, q: string, count?: number) {
    const active = this.q === q
    return html`
      <li>
        <a href="#${new URLSearchParams({ q })}"
           class="flex items-center gap-3 rounded-r-full py-1.5 pr-3 pl-4 text-sm ${active
             ? 'bg-sky-100 font-semibold text-sky-800 dark:bg-sky-900/60 dark:text-sky-200'
             : 'hover:bg-slate-200/70 dark:hover:bg-slate-800'}">
          <i class="${fa(icon)} w-4 text-center ${active ? '' : 'text-slate-500 dark:text-slate-400'}"></i>
          <span class="flex-1 truncate">${label}</span>
          ${count ? html`<span class="text-xs font-semibold">${count}</span>` : ''}
        </a>
      </li>`
  }

  render() {
    return html`
      <nav class="flex h-full flex-col overflow-y-auto py-3 pr-2">
        <button @click=${() => this.emit('compose', {})}
                class="mb-4 ml-3 flex w-fit items-center gap-3 rounded-2xl bg-sky-600 px-5 py-3 font-medium text-white shadow hover:bg-sky-700">
          <i class="${fa('pen')}"></i> Compose
        </button>
        <ul>${FOLDERS.map(([label, icon, q, unread]) => this.item(label, icon, q, unread ? this.counts[UNREAD(q)] : undefined))}</ul>
        ${this.tags.length ? html`
          <h2 class="mt-5 mb-1 pl-4 text-xs font-semibold tracking-wide text-slate-500 uppercase">Tags</h2>
          <ul>${this.tags.map(t => this.item(t, 'tag', `tag:${/[\s()"]/.test(t) ? `"${t}"` : t}`))}</ul>` : ''}
        <span class="flex-1"></span>
        <button @click=${() => this.emit('filters')}
                class="mt-4 flex items-center gap-3 rounded-r-full py-1.5 pr-3 pl-4 text-left text-sm text-slate-600 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800">
          <i class="${fa('filter')} w-4 text-center"></i> Filters
        </button>
        <button @click=${() => this.emit('accounts')}
                class="flex items-center gap-3 rounded-r-full py-1.5 pr-3 pl-4 text-left text-sm text-slate-600 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800">
          <i class="${fa('user-gear')} w-4 text-center"></i> Accounts
        </button>
      </nav>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-sidebar': Sidebar } }
