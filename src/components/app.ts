import { html } from 'lit'
import { customElement, state, query } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { BaseElement, fa } from './base.ts'
import { api, threadQuery } from '../api.ts'
import type { Activity, Draft, Identity, SyncState, ThreadSummary } from '../types.ts'
import './sidebar.ts'
import './thread-list.ts'
import './thread-view.ts'
import './compose.ts'
import './accounts.ts'
import './filters.ts'
import type { ThreadView } from './thread-view.ts'

const PAGE = 50
/**
 * The build this page runs: its entry script, whose name carries a content hash (the
 * whole app is one chunk). The server says which one index.html loads now; when that
 * differs, a new version was installed. None unless this page is a build (not under Vite's
 * dev server, which reloads by itself — whatever NODE_ENV says).
 */
const ENTRY = (p => /^\/assets\/[^/]+\.js$/.test(p) ? p : null)(new URL(import.meta.url).pathname)
const VERSION_CHECK = 5 * 60_000
/** how often to ask the server what it is doing: now and then, often while the popover is open */
const ACTIVITY_POLL = 5_000
const ACTIVITY_POLL_OPEN = 1_500

/** 42 s · 3 m 5 s · 1 h 12 m */
const elapsed = (since: string) => {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} m ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`
}
const DEFAULT_QUERY = 'tag:inbox'

/** where we are lives in the hash: #q=<notmuch query>&t=<thread id> */
const readHash = () => {
  const p = new URLSearchParams(location.hash.slice(1))
  return { q: p.get('q') ?? DEFAULT_QUERY, t: p.get('t') }
}
const writeHash = (q: string, t: string | null) => {
  const p = new URLSearchParams({ q })
  if (t) p.set('t', t)
  const next = '#' + p.toString()
  if (location.hash !== next) location.hash = next
}

/**
 * <mail-app>: the shell. Holds the search, its results and the open thread, and
 * listens for the events the other components emit:
 *   search {q} · open-thread {id} · compose {Draft} · changed (tags changed: reload) · toast {text}
 *   filters {thread?} (open the filters dialog, on a new filter for mail like that thread)
 *   identities-changed (reload the From addresses)
 * and asks to reload when a new version of the app is installed.
 */
@customElement('mail-app')
export class MailApp extends BaseElement {
  @state() private q = DEFAULT_QUERY
  @state() private threadId: string | null = null
  @state() private results: ThreadSummary[] = []
  @state() private more = false
  @state() private loading = false
  @state() private error = ''
  @state() private drafts: { key: number; draft: Draft }[] = []
  @state() private identities: Identity[] = []
  /** a newer build's entry script, when there is one to offer; `declined` is the one the user said Not now to */
  @state() private newVersion: string | null = null
  private declined: string | null = null
  /** what the server is doing (polled); the popover under the spinner lists it */
  @state() private activity: Activity[] = []
  @state() private showActivity = false
  private activityTimer?: number
  private versionTimer?: number
  @state() private sync: SyncState = { running: false }
  @state() private toast = ''
  @state() private cursor = -1
  @state() private showAccounts = false
  /** the filters dialog: closed, or open (on a new filter for mail like `thread`) */
  @state() private showFilters: null | { thread?: string } = null

  @query('mail-thread-view') private view?: ThreadView
  @query('#search') private searchInput?: HTMLInputElement

  private searchSeq = 0
  private toastTimer?: number

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('hashchange', this.onHash)
    window.addEventListener('keydown', this.onKey)
    this.addEventListener('search', e => writeHash((e as CustomEvent<{ q: string }>).detail.q, null))
    this.addEventListener('open-thread', e => this.open((e as CustomEvent<{ id: string }>).detail.id))
    this.addEventListener('compose', e => this.compose((e as CustomEvent<Draft>).detail ?? {}))
    this.addEventListener('changed', () => this.refresh())
    this.addEventListener('toast', e => this.say((e as CustomEvent<{ text: string }>).detail.text))
    this.addEventListener('sync', () => this.runSync())
    this.addEventListener('accounts', () => { this.showAccounts = true })
    this.addEventListener('filters', e => { this.showFilters = (e as CustomEvent<{ thread?: string }>).detail ?? {} })
    // an account was added: its first sync is running on the server
    this.addEventListener('sync-started', () => { this.sync = { ...this.sync, running: true }; setTimeout(() => this.pollSync(), 1000) })
    this.onHash()
    this.finishOAuth()
    this.loadIdentities()
    this.pollActivity()
    window.addEventListener('click', this.closeActivity)
    if (ENTRY) {
      document.addEventListener('visibilitychange', this.checkVersion)
      window.addEventListener('focus', this.checkVersion)
      this.versionTimer = window.setInterval(this.checkVersion, VERSION_CHECK)
    }
    // the Send as list changed (accounts.ts), or an account added an address
    this.addEventListener('identities-changed', () => this.loadIdentities())
    api.syncState().then(s => { this.sync = s }).catch(() => {})
  }

  /** has another build been installed since this page loaded? */
  private checkVersion = async () => {
    if (document.visibilityState !== 'visible' || this.newVersion) return
    try {
      const { entry } = await api.version()
      if (entry && entry !== ENTRY && entry !== this.declined) this.newVersion = entry
    } catch { /* the server is restarting: ask next time */ }
  }

  /** ask the server what it is doing — the spinner spins while anything runs, not only syncs started here */
  private pollActivity = async () => {
    clearTimeout(this.activityTimer)
    if (document.visibilityState === 'visible' || this.showActivity) {
      try {
        const { activity, sync } = await api.activity()
        const finished = this.sync.running && !sync.running
        this.activity = activity
        this.sync = sync
        if (finished) await this.refresh()
      } catch { /* the server is restarting */ }
    }
    this.activityTimer = window.setTimeout(this.pollActivity, this.showActivity ? ACTIVITY_POLL_OPEN : ACTIVITY_POLL)
  }

  private get busy() { return this.sync.running || this.activity.length > 0 }

  /** the spinner: fetch mail when idle; while busy, show what is running */
  private onSyncButton(e: Event) {
    e.stopPropagation()
    if (this.busy) {
      this.showActivity = !this.showActivity
      if (this.showActivity) this.pollActivity()
    } else this.runSync()
  }

  private closeActivity = () => { this.showActivity = false }

  private renderActivity() {
    const last = this.sync.last ? `${elapsed(this.sync.last)} ago` : 'not yet'
    return html`
      <div role="dialog" aria-label="What is running" @click=${(e: Event) => e.stopPropagation()}
           @keydown=${(e: KeyboardEvent) => { if (e.key === 'Escape') this.closeActivity() }}
           class="absolute top-full right-0 z-50 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-800">
        ${this.activity.length ? html`
          <ul class="space-y-2">
            ${this.activity.map(a => html`
              <li class="flex gap-2.5">
                <i class="${a.waiting ? fa('hourglass-half') : `${fa('spinner')} fa-spin`} mt-0.5 w-4 text-center text-slate-400"></i>
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2">
                    <span class="flex-1 truncate font-medium ${a.waiting ? 'text-slate-500' : ''}" title=${a.what}>${a.what}${a.waiting ? ' — waiting its turn' : ''}</span>
                    <span class="shrink-0 text-xs text-slate-500 tabular-nums">${elapsed(a.since)}</span>
                  </div>
                  ${a.detail ? html`<div class="truncate text-xs text-slate-500" title=${a.detail}>${a.detail}</div>` : ''}
                </div>
              </li>`)}
          </ul>`
          : html`<p class="text-slate-500">Nothing running.</p>`}
        <p class="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-500 dark:border-slate-700">
          Last sync ${last}${this.sync.ok === false ? html` — <span class="text-red-600">failed</span>` : this.sync.last ? ' — ok' : ''}
        </p>
        ${this.sync.ok === false && this.sync.error ? html`
          <pre class="mt-1 max-h-32 overflow-auto rounded bg-red-50 p-1.5 text-[11px] whitespace-pre-wrap text-red-700 dark:bg-red-950 dark:text-red-300">${this.sync.error}</pre>` : ''}
      </div>`
  }

  private declineReload() {
    this.declined = this.newVersion
    this.newVersion = null
  }

  private renderReload() {
    const drafts = this.drafts.length
    return html`
      <div class="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4"
           @keydown=${(e: KeyboardEvent) => { if (e.key === 'Escape') this.declineReload() }}>
        <section role="alertdialog" aria-labelledby="reload-title" aria-describedby="reload-text"
                 class="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl dark:bg-slate-800">
          <h2 id="reload-title" class="mb-2 flex items-center gap-2 font-semibold">
            <i class="${fa('rotate')} text-sky-600"></i> A new version of drewcmail is installed
          </h2>
          <p id="reload-text" class="text-sm text-slate-600 dark:text-slate-400">
            Reload now to use it?
            ${drafts ? html`<b class="text-amber-700 dark:text-amber-400">Your ${drafts === 1 ? 'open draft is' : `${drafts} open drafts are`} not saved and will be lost.</b>` : ''}
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <button class="rounded-lg px-4 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700" @click=${this.declineReload}>Not now</button>
            <button id="reload-yes" class="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-700"
                    @click=${() => location.reload()}>Reload</button>
          </div>
        </section>
      </div>`
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('newVersion') && this.newVersion) (this.renderRoot.querySelector('#reload-yes') as HTMLElement | null)?.focus()
  }

  private loadIdentities() { api.identities().then(i => { this.identities = i }).catch(() => {}) }

  disconnectedCallback() {
    clearTimeout(this.activityTimer)
    window.removeEventListener('click', this.closeActivity)
    document.removeEventListener('visibilitychange', this.checkVersion)
    window.removeEventListener('focus', this.checkVersion)
    clearInterval(this.versionTimer)
    window.removeEventListener('hashchange', this.onHash)
    window.removeEventListener('keydown', this.onKey)
    super.disconnectedCallback()
  }

  /**
   * Back from Google's consent screen (see accounts.ts): the query string carries the
   * code — hand the whole address to the server, which finishes connecting the account.
   * On a fresh install with no mail and no account, open the accounts dialog.
   */
  private async finishOAuth() {
    const params = new URLSearchParams(location.search)
    if (params.has('state') && (params.has('code') || params.has('error'))) {
      const returned = location.href
      history.replaceState(null, '', location.pathname + location.hash)
      this.showAccounts = true
      try {
        const { email } = await api.gmailFinish(returned)
        this.say(`Connected ${email} — the first download can take a while`)
        this.loadIdentities()
    this.pollActivity()
    window.addEventListener('click', this.closeActivity)
    if (ENTRY) {
      document.addEventListener('visibilitychange', this.checkVersion)
      window.addEventListener('focus', this.checkVersion)
      this.versionTimer = window.setInterval(this.checkVersion, VERSION_CHECK)
    }
        this.sync = { ...this.sync, running: true }
        this.pollSync()
      } catch (e) { this.say((e as Error).message) }
      return
    }
    try {
      const [accounts, counts] = await Promise.all([api.gmailAccounts(), api.count(['*'])])
      if (!accounts.length && !counts['*']) this.showAccounts = true
    } catch { /* not important */ }
  }

  /** follow a sync started elsewhere (the first Gmail pull) and refresh when it is done */
  private async pollSync() {
    try {
      this.sync = await api.syncState()
      await this.refresh()
    } catch { /* try again */ }
    if (this.sync.running) setTimeout(() => this.pollSync(), 5000)
  }

  private onHash = () => {
    const { q, t } = readHash()
    const newSearch = q !== this.q || !this.results.length
    this.q = q
    this.threadId = t
    if (newSearch) this.load()
    this.cursor = t ? this.results.findIndex(r => r.thread === t) : this.cursor
  }

  private open(id: string | null) { writeHash(this.q, id) }

  private draftKey = 0
  private compose(draft: Draft) { this.drafts = [...this.drafts, { key: ++this.draftKey, draft }] }

  private async load(append = false) {
    const seq = ++this.searchSeq
    this.loading = true
    this.error = ''
    try {
      const offset = append ? this.results.length : 0
      const page = await api.search(this.q, offset, PAGE)
      if (seq !== this.searchSeq) return
      this.results = append ? [...this.results, ...page] : page
      this.more = page.length === PAGE
      if (!append) this.cursor = this.threadId ? this.results.findIndex(r => r.thread === this.threadId) : -1
    } catch (e) {
      if (seq === this.searchSeq) { this.error = (e as Error).message; this.results = [] }
    } finally {
      if (seq === this.searchSeq) this.loading = false
    }
  }

  /** re-run the search keeping as many results as are shown, and reload the open thread */
  private async refresh() {
    const seq = ++this.searchSeq
    try {
      const page = await api.search(this.q, 0, Math.max(PAGE, this.results.length))
      if (seq === this.searchSeq) this.results = page
    } catch { /* keep what we have */ }
    this.view?.reload()
    this.shadowRoot?.querySelector('mail-sidebar')?.dispatchEvent(new Event('refresh'))
  }

  private async runSync() {
    this.sync = { ...this.sync, running: true }
    try {
      this.sync = await api.sync()
      if (this.sync.ok === false) this.say(`Sync failed: ${this.sync.error}`)
      await this.refresh()
    } catch (e) {
      this.sync = { running: false, ok: false, error: (e as Error).message }
      this.say(`Sync failed: ${(e as Error).message}`)
    }
  }

  private say(text: string) {
    this.toast = text
    clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => { this.toast = '' }, 5000)
  }

  /** tag the selected thread (or the one under the cursor) */
  private async tagCurrent(add: string[], remove: string[], label: string) {
    const id = this.threadId ?? this.results[this.cursor]?.thread
    if (!id) return
    try {
      await api.tag(threadQuery(id), add, remove)
      this.say(label)
      await this.refresh()
    } catch (e) { this.say((e as Error).message) }
  }

  private toggleStar() {
    const id = this.threadId ?? this.results[this.cursor]?.thread
    const starred = this.results.find(r => r.thread === id)?.tags.includes('flagged')
    return starred ? this.tagCurrent([], ['flagged'], 'Unstarred') : this.tagCurrent(['flagged'], [], 'Starred')
  }

  private move(by: number) {
    if (!this.results.length) return
    this.cursor = Math.max(0, Math.min(this.results.length - 1, this.cursor + by))
    if (this.threadId) this.open(this.results[this.cursor].thread)
  }

  /** keyboard shortcuts, roughly Gmail's; ignored while typing */
  private onKey = (e: KeyboardEvent) => {
    const target = e.composedPath()[0] as HTMLElement
    if (e.ctrlKey || e.metaKey || e.altKey || this.newVersion) return
    if (target?.closest?.('input, textarea, select, [contenteditable]')) {
      if (e.key === 'Escape') target.blur()
      return
    }
    const current = this.results[this.cursor]
    const actions: Record<string, () => void> = {
      '/': () => { this.searchInput?.focus(); this.searchInput?.select() },
      'j': () => this.move(1),
      'k': () => this.move(-1),
      'Enter': () => current && this.open(current.thread),
      'o': () => current && this.open(current.thread),
      'Escape': () => this.open(null),
      'u': () => this.open(null),
      'c': () => this.compose({}),
      'r': () => this.view?.replyLast('sender'),
      'a': () => this.view?.replyLast('all'),
      'e': () => this.tagCurrent([], ['inbox'], 'Archived'),
      'y': () => this.tagCurrent([], ['inbox'], 'Archived'),
      '#': () => this.tagCurrent(['deleted'], ['inbox'], 'Moved to trash'),
      's': () => this.toggleStar(),
      '!': () => this.tagCurrent(['spam'], ['inbox'], 'Marked as spam'),
      'U': () => this.tagCurrent(['unread'], [], 'Marked unread'),
      'I': () => this.tagCurrent([], ['unread'], 'Marked read'),
      'g': () => this.runSync(),
    }
    const act = actions[e.key]
    if (act) { e.preventDefault(); act() }
  }

  private onSearch(e: Event) {
    e.preventDefault()
    const q = this.searchInput?.value.trim() || '*'
    writeHash(q, null)
  }

  render() {
    const narrowThread = this.threadId ? 'hidden lg:flex' : 'flex'
    return html`
      <div class="flex h-dvh flex-col bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200">
        <header class="flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
          <a href="#q=tag%3Ainbox" class="flex items-center gap-2 font-semibold text-sky-700 dark:text-sky-400">
            <i class="${fa('envelope-open-text')} text-xl"></i><span class="hidden sm:inline">drewcmail</span>
          </a>
          <form class="flex flex-1 items-center" @submit=${this.onSearch}>
            <label class="relative flex-1">
              <i class="${fa('magnifying-glass')} pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"></i>
              <input id="search" type="search" .value=${this.q} placeholder="notmuch query — e.g. from:alice tag:unread date:1w.."
                     class="w-full rounded-lg border border-slate-300 bg-slate-50 py-1.5 pr-3 pl-9 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200 dark:border-slate-600 dark:bg-slate-900 dark:focus:ring-sky-900">
            </label>
          </form>
          <div class="relative">
            <button title=${this.busy ? 'Working — click to see what' : 'Fetch mail (g)'} @click=${this.onSyncButton} aria-expanded=${this.showActivity}
                    class="rounded-lg px-2.5 py-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">
              <i class="${fa('rotate')} ${this.busy ? 'fa-spin' : ''} ${this.sync.ok === false ? 'text-red-500' : ''}"></i>
            </button>
            ${this.showActivity ? this.renderActivity() : ''}
          </div>
          <button title="Accounts" @click=${() => { this.showAccounts = true }}
                  class="rounded-lg px-2.5 py-1.5 text-slate-500 hover:bg-slate-100 md:hidden dark:hover:bg-slate-700">
            <i class="${fa('user-gear')}"></i>
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          <mail-sidebar class="hidden w-56 shrink-0 md:block" .q=${this.q}></mail-sidebar>

          <section class="${narrowThread} min-w-0 flex-1 flex-col border-r border-slate-200 lg:max-w-md lg:flex-none lg:basis-md dark:border-slate-700">
            <mail-thread-list class="min-h-0 flex-1" .results=${this.results} .selected=${this.threadId} .cursor=${this.cursor}
                              .loading=${this.loading} .more=${this.more} .error=${this.error} .q=${this.q}
                              @load-more=${() => this.load(true)}></mail-thread-list>
          </section>

          <main class="${this.threadId ? 'flex' : 'hidden lg:flex'} min-w-0 flex-1 flex-col">
            ${this.threadId
              ? html`<mail-thread-view class="min-h-0 flex-1" .threadId=${this.threadId} .identities=${this.identities}></mail-thread-view>`
              : html`<div class="m-auto text-center text-slate-400">
                  <i class="${fa('inbox')} mb-3 text-5xl"></i>
                  <p>Select a conversation</p>
                  <p class="mt-4 text-xs">j/k move · o open · e archive · r reply · a reply all · c compose · / search</p>
                </div>`}
          </main>
        </div>

        <div class="pointer-events-none fixed right-4 bottom-4 z-40 flex flex-col items-end gap-3">
          ${repeat(this.drafts, d => d.key, ({ key, draft }) => html`
            <mail-compose class="pointer-events-auto" .draft=${draft} .identities=${this.identities}
                          @close=${() => { this.drafts = this.drafts.filter(d => d.key !== key) }}></mail-compose>`)}
        </div>

        ${this.showFilters ? html`<mail-filters .thread=${this.showFilters.thread} @close=${() => { this.showFilters = null }}></mail-filters>` : ''}

        ${this.showAccounts ? html`<mail-accounts @close=${() => { this.showAccounts = false }}></mail-accounts>` : ''}

        ${this.newVersion ? this.renderReload() : ''}

        ${this.toast ? html`
          <div role="status" class="fixed bottom-4 left-4 z-50 rounded-lg bg-slate-800 px-4 py-2 text-sm text-white shadow-lg dark:bg-slate-200 dark:text-slate-900">
            ${this.toast}
          </div>` : ''}
      </div>
    `
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-app': MailApp } }
