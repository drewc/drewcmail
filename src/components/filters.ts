import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import { api } from '../api.ts'
import { HIDDEN_TAGS } from '../format.ts'
import type { FilterCriteria, MailFilter } from '../types.ts'

/** what a filter does, as the form's checkboxes; toTags() / fromTags() convert to and from add/remove */
type Actions = { skipInbox: boolean; markRead: boolean; star: boolean; trash: boolean; spam: boolean; labels: string }
const NO_ACTIONS: Actions = { skipInbox: false, markRead: false, star: false, trash: false, spam: false, labels: '' }
const ACTION_TAGS = new Set(['flagged', 'deleted', 'spam'])

/** labels are comma-separated: a label may have spaces (Gmail's do) */
const labelList = (s: string) => s.split(',').map(l => l.trim()).filter(Boolean)

function toTags(a: Actions) {
  const add = [...labelList(a.labels), ...a.star ? ['flagged'] : [], ...a.trash ? ['deleted'] : [], ...a.spam ? ['spam'] : []]
  const remove = [...a.skipInbox || a.trash || a.spam ? ['inbox'] : [], ...a.markRead ? ['unread'] : []]
  return { add, remove }
}

function fromTags(f: MailFilter): Actions {
  const trash = f.add.includes('deleted'), spam = f.add.includes('spam')
  return {
    trash, spam,
    skipInbox: f.remove.includes('inbox') && !trash && !spam,
    markRead: f.remove.includes('unread'),
    star: f.add.includes('flagged'),
    labels: f.add.filter(t => !ACTION_TAGS.has(t)).join(', '),
  }
}

