import { html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { BaseElement, fa } from './base.ts'
import { api, threadQuery } from '../api.ts'
import { HIDDEN_TAGS, shortDate } from '../format.ts'
import type { ThreadSummary } from '../types.ts'

/** <mail-thread-list>: the search results, with a right-click menu. Emits open-thread, load-more, changed, filters. */
@customElement('mail-thread-list')
export class ThreadList extends BaseElement {
  @property({ attribute: false }) results: ThreadSummary[] = []
  @property() selected: string | null = null
  @property({ type: Number }) cursor = -1
  @property({ type: Boolean }) loading = false
  @property({ type: Boolean }) more = false
  @property() error = ''
  @property() q = ''
  /** the right-click menu: where, and for which thread */
  @state() private menu: { x: number; y: number; t: ThreadSummary } | null = null

  private closeMenu = () => { this.menu = null }
  private menuKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && this.menu) { e.stopPropagation(); this.closeMenu() } }

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('click', this.closeMenu)
    window.addEventListener('blur', this.closeMenu)
    window.addEventListener('resize', this.closeMenu)
    window.addEventListener('keydown', this.menuKey, true)
    // capture: a right-click anywhere closes the menu before a row's handler opens a new one
    window.addEventListener('contextmenu', this.closeMenu, true)
  }

  disconnectedCallback() {
    window.removeEventListener('click', this.closeMenu)
    window.removeEventListener('blur', this.closeMenu)
    window.removeEventListener('resize', this.closeMenu)
    window.removeEventListener('keydown', this.menuKey, true)
    window.removeEventListener('contextmenu', this.closeMenu, true)
    super.disconnectedCallback()
  }

  private openMenu(e: MouseEvent, t: ThreadSummary) {
    e.preventDefault()
    // kept inside the window (the menu is about 18rem tall, 15rem wide)
    this.menu = { x: Math.min(e.clientX, innerWidth - 248), y: Math.min(e.clientY, innerHeight - 300), t }
    this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('[role=menuitem]')?.focus())
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('cursor') && this.cursor >= 0)
      this.renderRoot.querySelector(`[data-i="${this.cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  private async quickTag(e: Event, t: ThreadSummary, add: string[], remove: string[]) {
    e.stopPropagation()
    this.menu = null
    try {
      await api.tag(threadQuery(t.thread), add, remove)
      this.emit('changed')
    } catch (err) { this.emit('toast', { text: (err as Error).message }) }
  }

  private row(t: ThreadSummary, i: number) {
    const unread = t.tags.includes('unread')
    const starred = t.tags.includes('flagged')
    const selected = t.thread === this.selected
    const labels = t.tags.filter(tag => !HIDDEN_TAGS.has(tag))
    return html`
      <li data-i=${i} @click=${() => this.emit('open-thread', { id: t.thread })} @contextmenu=${(e: MouseEvent) => this.openMenu(e, t)}
          class="group relative cursor-pointer border-b border-slate-100 px-3 py-2.5 dark:border-slate-800
                 ${selected ? 'bg-sky-50 dark:bg-sky-950' : unread ? 'bg-white dark:bg-slate-800/60' : 'hover:bg-slate-100 dark:hover:bg-slate-800/40'}
                 ${i === this.cursor ? 'shadow-[inset_3px_0_0] shadow-sky-500' : ''}
                 ${this.menu?.t.thread === t.thread ? 'outline-2 -outline-offset-2 outline-sky-400' : ''}">
        <div class="flex items-baseline gap-2">
          <button title=${starred ? 'Unstar' : 'Star'} @click=${(e: Event) => this.quickTag(e, t, starred ? [] : ['flagged'], starred ? ['flagged'] : [])}
                  class="${starred ? 'text-amber-400' : 'text-slate-300 hover:text-slate-500 dark:text-slate-600'}">
            <i class="${fa('star', starred ? 'solid' : 'regular')} text-xs"></i>
          </button>
          <span class="flex-1 truncate text-sm ${unread ? 'font-bold' : ''}">${t.authors}</span>
          ${t.total > 1 ? html`<span class="text-xs text-slate-500">${t.matched < t.total ? `${t.matched}/` : ''}${t.total}</span>` : ''}
          ${t.tags.includes('attachment') ? html`<i class="${fa('paperclip')} text-xs text-slate-400"></i>` : ''}
          <span class="text-xs whitespace-nowrap ${unread ? 'font-bold text-sky-700 dark:text-sky-400' : 'text-slate-500'}" title=${t.date_relative}>${shortDate(t.timestamp)}</span>
        </div>
        <div class="mt-0.5 flex items-center gap-1.5 pl-5">
          <span class="truncate text-sm ${unread ? 'font-semibold' : 'text-slate-600 dark:text-slate-400'}">${t.subject || '(no subject)'}</span>
          ${labels.map(l => html`<span class="shrink-0 rounded bg-slate-200 px-1.5 text-[11px] text-slate-700 dark:bg-slate-700 dark:text-slate-300">${l}</span>`)}
        </div>
        <div class="absolute top-1.5 right-2 hidden gap-1 rounded-md bg-white/90 p-0.5 shadow-sm group-hover:flex dark:bg-slate-800/90">
          ${t.tags.includes('inbox') ? html`
            <button title="Archive" class="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
                    @click=${(e: Event) => this.quickTag(e, t, [], ['inbox'])}><i class="${fa('box-archive')}"></i></button>` : ''}
          <button title=${unread ? 'Mark read' : 'Mark unread'} class="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
                  @click=${(e: Event) => this.quickTag(e, t, unread ? [] : ['unread'], unread ? ['unread'] : [])}>
            <i class="${fa(unread ? 'envelope-open' : 'envelope')}"></i></button>
          <button title="Delete" class="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
                  @click=${(e: Event) => this.quickTag(e, t, ['deleted'], ['inbox'])}><i class="${fa('trash')}"></i></button>
        </div>
      </li>`
  }

  private renderMenu({ x, y, t }: { x: number; y: number; t: ThreadSummary }) {
    const unread = t.tags.includes('unread'), starred = t.tags.includes('flagged'), inbox = t.tags.includes('inbox')
    const item = (icon: string, text: string, act: (e: Event) => void) => html`
      <button role="menuitem" class="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:hover:bg-slate-700 dark:focus:bg-slate-700"
              @click=${act}><i class="${fa(icon)} w-4 text-center text-slate-500"></i>${text}</button>`
    const tagging = (add: string[], remove: string[]) => (e: Event) => this.quickTag(e, t, add, remove)
    return html`
      <div role="menu" style="left:${x}px;top:${y}px" @click=${(e: Event) => e.stopPropagation()} @contextmenu=${(e: Event) => e.preventDefault()}
           @keydown=${(e: KeyboardEvent) => {
             if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
             e.preventDefault()
             const items = [...this.renderRoot.querySelectorAll<HTMLElement>('[role=menuitem]')]
             const at = items.indexOf(this.shadowRoot?.activeElement as HTMLElement)
             items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
           }}
           class="fixed z-50 w-60 rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-800">
        ${item('up-right-from-square', 'Open', () => { this.menu = null; this.emit('open-thread', { id: t.thread }) })}
        ${inbox ? item('box-archive', 'Archive', tagging([], ['inbox'])) : item('inbox', 'Move to Inbox', tagging(['inbox'], ['deleted', 'spam']))}
        ${item(unread ? 'envelope-open' : 'envelope', unread ? 'Mark as read' : 'Mark as unread', tagging(unread ? [] : ['unread'], unread ? ['unread'] : []))}
        ${item('star', starred ? 'Remove star' : 'Star', tagging(starred ? [] : ['flagged'], starred ? ['flagged'] : []))}
        ${item('trash', 'Delete', tagging(['deleted'], ['inbox']))}
        ${item('ban', 'Report spam', tagging(['spam'], ['inbox']))}
        <hr class="my-1 border-slate-200 dark:border-slate-700">
        ${item('filter', 'Filter messages like this…', () => { this.menu = null; this.emit('filters', { thread: t.thread }) })}
      </div>`
  }

  render() {
    return html`
      ${this.menu ? this.renderMenu(this.menu) : ''}
      <div class="h-full overflow-y-auto" @scroll=${this.closeMenu}>
        ${this.error ? html`<p class="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"><i class="${fa('triangle-exclamation')}"></i> ${this.error}</p>` : ''}
        <ul>${repeat(this.results, t => t.thread, (t, i) => this.row(t, i))}</ul>
        ${this.loading ? html`<p class="p-4 text-center text-slate-400"><i class="${fa('spinner')} fa-spin"></i></p>` : ''}
        ${!this.loading && !this.error && !this.results.length ? html`<p class="p-8 text-center text-sm text-slate-400">No conversations match <code>${this.q}</code></p>` : ''}
        ${this.more && !this.loading ? html`
          <button class="w-full py-3 text-sm text-sky-700 hover:bg-slate-100 dark:text-sky-400 dark:hover:bg-slate-800" @click=${() => this.emit('load-more')}>
            Load more
          </button>` : ''}
      </div>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-thread-list': ThreadList } }
