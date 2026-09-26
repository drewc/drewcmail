import { html, nothing } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import { api } from '../api.ts'
import { shortDate } from '../format.ts'
import type { GmailAccount, ImapAccount } from '../types.ts'
import './imap-form.ts'
import './proton.ts'
import './identities.ts'

/** Google only sends the browser back to a loopback address for desktop OAuth clients */
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
/** where Google sends the browser back to: the app itself, which finishes the sign-in (see app.ts) */
export const oauthRedirect = () => LOOPBACK ? `${location.origin}/` : 'http://localhost/'

/**
 * <mail-accounts>: a dialog to add mail accounts — Gmail (lieer, Sign in with Google),
 * Proton (the built-in Proton Mail Bridge, <mail-proton>) or any IMAP/SMTP provider
 * (mbsync + msmtp, configured by the server) — and see how their sync is doing.
 * Emits `close`.
 */
@customElement('mail-accounts')
export class Accounts extends BaseElement {
  @state() private accounts: GmailAccount[] = []
  @state() private imapAccounts: ImapAccount[] = []
  /** the IMAP form: closed, a new account, or the account being edited */
  @state() private imapForm: null | 'new' | ImapAccount = null
  @state() private email = ''
  @state() private client = ''
  @state() private pasted = ''
  @state() private busy = false
  @state() private error = ''
  @state() private waiting = false
  private timer?: number

  connectedCallback() {
    super.connectedCallback()
    this.load()
    this.timer = window.setInterval(() => this.load(), 3000)
  }

  disconnectedCallback() {
    clearInterval(this.timer)
    super.disconnectedCallback()
  }

  private async load() {
    try {
      ;[this.accounts, this.imapAccounts] = await Promise.all([api.gmailAccounts(), api.imapAccounts()])
    } catch (e) { this.error = (e as Error).message }
  }

  private async connect(e: Event) {
    e.preventDefault()
    this.busy = true
    this.error = ''
    try {
      const { url } = await api.gmailStart(this.email.trim(), oauthRedirect(), this.client || undefined)
      if (LOOPBACK) { location.href = url; return }
      // Google cannot come back here: open it alongside and have the user paste the address it ends on
      window.open(url, '_blank', 'noopener')
      this.waiting = true
    } catch (err) {
      this.error = (err as Error).message
    } finally {
      this.busy = false
    }
  }

  private async finish(e: Event) {
    e.preventDefault()
    this.busy = true
    this.error = ''
    try {
      const { email } = await api.gmailFinish(this.pasted)
      this.pasted = ''
      this.waiting = false
      this.email = ''
      this.emit('toast', { text: `Connected ${email} — the first download can take a while` })
      await this.load()
    } catch (err) {
      this.error = (err as Error).message
    } finally {
      this.busy = false
    }
  }

  private async disconnect(a: GmailAccount) {
    if (!confirm(`Stop syncing ${a.email}? Its mail stays here; connect it again to resume.`)) return
    try { await api.gmailDisconnect(a.email); await this.load() } catch (e) { this.error = (e as Error).message }
  }

  private async removeImap(a: ImapAccount) {
    if (!confirm(`Remove ${a.email}? Its mail stays here; add it again to resume.`)) return
    try { await api.imapRemove(a.id); await this.load() } catch (e) { this.error = (e as Error).message }
  }

  private status(a: { syncing: boolean; ok?: boolean; last?: string }, fallback = 'added') {
    return a.syncing
      ? html`<span class="text-sky-600"><i class="${fa('rotate')} fa-spin"></i> syncing…</span>`
      : a.ok === false
        ? html`<span class="text-red-600"><i class="${fa('triangle-exclamation')}"></i> sync failed</span>`
        : html`<span class="text-emerald-600"><i class="${fa('circle-check')}"></i> ${a.last ? `synced ${shortDate(Date.parse(a.last) / 1000)}` : fallback}</span>`
  }