/** a notmuch phrase: quoted, a literal `"` doubled */
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`

function buildQuery(c: FilterCriteria) {
  const parts: string[] = []
  if (c.from?.trim()) parts.push(`from:${quote(c.from.trim())}`)
  if (c.to?.trim()) parts.push(`to:${quote(c.to.trim())}`)
  if (c.subject?.trim()) parts.push(`subject:${quote(c.subject.trim())}`)
  if (c.words?.trim()) parts.push(`(${c.words.trim()})`)
  return parts.join(' and ')
}

const addresses = (header = '') => [...new Set((header.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? []).map(a => a.toLowerCase()))]

const messages = (n: number) => `${n} message${n === 1 ? '' : 's'}`

const summary = (f: MailFilter) => {
  const a = fromTags(f)
  return [
    a.trash && 'Trash', a.spam && 'Spam', a.skipInbox && 'Skip inbox', a.markRead && 'Mark read', a.star && 'Star',
    ...labelList(a.labels).map(l => `Label ${l}`),
  ].filter(Boolean).join(' · ')
}

/**
 * <mail-filters>: the filters dialog — a list of filters, and a form to add or edit
 * one: criteria (from, to, subject, words — or a notmuch query) and what to do with
 * matching mail (skip the inbox, mark read, star, label, trash, spam). The server
 * runs them on new mail with afew; "Apply once" tags the mail matching now without
 * saving a filter, and "Run now" does that for a saved one. With `thread` set it opens straight on a new
 * filter filled in from that conversation's first message. Emits `close`.
 */
@customElement('mail-filters')
export class Filters extends BaseElement {
  /** start with a new filter for mail like this thread */
  @property() thread?: string

  @state() private filters: MailFilter[] = []
  @state() private allTags: string[] = []
  /** the form: closed (the list), or the filter being made/edited */
  @state() private editing: null | { id?: string } = null
  @state() private name = ''
  @state() private criteria: FilterCriteria = {}
  @state() private query = ''
  @state() private actions: Actions = NO_ACTIONS
  @state() private apply = false
  @state() private suggestions: { kind: 'from' | 'to'; address: string }[] = []
  @state() private matchCount: number | null = null
  @state() private queryError = ''
  @state() private busy = false
  @state() private error = ''
  private countTimer?: number
  private countSeq = 0

  connectedCallback() {
    super.connectedCallback()
    this.load()
    api.tags().then(t => { this.allTags = t.filter(x => !HIDDEN_TAGS.has(x) && !ACTION_TAGS.has(x)) }).catch(() => {})
    if (this.thread) this.fromThread(this.thread)
  }

  disconnectedCallback() {
    clearTimeout(this.countTimer)
    super.disconnectedCallback()
  }

  private async load() {
    try { this.filters = await api.filters() } catch (e) { this.error = (e as Error).message }
  }

  private edit(f?: MailFilter) {
    this.editing = { id: f?.id }
    this.name = f?.name ?? ''
    this.criteria = f?.criteria ?? {}
    this.actions = f ? fromTags(f) : NO_ACTIONS
    this.apply = false
    this.suggestions = []
    this.error = ''
    this.setQuery(f?.query ?? '')
  }

  /** a new filter for mail from this thread's sender, suggesting its other addresses */
  private async fromThread(id: string) {
    this.edit()
    try {
      const [[root]] = await api.thread(id)
      const m = root?.[0]
      if (!m) return
      const from = addresses(m.headers.From)
      const to = addresses([m.headers.To, m.headers.Cc].filter(Boolean).join(', '))
      this.suggestions = [...from.map(address => ({ kind: 'from' as const, address })), ...to.map(address => ({ kind: 'to' as const, address }))]
      if (from[0]) this.setCriteria({ from: from[0] })
    } catch (e) { this.error = (e as Error).message }
  }

  private setCriteria(patch: FilterCriteria) {
    this.criteria = { ...this.criteria, ...patch }
    this.setQuery(buildQuery(this.criteria))
  }

  private setActions(patch: Partial<Actions>) { this.actions = { ...this.actions, ...patch } }

  /** the query changed: count what it matches (debounced) */
  private setQuery(q: string) {
    this.query = q
    clearTimeout(this.countTimer)
    this.matchCount = null
    this.queryError = ''
    if (!q.trim()) return
    const seq = ++this.countSeq
    this.countTimer = window.setTimeout(async () => {
      try {
        const key = `(${q})`
        const counts = await api.count([key])
        if (seq === this.countSeq) this.matchCount = counts[key]
      } catch (e) { if (seq === this.countSeq) this.queryError = (e as Error).message }
    }, 300)
  }

  /** the filter as the form has it */
  private formFilter() {
    return { name: this.name.trim(), query: this.query.trim(), ...toTags(this.actions), criteria: this.criteria }
  }

  private async save(e: Event) {
    e.preventDefault()
    if (!this.editing) return
    await this.submit(async () => {
      const { applied } = await api.filterSave({ id: this.editing?.id, ...this.formFilter() }, this.apply)
      return applied ? `Filter saved — applied to ${messages(applied)}` : 'Filter saved — it runs on new mail'
    })
  }

  /** tag what matches now and keep no filter */
  private applyOnce() {
    return this.submit(async () => `Applied once to ${messages((await api.filterApply(this.formFilter())).applied)} — no filter saved`)
  }

  /** run a saved filter over the mail there now */
  private async runNow(f: MailFilter) {
    try {
      const { applied } = await api.filterApply(f)
      this.emit('toast', { text: `${f.name || 'Filter'}: applied to ${messages(applied)}` })
      if (applied) this.emit('changed')
    } catch (e) { this.error = (e as Error).message }
  }

  /** save or apply the form, then say so, refresh, and leave the form */
  private async submit(act: () => Promise<string>) {
    this.busy = true
    this.error = ''
    try {
      this.emit('toast', { text: await act() })
      this.emit('changed')
      if (this.thread) { this.close(); return }
      this.editing = null
      await this.load()
    } catch (err) {
      this.error = (err as Error).message
    } finally {
      this.busy = false
    }
  }

  private async drop(f: MailFilter) {
    if (!confirm(`Delete the filter ${f.name || f.query}? Mail it already tagged keeps its tags.`)) return
    try {
      await api.filterRemove(f.id)
      await this.load()
    } catch (e) { this.error = (e as Error).message }
  }

  private close() { this.dispatchEvent(new CustomEvent('close')) }

  private renderList() {
    const btn = 'rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
    return html`
      <div class="px-5 py-3">
        ${this.filters.length
          ? html`<ul class="divide-y divide-slate-100 dark:divide-slate-700">${this.filters.map(f => html`
              <li class="flex items-center gap-3 py-2.5">
                <i class="${fa('filter')} text-slate-400"></i>
                <div class="min-w-0 flex-1">
                  ${f.name ? html`<div class="truncate font-medium">${f.name}</div>` : nothing}
                  <code class="block truncate text-xs text-slate-600 dark:text-slate-400" title=${f.query}>${f.query}</code>
                  <div class="text-xs text-slate-500">${summary(f)}</div>
                </div>
                <button class="${btn}" title="Show the mail it matches" @click=${() => { this.emit('search', { q: f.query }); this.close() }}>Search</button>
                <button class="${btn}" title="Apply it to the mail that matches now" @click=${() => this.runNow(f)}>Run now</button>
                <button class="${btn}" @click=${() => this.edit(f)}>Edit</button>
                <button class="${btn}" @click=${() => this.drop(f)}>Delete</button>
              </li>`)}</ul>`
          : html`<p class="py-2 text-sm text-slate-500">
              No filters yet. Right-click a conversation and choose <b>Filter messages like this</b>, or make one here.
            </p>`}
        <button class="mt-3 rounded-lg border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700" @click=${() => this.edit()}>
          <i class="${fa('plus')}"></i> New filter
        </button>
      </div>`
  }

  private renderForm() {
    const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200 dark:border-slate-600 dark:bg-slate-900 dark:focus:ring-sky-900'
    const label = 'grid grid-cols-[5.5rem_1fr] items-center gap-2 text-sm'
    const check = (key: keyof Actions, text: unknown, icon: string, disabled = false) => html`
      <label class="flex items-center gap-2 text-sm ${disabled ? 'opacity-50' : ''}">
        <input type="checkbox" .checked=${this.actions[key] as boolean} ?disabled=${disabled}
               @change=${(e: Event) => this.setActions({ [key]: (e.target as HTMLInputElement).checked })}>
        <i class="${fa(icon)} w-4 text-center text-slate-400"></i> ${text}
      </label>`
    const a = this.actions
    const { add, remove } = toTags(a)
    const matching = this.matchCount == null ? '' : `${this.matchCount} conversation${this.matchCount === 1 ? '' : 's'}`
    const ready = !this.busy && !!this.query.trim() && !this.queryError && (add.length > 0 || remove.length > 0)
    return html`
      <form class="space-y-4 px-5 py-4" @submit=${this.save}>
        <fieldset class="space-y-2">
          <legend class="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Mail that matches</legend>
          ${(['from', 'to', 'subject'] as const).map(k => html`
            <label class=${label}><span class="capitalize">${k}</span>
              <input class=${input} .value=${this.criteria[k] ?? ''} @input=${(e: Event) => this.setCriteria({ [k]: (e.target as HTMLInputElement).value })}>
            </label>`)}
          <label class=${label}><span>Has words</span>
            <input class=${input} placeholder="notmuch terms, e.g. tag:unread -from:me" .value=${this.criteria.words ?? ''}
                   @input=${(e: Event) => this.setCriteria({ words: (e.target as HTMLInputElement).value })}>
          </label>
          ${this.suggestions.length ? html`
            <div class="flex flex-wrap gap-1.5 pl-24">
              ${this.suggestions.map(s => html`
                <button type="button" class="rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                        title="Filter on this address" @click=${() => this.setCriteria({ from: '', to: '', [s.kind]: s.address })}>${s.kind}: ${s.address}</button>`)}
            </div>` : nothing}
          <label class=${label}><span>Query</span>
            <input class="${input} font-mono text-xs" required .value=${this.query} @input=${(e: Event) => this.setQuery((e.target as HTMLInputElement).value)}>
          </label>
          <p class="pl-24 text-xs ${this.queryError ? 'text-red-600' : 'text-slate-500'}">
            ${this.queryError || (matching ? html`Matches ${matching} now.
              <button type="button" class="underline" @click=${() => { this.emit('search', { q: this.query }); this.close() }}>Show them</button>` : html`&nbsp;`)}
          </p>
        </fieldset>

        <fieldset class="space-y-1.5">
          <legend class="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Do this</legend>
          ${check('skipInbox', 'Skip the inbox (archive it)', 'box-archive', a.trash || a.spam)}
          ${check('markRead', 'Mark as read', 'envelope-open')}
          ${check('star', 'Star it', 'star')}
          <label class="flex items-center gap-2 text-sm">
            <span class="w-4"></span><i class="${fa('tag')} w-4 text-center text-slate-400"></i> Apply the label
            <input class="${input} flex-1" list="all-tags" placeholder="e.g. lists/clojure, Maxwell Claims" .value=${a.labels}
                   @input=${(e: Event) => this.setActions({ labels: (e.target as HTMLInputElement).value })}>
            <datalist id="all-tags">${this.allTags.map(t => html`<option value=${t}></option>`)}</datalist>
          </label>
          <p class="pl-12 text-xs text-slate-500">To <b>move</b> mail into a label, apply the label and skip the inbox.</p>
          ${check('trash', 'Delete it (move to Trash)', 'trash')}
          ${check('spam', 'Mark as spam', 'ban')}
          <p class="pt-1 text-xs text-slate-500">Tags: <code>${[...add.map(t => `+${t}`), ...remove.map(t => `-${t}`)].join(' ') || '—'}</code></p>
        </fieldset>

        <div class="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
          <label class=${label}><span>Name</span>
            <input class=${input} placeholder="optional" .value=${this.name} @input=${(e: Event) => { this.name = (e.target as HTMLInputElement).value }}>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" .checked=${this.apply} @change=${(e: Event) => { this.apply = (e.target as HTMLInputElement).checked }}>
            Also apply to the ${matching || 'conversations'} already matching
          </label>
          <p class="text-xs text-slate-500">New mail is filtered by <a class="underline" href="https://afew.readthedocs.io/" target="_blank" rel="noopener">afew</a> each time mail is fetched.</p>
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" class="rounded-lg px-4 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700"
                  @click=${() => { if (this.thread) this.close(); else this.editing = null }}>Cancel</button>
          <button type="button" class="rounded-lg border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700"
                  title="Tag the ${matching || 'mail'} matching now, and save no filter — new mail is left alone"
                  ?disabled=${!ready} @click=${this.applyOnce}>Apply once</button>
          <button class="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
                  ?disabled=${!ready}>
            ${this.busy ? html`<i class="${fa('spinner')} fa-spin"></i>` : nothing} ${this.editing?.id ? 'Save filter' : 'Create filter'}
          </button>
        </div>
      </form>`
  }

  render() {
    return html`
      <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:pt-16" @click=${(e: Event) => { if (e.target === e.currentTarget) this.close() }}
           @keydown=${(e: KeyboardEvent) => { if (e.key === 'Escape') this.close() }}>
        <section class="w-full max-w-lg rounded-xl bg-white shadow-2xl dark:bg-slate-800" role="dialog" aria-label="Filters">
          <header class="flex items-center border-b border-slate-200 px-5 py-3 dark:border-slate-700">
            <h2 class="flex-1 font-semibold">${this.editing ? (this.editing.id ? 'Edit filter' : 'New filter') : 'Filters'}</h2>
            <button class="text-slate-400 hover:text-slate-600" title="Close" @click=${this.close}><i class="${fa('xmark')}"></i></button>
          </header>
          ${this.editing ? this.renderForm() : this.renderList()}
          ${this.error ? html`<p class="mx-5 mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">${this.error}</p>` : nothing}
        </section>
      </div>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-filters': Filters } }
