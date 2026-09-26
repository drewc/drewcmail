import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import { api } from '../api.ts'
import type { Discovery, ImapAccount, ImapInput, Security, Server } from '../types.ts'

const PORTS = {
  imap: { tls: 993, starttls: 143, none: 143 },
  smtp: { tls: 465, starttls: 587, none: 25 },
} as const
const SECURITY: [Security, string][] = [['tls', 'SSL/TLS'], ['starttls', 'STARTTLS'], ['none', 'None (unencrypted)']]

/**
 * <mail-imap-form>: add or edit an IMAP/SMTP account. For a new one: name, address
 * and password first; the server finds the settings (Thunderbird autoconfig), then
 * checks them against the servers before saving. Emits saved {account}, cancel,
 * use-gmail {email}, use-proton.
 */
@customElement('mail-imap-form')
export class ImapForm extends BaseElement {
  /** the account to edit; none for a new one */
  @property({ attribute: false }) account?: ImapAccount

  @state() private step: 'start' | 'servers' = 'start'
  @state() private name = ''
  @state() private email = ''
  @state() private password = ''
  @state() private smtpPassword = ''
  @state() private samePassword = true
  @state() private imap: Server = { host: '', port: 993, security: 'tls', user: '' }
  @state() private smtp: Server = { host: '', port: 465, security: 'tls', user: '' }
  @state() private found?: Discovery
  @state() private busy = ''
  @state() private error = ''

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('account') && this.account) {
      const a = this.account
      Object.assign(this, { step: 'servers', name: a.name, email: a.email, imap: { ...a.imap }, smtp: { ...a.smtp }, password: '', smtpPassword: '' })
      this.samePassword = a.imap.user === a.smtp.user
    }
  }

  private async discover(e: Event) {
    e.preventDefault()
    this.busy = 'Looking up the servers…'
    this.error = ''
    try {
      const d = await api.imapDiscover(this.email)
      this.found = d
      this.imap = d.imap
      this.smtp = d.smtp
      this.step = 'servers'
    } catch (err) { this.error = (err as Error).message } finally { this.busy = '' }
  }

  private async save(e: Event) {
    e.preventDefault()
    this.busy = 'Checking the IMAP and SMTP servers…'
    this.error = ''
    const input: ImapInput = {
      id: this.account?.id, name: this.name, email: this.email, imap: this.imap, smtp: this.smtp,
      imapPassword: this.password || undefined,
      smtpPassword: (this.samePassword ? this.password : this.smtpPassword) || undefined,
    }
    try {
      const account = await api.imapSave(input)
      this.emit('toast', { text: `${account.email} is set up — fetching mail` })
      this.dispatchEvent(new CustomEvent('saved', { detail: { account } }))
    } catch (err) { this.error = (err as Error).message } finally { this.busy = '' }
  }

  private server(kind: 'imap' | 'smtp') {
    const s = this[kind]
    // from the current value, not `s`: two edits can land before the next render (autofill)
    const set = (patch: Partial<Server>) => { this[kind] = { ...this[kind], ...patch } }
    const setSecurity = (security: Security) => {
      // follow the standard port unless the port was changed by hand
      const port = this[kind].port
      set({ security, port: Object.values(PORTS[kind]).includes(port as never) ? PORTS[kind][security] : port })
    }
    const input = 'w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-sky-500 dark:border-slate-600 dark:bg-slate-900'
    return html`
      <fieldset class="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <legend class="px-1 text-xs font-semibold text-slate-500">${kind === 'imap' ? 'Incoming — IMAP' : 'Outgoing — SMTP'}</legend>
        <div class="grid grid-cols-[1fr_9.5rem] gap-2">
          <label class="text-xs text-slate-500">Server<input required class="${input}" .value=${s.host} @input=${(e: Event) => set({ host: (e.target as HTMLInputElement).value.trim() })}></label>
          <label class="text-xs text-slate-500">Port<input required type="number" min="1" max="65535" class="${input}" .value=${String(s.port)} @input=${(e: Event) => set({ port: Number((e.target as HTMLInputElement).value) })}></label>
          <label class="text-xs text-slate-500">User name<input required class="${input}" .value=${s.user} @input=${(e: Event) => set({ user: (e.target as HTMLInputElement).value })}></label>
          <label class="text-xs text-slate-500">Security
            <select class="${input}" @change=${(e: Event) => setSecurity((e.target as HTMLSelectElement).value as Security)}>
              ${SECURITY.map(([v, label]) => html`<option .value=${v} ?selected=${v === s.security}>${label}</option>`)}
            </select>
          </label>
        </div>
        ${s.security === 'none' ? html`<p class="mt-2 text-xs text-amber-700 dark:text-amber-400"><i class="${fa('triangle-exclamation')}"></i> The password and your mail travel unencrypted — only for a server on this machine or network (e.g. Proton Mail Bridge).</p>` : nothing}
      </fieldset>`
  }

  render() {
    const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200 dark:border-slate-600 dark:bg-slate-900 dark:focus:ring-sky-900'
    const primary = 'flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60'
    const secondary = 'rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
    const editing = !!this.account
    const footer = (label: string) => html`
      ${this.error ? html`<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"><i class="${fa('circle-exclamation')}"></i> ${this.error}</p>` : nothing}
      <div class="flex items-center justify-end gap-2">
        ${this.busy ? html`<span class="mr-auto text-xs text-slate-500"><i class="${fa('spinner')} fa-spin"></i> ${this.busy}</span>` : nothing}
        <button type="button" class="${secondary}" @click=${() => this.dispatchEvent(new CustomEvent('cancel'))}>Cancel</button>
        <button class="${primary}" ?disabled=${!!this.busy}>${label}</button>
      </div>`

    if (this.step === 'start') return html`
      <form class="flex flex-col gap-2" @submit=${this.discover}>
        <input required placeholder="Your name" autocomplete="name" class="${input}" .value=${this.name} @input=${(e: Event) => { this.name = (e.target as HTMLInputElement).value }}>
        <input required type="email" placeholder="you@example.com" autocomplete="email" class="${input}" .value=${this.email} @input=${(e: Event) => { this.email = (e.target as HTMLInputElement).value }}>
        <input required type="password" placeholder="Password" autocomplete="current-password" class="${input}" .value=${this.password} @input=${(e: Event) => { this.password = (e.target as HTMLInputElement).value }}>
        ${footer('Continue')}
      </form>`

    const f = this.found
    return html`
      <form class="flex flex-col gap-3" @submit=${this.save}>
        ${f?.proton ? html`
          <div class="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900 dark:bg-violet-950 dark:text-violet-200">
            <i class="${fa('lock')}"></i> Proton Mail has no IMAP of its own — it goes through <b>Proton Mail Bridge</b>, built in:
            <button type="button" class="ml-1 font-semibold underline" @click=${() => this.emit('use-proton')}>use that instead</button>
          </div>` : nothing}
        ${f?.gmail ? html`
          <div class="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-200">
            <i class="${fa('google', 'brands')}"></i> This is a Google account. <b>Sign in with Google</b> works better (labels, no app password):
            <button type="button" class="ml-1 font-semibold underline" @click=${() => this.emit('use-gmail', { email: this.email })}>use that instead</button>
          </div>` : nothing}
        ${editing
          ? html`<div class="grid grid-cols-2 gap-2">
              <input required placeholder="Your name" class="${input}" .value=${this.name} @input=${(e: Event) => { this.name = (e.target as HTMLInputElement).value }}>
              <input disabled class="${input} opacity-60" .value=${this.email}>
            </div>`
          : html`<p class="text-sm">
              <b>${this.email}</b> — ${f?.source === 'a guess'
                ? html`<span class="text-amber-700 dark:text-amber-400">no settings published for this domain; these are a guess, check them with your provider</span>`
                : html`settings${f?.provider ? html` for <b>${f.provider}</b>` : ''} from ${f?.source}`}
            </p>`}
        ${f?.hint ? html`<p class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"><i class="${fa('key')}"></i> ${f.hint}</p>` : nothing}
        ${this.server('imap')}
        ${this.server('smtp')}
        <div class="flex flex-col gap-2">
          ${editing ? html`<input type="password" placeholder="Password (leave empty to keep it)" autocomplete="current-password" class="${input}" .value=${this.password} @input=${(e: Event) => { this.password = (e.target as HTMLInputElement).value }}>` : nothing}
          <label class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <input type="checkbox" .checked=${this.samePassword} @change=${(e: Event) => { this.samePassword = (e.target as HTMLInputElement).checked }}>
            SMTP uses the same password
          </label>
          ${this.samePassword ? nothing : html`<input type="password" ?required=${!editing} placeholder=${editing ? 'SMTP password (leave empty to keep it)' : 'SMTP password'} class="${input}" .value=${this.smtpPassword} @input=${(e: Event) => { this.smtpPassword = (e.target as HTMLInputElement).value }}>`}
        </div>
        ${footer(editing ? 'Check and save' : 'Check and add')}
      </form>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-imap-form': ImapForm } }
