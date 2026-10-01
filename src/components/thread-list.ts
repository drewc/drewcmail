import { html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { BaseElement, fa } from './base.ts'
import { api, threadQuery } from '../api.ts'
import { HIDDEN_TAGS, shortDate } from '../format.ts'
import type { ThreadSummary } from '../types.ts'

/** tags that are a thread's state, set by the menu's own actions — not offered as labels */
const STATE_TAGS = new Set([...HIDDEN_TAGS, 'deleted', 'spam', 'draft', 'drafts'])

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
  /** the menu's "Labels…" panel: every label, those ticked, what the filter box says */
  @state() private labels: { x: number; y: number; t: ThreadSummary; all: string[]; on: Set<string>; filter: string } | null = null

  private closeMenu = () => { this.menu = null; this.labels = null }
  private menuKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && (this.menu || this.labels)) { e.stopPropagation(); this.closeMenu() }
  }

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
    // kept inside the window (the menu, and the labels panel that replaces it, up to 24rem tall, 15rem wide)
    this.labels = null
    this.menu = { x: Math.min(e.clientX, innerWidth - 248), y: Math.max(8, Math.min(e.clientY, innerHeight - 392)), t }
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

  /** from the menu: the thread's labels as ticks, applied together */
  private async openLabels(e: Event, t: ThreadSummary) {
    e.stopPropagation()
    const { x, y } = this.menu!
    this.menu = null
    const own = t.tags.filter(tag => !STATE_TAGS.has(tag))
    this.labels = { x, y, t, all: own, on: new Set(own), filter: '' }
    this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>('input[name=label-filter]')?.focus())
    try {
      const all = (await api.tags()).filter(tag => !STATE_TAGS.has(tag))
      if (this.labels?.t === t) this.labels = { ...this.labels, all: [...new Set([...all, ...own])].sort((a, b) => a.localeCompare(b)) }
    } catch (err) { this.emit('toast', { text: (err as Error).message }) }
  }

  private async applyLabels() {
    const l = this.labels
    if (!l) return
    const had = new Set(l.t.tags.filter(tag => !STATE_TAGS.has(tag)))
    const add = [...l.on].filter(tag => !had.has(tag))
    const remove = [...had].filter(tag => !l.on.has(tag))
    this.labels = null
    if (!add.length && !remove.length) return
    try {
      await api.tag(threadQuery(l.t.thread), add, remove)
      const said = [add.length ? `added ${add.join(', ')}` : '', remove.length ? `removed ${remove.join(', ')}` : ''].filter(Boolean).join('; ')
      this.emit('toast', { text: said[0].toUpperCase() + said.slice(1) })
      this.emit('changed')
    } catch (err) { this.emit('toast', { text: (err as Error).message }) }
  }

  private renderLabels() {
    const l = this.labels!
    const f = l.filter.trim()
    const shown = l.all.filter(tag => tag.toLowerCase().includes(f.toLowerCase()))
    const creatable = f && !/[",]/.test(f) && !STATE_TAGS.has(f) && !l.all.some(tag => tag.toLowerCase() === f.toLowerCase())
    // from the current state, not this render's copy: two ticks can land before a re-render
    const toggle = (tag: string) => {
      const cur = this.labels!
      const on = new Set(cur.on)
      if (on.has(tag)) on.delete(tag); else on.add(tag)
      this.labels = { ...cur, on }
    }
    const create = () => {
      const cur = this.labels!
      this.labels = { ...cur, all: [...cur.all, f].sort((a, b) => a.localeCompare(b)), on: new Set([...cur.on, f]), filter: '' }
    }
    return html`
      <div role="dialog" aria-label="Labels" style="left:${l.x}px;top:${l.y}px"
           @click=${(e: Event) => e.stopPropagation()} @contextmenu=${(e: Event) => e.preventDefault()}
           class="fixed z-50 flex max-h-96 w-60 flex-col rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800">
        <div class="border-b border-slate-200 px-3 pt-2 pb-1.5 dark:border-slate-700">
          <p class="mb-1 text-xs font-medium text-slate-500">Label as:</p>
          <input name="label-filter" placeholder="Filter or new label" .value=${l.filter} autocomplete="off"
                 class="w-full rounded border border-slate-300 bg-transparent px-2 py-1 text-sm outline-none focus:border-sky-500 dark:border-slate-600"
                 @input=${(e: Event) => { this.labels = { ...this.labels!, filter: (e.target as HTMLInputElement).value } }}
                 @keydown=${(e: KeyboardEvent) => {
                   if (e.key !== 'Enter') return
                   e.preventDefault()
                   if (creatable) create()
                   else if (f && shown.length === 1) { toggle(shown[0]); this.labels = { ...this.labels!, filter: '' } }
                   else this.applyLabels()
                 }}>
        </div>
        <ul class="min-h-0 flex-1 overflow-y-auto py-1">
          ${shown.map(tag => html`
            <li><label class="flex cursor-pointer items-center gap-2.5 px-3 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-700">
              <input type="checkbox" class="accent-sky-600" .checked=${l.on.has(tag)} @change=${() => toggle(tag)}>
              <span class="truncate">${tag}</span>
            </label></li>`)}
          ${creatable ? html`
            <li><button class="flex w-full items-center gap-2.5 px-3 py-1 text-left text-sm text-sky-700 hover:bg-slate-100 dark:text-sky-400 dark:hover:bg-slate-700" @click=${create}>
              <i class="${fa('plus')} w-3.5 text-center"></i><span class="truncate">Create “${f}”</span></button></li>` : ''}
          ${!shown.length && !creatable ? html`<li class="px-3 py-1 text-sm text-slate-400">No labels</li>` : ''}
        </ul>
        <div class="flex justify-end gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-700">
          <button class="rounded-md px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700" @click=${() => { this.labels = null }}>Cancel</button>
          <button class="rounded-md bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-700" @click=${() => this.applyLabels()}>Apply</button>
        </div>
      </div>`
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
                 ${(this.menu ?? this.labels)?.t.thread === t.thread ? 'outline-2 -outline-offset-2 outline-sky-400' : ''}">
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
    const unread = t.tags.includes('unread'), starred = t.tags.includes('flagged'), inbox = t.tags.includes('inbox'), spam = t.tags.includes('spam')
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
        ${inbox ? item('box-archive', 'Archive', tagging([], ['inbox'])) : spam ? '' : item('inbox', 'Move to Inbox', tagging(['inbox'], ['deleted', 'spam']))}
        ${item(unread ? 'envelope-open' : 'envelope', unread ? 'Mark as read' : 'Mark as unread', tagging(unread ? [] : ['unread'], unread ? ['unread'] : []))}
        ${item('star', starred ? 'Remove star' : 'Star', tagging(starred ? [] : ['flagged'], starred ? ['flagged'] : []))}
        ${item('trash', 'Delete', tagging(['deleted'], ['inbox']))}
        ${spam
          ? item('circle-check', 'Not spam', tagging(['inbox'], ['spam']))
          : item('ban', 'Report spam', tagging(['spam'], ['inbox']))}
        <hr class="my-1 border-slate-200 dark:border-slate-700">
        ${item('tags', 'Labels…', e => this.openLabels(e, t))}
        ${item('filter', 'Filter messages like this…', () => { this.menu = null; this.emit('filters', { thread: t.thread }) })}
      </div>`
  }

  render() {
    return html`
      ${this.menu ? this.renderMenu(this.menu) : ''}
      ${this.labels ? this.renderLabels() : ''}
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