  private renderImap(a: ImapAccount) {
    const btn = 'rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
    return html`
      <li class="flex items-center gap-3 py-2.5">
        <i class="${a.proton ? fa('lock') : fa('envelope')} text-lg ${a.proton ? 'text-violet-500' : 'text-slate-400'}"></i>
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium">${a.email}</div>
          <div class="text-xs">${this.status(a)} <span class="text-slate-400">· ${a.proton ? 'via Proton Mail Bridge' : a.imap.host}</span></div>
          ${a.ok === false && a.error ? html`<pre class="mt-1 max-h-24 overflow-auto rounded bg-red-50 p-1.5 text-[11px] whitespace-pre-wrap text-red-700 dark:bg-red-950 dark:text-red-300">${a.error}</pre>` : nothing}
        </div>
        ${a.proton ? nothing : html`
          <button class="${btn}" @click=${() => { this.imapForm = a }}>Edit</button>
          <button class="${btn}" @click=${() => this.removeImap(a)}>Remove</button>`}
      </li>`
  }

  /** an account added its address: show it under Send as, and in compose */
  private refreshIdentities() {
    this.renderRoot.querySelector('mail-identities')?.reload()
    this.emit('identities-changed')
  }

  private close() { this.dispatchEvent(new CustomEvent('close')) }

  private renderAccount(a: GmailAccount) {
    const state = !a.authorized
      ? html`<span class="text-amber-600"><i class="${fa('circle-exclamation')}"></i> not signed in</span>`
      : this.status(a, 'connected')
    return html`
      <li class="flex items-center gap-3 py-2.5">
        <i class="${fa('google', 'brands')} text-lg text-slate-400"></i>
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium">${a.email}</div>
          <div class="text-xs">${state}</div>
          ${a.ok === false && a.error ? html`<pre class="mt-1 max-h-24 overflow-auto rounded bg-red-50 p-1.5 text-[11px] whitespace-pre-wrap text-red-700 dark:bg-red-950 dark:text-red-300">${a.error}</pre>` : nothing}
        </div>
        ${!a.authorized || a.ok === false
          ? html`<button class="rounded-md px-2 py-1 text-xs text-sky-700 hover:bg-slate-100 dark:text-sky-400 dark:hover:bg-slate-700" @click=${() => { this.email = a.email }}>Sign in${a.authorized ? ' again' : ''}</button>`
          : nothing}
        ${a.authorized
          ? html`<button class="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" @click=${() => this.disconnect(a)}>Disconnect</button>`
          : nothing}
      </li>`
  }

