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
/** a tag as a query: quoted when it has spaces (Gmail labels do) or query syntax */
const tagQuery = (t: string) => `tag:${/[\s()"]/.test(t) ? `"${t}"` : t}`

/** a confirm before tagging this many threads at once (and pushing them all to Gmail) */
const MANY = 50

/**
 * <mail-sidebar>: compose, saved searches with unread counts, and every other tag — a
 * tag's right-click menu: mark all read, unread only, archive, rename (to an existing
 * tag = merge), remove. Emits search, changed, toast, compose, filters, accounts.
 */
@customElement('mail-sidebar')
export class Sidebar extends BaseElement {
  @property() q = ''
  @state() private tags: string[] = []
  @state() private counts: Record<string, number> = {}
  /** a tag's right-click menu; `rename` while its name is being edited */
  @state() private menu: { x: number; y: number; tag: string; rename?: string } | null = null

  private closeMenu = () => { this.menu = null }
  private menuKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && this.menu) { e.stopPropagation(); this.closeMenu() } }

  connectedCallback() {
    super.connectedCallback()
    this.addEventListener('refresh', () => this.load())
    window.addEventListener('click', this.closeMenu)
    window.addEventListener('blur', this.closeMenu)
    window.addEventListener('resize', this.closeMenu)
    window.addEventListener('keydown', this.menuKey, true)
    window.addEventListener('contextmenu', this.closeMenu, true)
    this.load()
  }

  disconnectedCallback() {
    window.removeEventListener('click', this.closeMenu)
    window.removeEventListener('blur', this.closeMenu)
    window.removeEventListener('resize', this.closeMenu)
    window.removeEventListener('keydown', this.menuKey, true)
    window.removeEventListener('contextmenu', this.closeMenu, true)
    super.disconnectedCallback()
  }

  private openMenu(e: MouseEvent, tag: string) {
    e.preventDefault()
    this.menu = { x: Math.min(e.clientX, innerWidth - 248), y: Math.max(8, Math.min(e.clientY, innerHeight - 260)), tag }
    this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('[role=menuitem]')?.focus())
  }

  /** tag every thread matching `query`; asks first when that is many (`what` says what will happen; null: asked already) */
  private async tagAll(query: string, add: string[], remove: string[], what: ((n: number) => string) | null, done: string) {
    this.menu = null
    try {
      const n = (await api.count([query]))[query] ?? 0
      if (!n) { this.emit('toast', { text: 'Nothing to change' }); return }
      if (what && n > MANY && !confirm(`${what(n)}?`)) return
      await api.tag(query, add, remove)
      this.emit('toast', { text: done })
      this.emit('changed')
    } catch (e) { this.emit('toast', { text: (e as Error).message }) }
  }

  private async rename(e: Event) {
    e.preventDefault()
    const m = this.menu
    const to = m?.rename?.trim()
    if (!m || !to || to === m.tag) { this.menu = null; return }
    if (/[",]/.test(to) || HIDDEN_TAGS.has(to) || ['spam', 'deleted'].includes(to)) {
      this.emit('toast', { text: `“${to}” can't be a label name` })
      return
    }
    const merge = this.tags.includes(to)
    const viewing = this.q === tagQuery(m.tag)
    await this.tagAll(tagQuery(m.tag), [to], [m.tag],
      n => `${merge ? 'Merge' : 'Rename'} “${m.tag}” ${merge ? 'into' : 'to'} “${to}” on ${n} conversations`,
      merge ? `Merged “${m.tag}” into “${to}”` : `Renamed “${m.tag}” to “${to}”`)
    if (viewing) this.emit('search', { q: tagQuery(to) })
  }

  private renderMenu() {
    const m = this.menu!
    const q = tagQuery(m.tag)
    const unread = this.counts[UNREAD(q)] ?? 0
    const item = (icon: string, text: string, act: () => void, danger = false) => html`
      <button role="menuitem" @click=${act}
              class="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm whitespace-nowrap hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:hover:bg-slate-700 dark:focus:bg-slate-700 ${danger ? 'text-red-700 dark:text-red-400' : ''}">
        <i class="${fa(icon)} w-4 text-center ${danger ? '' : 'text-slate-500'}"></i>${text}</button>`
    return html`
      <div role="menu" style="left:${m.x}px;top:${m.y}px" @click=${(e: Event) => e.stopPropagation()} @contextmenu=${(e: Event) => e.preventDefault()}
           @keydown=${(e: KeyboardEvent) => {
             if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
             e.preventDefault()
             const items = [...this.renderRoot.querySelectorAll<HTMLElement>('[role=menuitem]')]
             const at = items.indexOf(this.shadowRoot?.activeElement as HTMLElement)
             items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
           }}
           class="fixed z-50 w-60 rounded-lg border border-slate-200 bg-white py-1 text-slate-700 shadow-xl dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
        <p class="truncate px-3 pt-1 pb-1.5 text-xs font-medium text-slate-500">${m.tag}</p>
        ${m.rename !== undefined ? html`
          <form class="px-3 pb-2" @submit=${this.rename}>
            <input name="rename" .value=${m.rename} autocomplete="off"
                   @input=${(e: Event) => { this.menu = { ...this.menu!, rename: (e.target as HTMLInputElement).value } }}
                   class="w-full rounded border border-slate-300 bg-transparent px-2 py-1 text-sm outline-none focus:border-sky-500 dark:border-slate-600">
            <p class="mt-1 text-[11px] text-slate-400">An existing label's name merges them.</p>
            <div class="mt-2 flex justify-end gap-2">
              <button type="button" class="rounded-md px-2.5 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-700" @click=${() => { this.menu = null }}>Cancel</button>
              <button class="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700">Rename</button>
            </div>
          </form>` : html`
          ${item('envelope-open', unread ? `Mark all as read (${unread})` : 'Mark all as read', () =>
            this.tagAll(UNREAD(q), [], ['unread'], n => `Mark ${n} conversations in “${m.tag}” as read`, `Marked “${m.tag}” read`))}
          ${item('envelope', 'Show unread only', () => { this.menu = null; this.emit('search', { q: UNREAD(q) }) })}
          ${item('box-archive', 'Archive all in inbox', () =>
            this.tagAll(`(${q}) and tag:inbox`, [], ['inbox'], n => `Archive ${n} conversations in “${m.tag}”`, `Archived “${m.tag}”`))}
          <hr class="my-1 border-slate-200 dark:border-slate-700">
          ${item('pen', 'Rename…', () => {
            this.menu = { ...m, rename: m.tag }
            this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>('input[name=rename]')?.select())
          })}
          ${item('tag', 'Remove label', async () => {
            const n = (await api.count([q]).catch(() => ({} as Record<string, number>)))[q] ?? 0
            if (!confirm(`Remove “${m.tag}” from ${n} conversations? The mail stays; only the label goes.`)) { this.menu = null; return }
            const viewing = this.q === q
            await this.tagAll(q, [], [m.tag], null, `Removed “${m.tag}”`)
            if (viewing) this.emit('search', { q: 'tag:inbox' })
          }, true)}`}
      </div>`
  }

  private async load() {
    try {
      const tags = (await api.tags()).filter(t => !HIDDEN_TAGS.has(t) && !['spam', 'deleted'].includes(t))
      // every count in one request (one `notmuch count --batch` on the server): folders and tags alike
      this.counts = await api.count([...FOLDERS.filter(f => f[3]).map(f => UNREAD(f[2])), ...tags.map(t => UNREAD(tagQuery(t)))])
      this.tags = tags
    } catch { /* the list still works without counts */ }
  }

  /** `count` shows on the right; `paren` (tags) after the name, "receipts (3)", bold while there is unread mail */
  private item(label: string, icon: string, q: string, count?: number, paren = false) {
    const active = this.q === q
    const menu = paren && this.menu?.tag === label
    return html`
      <li>
        <a href="#${new URLSearchParams({ q })}" @contextmenu=${paren ? (e: MouseEvent) => this.openMenu(e, label) : null}
           class="flex items-center gap-3 rounded-r-full py-1.5 pr-3 pl-4 text-sm ${active
             ? 'bg-sky-100 font-semibold text-sky-800 dark:bg-sky-900/60 dark:text-sky-200'
             : 'hover:bg-slate-200/70 dark:hover:bg-slate-800'} ${menu ? 'outline-2 -outline-offset-2 outline-sky-400' : ''}">
          <i class="${fa(icon)} w-4 text-center ${active ? '' : 'text-slate-500 dark:text-slate-400'}"></i>
          ${paren
            ? html`<span class="flex min-w-0 flex-1 ${count ? 'font-semibold' : ''}"><span class="truncate">${label}</span>${count ? html`<span class="shrink-0 whitespace-pre"> (${count})</span>` : ''}</span>`
            : html`<span class="flex-1 truncate">${label}</span>${count ? html`<span class="text-xs font-semibold">${count}</span>` : ''}`}
        </a>
      </li>`
  }

  render() {
    return html`
      ${this.menu ? this.renderMenu() : ''}
      <nav class="flex h-full flex-col overflow-y-auto py-3 pr-2" @scroll=${this.closeMenu}>
        <button @click=${() => this.emit('compose', {})}
                class="mb-4 ml-3 flex w-fit items-center gap-3 rounded-2xl bg-sky-600 px-5 py-3 font-medium text-white shadow hover:bg-sky-700">
          <i class="${fa('pen')}"></i> Compose
        </button>
        <ul>${FOLDERS.map(([label, icon, q, unread]) => this.item(label, icon, q, unread ? this.counts[UNREAD(q)] : undefined))}</ul>
        ${this.tags.length ? html`
          <h2 class="mt-5 mb-1 pl-4 text-xs font-semibold tracking-wide text-slate-500 uppercase">Tags</h2>
          <ul>${this.tags.map(t => this.item(t, 'tag', tagQuery(t), this.counts[UNREAD(tagQuery(t))], true))}</ul>` : ''}
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