  render() {
    const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200 dark:border-slate-600 dark:bg-slate-900 dark:focus:ring-sky-900'
    return html`
      <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:pt-16" @click=${(e: Event) => { if (e.target === e.currentTarget) this.close() }}
           @keydown=${(e: KeyboardEvent) => { if (e.key === 'Escape') this.close() }}>
        <section class="w-full max-w-lg rounded-xl bg-white shadow-2xl dark:bg-slate-800" role="dialog" aria-label="Accounts">
          <header class="flex items-center border-b border-slate-200 px-5 py-3 dark:border-slate-700">
            <h2 class="flex-1 font-semibold">Accounts</h2>
            <button class="text-slate-400 hover:text-slate-600" title="Close" @click=${this.close}><i class="${fa('xmark')}"></i></button>
          </header>

          <div class="px-5 py-3">
            ${this.accounts.length || this.imapAccounts.length
              ? html`<ul class="divide-y divide-slate-100 dark:divide-slate-700">
                  ${this.accounts.map(a => this.renderAccount(a))}
                  ${this.imapAccounts.map(a => this.renderImap(a))}
                </ul>`
              : html`<p class="py-2 text-sm text-slate-500">No accounts yet — add Gmail, or any other provider below.</p>`}
          </div>

          <form class="border-t border-slate-200 px-5 py-4 dark:border-slate-700" @submit=${this.connect}>
            <h3 class="mb-1 font-medium"><i class="${fa('google', 'brands')}"></i> Add Gmail or Google Workspace</h3>
            <p class="mb-3 text-xs text-slate-500">
              Synced with <a class="underline" href="https://lieer.gaute.vetsj.com/" target="_blank" rel="noopener">lieer</a>
              through the Gmail API: labels become tags and tag changes go back to Gmail. No app password or IMAP needed —
              you sign in with Google and allow access to your mail.
            </p>
            <div class="flex gap-2">
              <input type="email" required placeholder="you@gmail.com" class="${input}" .value=${this.email} @input=${(e: Event) => { this.email = (e.target as HTMLInputElement).value }}>
              <button class="flex shrink-0 items-center gap-2 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60" ?disabled=${this.busy}>
                ${this.busy ? html`<i class="${fa('spinner')} fa-spin"></i>` : html`<i class="${fa('right-to-bracket')}"></i>`} Sign in with Google
              </button>
            </div>
            <details class="mt-3 text-xs text-slate-500">
              <summary class="cursor-pointer select-none">Use my own Google OAuth client</summary>
              <p class="my-2">
                lieer's shared client works for most people; if Google refuses it or you hit its quota, create your own:
                Google Cloud console → enable the Gmail API → Credentials → OAuth client ID → <b>Desktop app</b> → download the JSON and paste it here.
              </p>
              <textarea class="${input} h-20 font-mono text-[11px]" placeholder='{"installed":{"client_id":"…","client_secret":"…"}}'
                        .value=${this.client} @input=${(e: Event) => { this.client = (e.target as HTMLTextAreaElement).value }}></textarea>
            </details>
          </form>

          ${this.waiting || !LOOPBACK ? html`
            <form class="border-t border-slate-200 px-5 py-4 dark:border-slate-700" @submit=${this.finish}>
              <p class="mb-2 text-xs text-slate-500">
                ${LOOPBACK ? 'Google did not bring you back here?' : html`You are not on <code>localhost</code>, so Google cannot bring you back here.`}
                After you allow access, Google sends you to a <code>http://localhost…</code> page that will not load —
                copy its whole address from the address bar and paste it here.
              </p>
              <div class="flex gap-2">
                <input required placeholder="http://localhost/?state=…&code=…" class="${input} font-mono text-xs" .value=${this.pasted} @input=${(e: Event) => { this.pasted = (e.target as HTMLInputElement).value }}>
                <button class="shrink-0 rounded-lg border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700" ?disabled=${this.busy}>Finish</button>
              </div>
            </form>` : nothing}

          <mail-proton></mail-proton>

          <section class="border-t border-slate-200 px-5 py-4 dark:border-slate-700">
            <h3 class="mb-1 font-medium"><i class="${fa('envelope')}"></i> ${this.imapForm && this.imapForm !== 'new' ? `Edit ${this.imapForm.email}` : 'Add another provider (IMAP/SMTP)'}</h3>
            ${this.imapForm
              ? html`<p class="mb-3 text-xs text-slate-500">The settings are checked against the servers before they are saved.</p>
                <mail-imap-form .account=${this.imapForm === 'new' ? undefined : this.imapForm}
                  @saved=${() => { this.imapForm = null; this.load(); this.emit('sync-started'); this.refreshIdentities() }}
                  @cancel=${() => { this.imapForm = null }}
                  @use-proton=${(e: Event) => { e.stopPropagation(); this.imapForm = null; this.renderRoot.querySelector('mail-proton')?.scrollIntoView({ behavior: 'smooth' }) }}
                  @use-gmail=${(e: CustomEvent<{ email: string }>) => { e.stopPropagation(); this.imapForm = null; this.email = e.detail.email; this.renderRoot.querySelector<HTMLInputElement>('input[type=email]')?.focus() }}></mail-imap-form>`
              : html`<p class="mb-3 text-xs text-slate-500">Fastmail, iCloud, Yahoo, your own domain… Enter your address and password; the server settings are found for you.</p>
                <button class="rounded-lg border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700" @click=${() => { this.imapForm = 'new' }}>
                  <i class="${fa('plus')}"></i> Add account
                </button>`}
          </section>

          <mail-identities></mail-identities>

          ${this.error ? html`<p class="mx-5 mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">${this.error}</p>` : nothing}
        </section>
      </div>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-accounts': Accounts } }
