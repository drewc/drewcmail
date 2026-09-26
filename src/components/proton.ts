import { html, nothing } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import { api } from '../api.ts'
import { humanSize } from '../format.ts'
import type { BridgeSettings, ProtonStatus, ProtonStep, ProtonUser } from '../types.ts'

/**
 * <mail-proton>: the built-in Proton Mail Bridge, in the Accounts dialog — turn it on
 * or off, sign in (password, then 2FA code / mailbox password / human verification
 * as Proton asks), per-account split mode and removal, and Bridge's IMAP/SMTP ports
 * and security. Each Proton account then syncs like any IMAP account.
 */
@customElement('mail-proton')
export class Proton extends BaseElement {
  @state() private status?: ProtonStatus
  @state() private busy = ''
  @state() private error = ''
  /** the sign-in in progress: null = not signing in */
  @state() private step: null | 'start' | '2fa' | 'mailbox' | 'hv' = null
  @state() private hvUrl = ''
  @state() private username = ''
  @state() private password = ''
  @state() private secret = ''
  @state() private settings?: BridgeSettings
  private timer?: number

  connectedCallback() {
    super.connectedCallback()
    this.load()
    this.timer = window.setInterval(() => { if (!this.busy) this.load() }, 3000)
  }

  disconnectedCallback() {
    clearInterval(this.timer)
    if (this.step && this.step !== 'start') api.protonLogin({ abort: true }).catch(() => {})
    super.disconnectedCallback()
  }

  private async load() {
    try {
      this.status = await api.proton()
      if (!this.settings && this.status.settings) this.settings = { ...this.status.settings }
    } catch (e) { this.error = (e as Error).message }
  }

  private async act(label: string, fn: () => Promise<unknown>) {
    this.busy = label
    this.error = ''
    try { await fn() } catch (e) { this.error = (e as Error).message } finally { this.busy = '' }
    await this.load()
  }

  private toggle(on: boolean) {
    return this.act(on ? 'Starting Bridge…' : 'Stopping Bridge…', async () => {
      this.status = await api.protonEnable(on)
      this.settings = this.status.settings && { ...this.status.settings }
    })
  }

  /** each answer from the server says what Proton wants next */
  private next(r: ProtonStep) {
    this.secret = ''
    if (r.step === 'done') {
      this.emit('toast', { text: `Signed in to ${r.username} — Bridge is downloading your mail` })
      this.emit('sync-started')
      Object.assign(this, { step: null, username: '', password: '' })
    } else if (r.step === 'hv') {
      this.step = 'hv'
      this.hvUrl = r.url
    } else if (r.step === '2fa' || r.step === 'mailbox') {
      this.step = r.step
      if (r.error) this.error = r.error
    } else {
      this.step = null
    }
  }

  private submit(e: Event) {
    e.preventDefault()
    const body = this.step === '2fa' ? { code: this.secret }
      : this.step === 'mailbox' ? { mailboxPassword: this.secret }
      : this.step === 'hv' ? { verified: true }
      : { username: this.username, password: this.password }
    return this.act('Talking to Proton…', async () => {
      try { this.next(await api.protonLogin(body)) } catch (err) {
        // a failed step ends the sign-in on Bridge's side: start over
        if (this.step !== 'start') { this.step = 'start'; this.password = '' }
        throw err
      }
    })
  }

  private cancel() {
    if (this.step !== 'start') api.protonLogin({ abort: true }).catch(() => {})
    Object.assign(this, { step: null, secret: '', password: '', error: '' })
  }

  private saveSettings(e: Event) {
    e.preventDefault()
    const s = this.settings!
    return this.act('Changing Bridge settings…', async () => {
      this.settings = await api.protonSettings(s)
      this.emit('toast', { text: 'Bridge settings changed; the Proton accounts follow' })
    })
  }

  private removeUser(u: ProtonUser) {
    if (!confirm(`Sign ${u.username} out of Bridge and remove the account here? Its mail stays.`)) return
    return this.act('Removing…', () => api.protonRemove(u.id))
  }

  private renderUser(u: ProtonUser) {
    const syncing = u.syncProgress !== undefined
    const btn = 'rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
    return html`
      <li class="py-2.5">
        <div class="flex items-center gap-3">
          <i class="${fa('lock')} text-lg text-violet-500"></i>
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium">${u.username}</div>
            <div class="text-xs">
              ${u.state !== 'CONNECTED'
                ? html`<span class="text-amber-600"><i class="${fa('circle-exclamation')}"></i> ${u.state === 'LOCKED' ? 'locked — Bridge is still loading it' : 'signed out — sign in again below'}</span>`
                : syncing
                  ? html`<span class="text-sky-600"><i class="${fa('rotate')} fa-spin"></i> Bridge is downloading · ${Math.round(u.syncProgress! * 100)}%</span>`
                  : html`<span class="text-emerald-600"><i class="${fa('circle-check')}"></i> connected</span>`}
              ${u.totalBytes ? html`<span class="text-slate-400"> · ${humanSize(u.usedBytes)} of ${humanSize(u.totalBytes)}</span>` : nothing}
            </div>
          </div>
          <button class="${btn}" @click=${() => this.removeUser(u)}>Remove</button>
        </div>
        ${syncing ? html`<div class="mt-1.5 ml-8 h-1 overflow-hidden rounded bg-slate-200 dark:bg-slate-700"><div class="h-full bg-sky-500" style="width:${u.syncProgress! * 100}%"></div></div>` : nothing}
        <div class="mt-1.5 ml-8 text-xs text-slate-500">
          ${u.addresses.join(' · ')}
          ${u.addresses.length > 1 ? html`
            <label class="mt-1 flex items-center gap-2">
              <input type="checkbox" .checked=${u.splitMode} ?disabled=${!!this.busy}
                     @change=${(e: Event) => this.act('Switching mode…', () => api.protonSplit(u.id, (e.target as HTMLInputElement).checked))}>
              Split mode — a separate account (and From address) per address, instead of one for all
            </label>` : nothing}
        </div>
      </li>`
  }

  private renderLogin() {
    const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-200 dark:border-slate-600 dark:bg-slate-900 dark:focus:ring-violet-900'
    const primary = 'flex shrink-0 items-center gap-2 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60'
    const setSecret = (e: Event) => { this.secret = (e.target as HTMLInputElement).value }
    const fields = {
      start: html`
        <input required placeholder="Proton username or address" autocomplete="username" class="${input}" .value=${this.username} @input=${(e: Event) => { this.username = (e.target as HTMLInputElement).value }}>
        <input required type="password" placeholder="Proton password" autocomplete="current-password" class="${input}" .value=${this.password} @input=${(e: Event) => { this.password = (e.target as HTMLInputElement).value }}>`,
      '2fa': html`
        <p class="text-sm">Enter the code from your authenticator app.</p>
        <input required autofocus inputmode="numeric" autocomplete="one-time-code" placeholder="123456" class="${input} font-mono tracking-widest" .value=${this.secret} @input=${setSecret}>`,
      mailbox: html`
        <p class="text-sm">Your account uses a second password to unlock the mailbox.</p>
        <input required autofocus type="password" placeholder="Mailbox password" class="${input}" .value=${this.secret} @input=${setSecret}>`,
      hv: html`
        <p class="text-sm">Proton wants to make sure you are human. Complete the check, then come back and continue.</p>
        <a href=${this.hvUrl} target="_blank" rel="noopener" class="w-fit rounded-lg border border-violet-300 px-3 py-1.5 text-sm text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950">
          <i class="${fa('arrow-up-right-from-square')}"></i> Open the verification</a>`,
    }
    return html`
      <form class="flex flex-col gap-2" @submit=${this.submit}>
        ${fields[this.step!]}
        <div class="flex items-center justify-end gap-2">
          ${this.busy ? html`<span class="mr-auto text-xs text-slate-500"><i class="${fa('spinner')} fa-spin"></i> ${this.busy}</span>` : nothing}
          <button type="button" class="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700" @click=${this.cancel}>Cancel</button>
          <button class="${primary}" ?disabled=${!!this.busy}>${this.step === 'start' ? 'Sign in' : this.step === 'hv' ? 'I have done it — continue' : 'Continue'}</button>
        </div>
      </form>`
  }

  private renderSettings() {
    const s = this.settings
    if (!s) return nothing
    const input = 'w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-violet-500 dark:border-slate-600 dark:bg-slate-900'
    const set = (patch: Partial<BridgeSettings>) => { this.settings = { ...this.settings!, ...patch } }
    const row = (label: string, port: keyof BridgeSettings, ssl: keyof BridgeSettings) => html`
      <label class="text-xs text-slate-500">${label} port
        <input type="number" min="1024" max="65535" class="${input}" .value=${String(s[port])} @input=${(e: Event) => set({ [port]: Number((e.target as HTMLInputElement).value) })}></label>
      <label class="text-xs text-slate-500">Security
        <select class="${input}" @change=${(e: Event) => set({ [ssl]: (e.target as HTMLSelectElement).value === 'ssl' })}>
          <option value="starttls" ?selected=${!s[ssl]}>STARTTLS</option>
          <option value="ssl" ?selected=${!!s[ssl]}>SSL/TLS</option>
        </select></label>`
    return html`
      <details class="mt-3 text-xs text-slate-500">
        <summary class="cursor-pointer select-none">Bridge settings${this.status?.version ? ` · v${this.status.version}` : ''}</summary>
        <form class="mt-2 grid grid-cols-2 gap-2" @submit=${this.saveSettings}>
          ${row('IMAP', 'imapPort', 'useSSLForImap')}
          ${row('SMTP', 'smtpPort', 'useSSLForSmtp')}
          <p class="col-span-2">Bridge listens inside the container only; the mail between it and this app is encrypted with its own certificate either way.</p>
          <div class="col-span-2 flex justify-end">
            <button class="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700" ?disabled=${!!this.busy}>Apply</button>
          </div>
        </form>
      </details>`
  }

  render() {
    const st = this.status
    if (!st?.available) return nothing
    return html`
      <section class="border-t border-slate-200 px-5 py-4 dark:border-slate-700">
        <div class="mb-1 flex items-center gap-2">
          <h3 class="flex-1 font-medium"><i class="${fa('lock')} text-violet-500"></i> Proton Mail</h3>
          <label class="flex cursor-pointer items-center gap-2 text-xs text-slate-500">
            ${st.starting ? 'starting…' : st.running ? 'Bridge on' : 'Bridge off'}
            <input type="checkbox" class="peer sr-only" .checked=${st.enabled} ?disabled=${!!this.busy} @change=${(e: Event) => this.toggle((e.target as HTMLInputElement).checked)}>
            <span class="relative h-5 w-9 rounded-full bg-slate-300 transition peer-checked:bg-violet-600 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4 dark:bg-slate-600"></span>
          </label>
        </div>
        <p class="mb-3 text-xs text-slate-500">
          Through the built-in <a class="underline" href="https://proton.me/mail/bridge" target="_blank" rel="noopener">Proton Mail Bridge</a>,
          which decrypts your mail here, in the container (a paid Proton plan is needed). Bridge keeps its own copy of the mailbox in <code>/mail/.proton-bridge</code>.
        </p>

        ${st.enabled && st.error ? html`<p class="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"><i class="${fa('triangle-exclamation')}"></i> ${st.error}
          ${st.log.length ? html`<pre class="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">${st.log.join('\n')}</pre>` : nothing}</p>` : nothing}

        ${st.running ? html`
          ${st.users.length ? html`<ul class="divide-y divide-slate-100 dark:divide-slate-700">${st.users.map(u => this.renderUser(u))}</ul>` : nothing}
          <div class="mt-2">
            ${this.step
              ? this.renderLogin()
              : html`<button class="rounded-lg border border-violet-300 px-4 py-1.5 text-sm text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950" @click=${() => { this.step = 'start' }}>
                  <i class="${fa('right-to-bracket')}"></i> Sign in to Proton</button>`}
          </div>
          ${this.renderSettings()}` : nothing}

        ${this.busy && !this.step ? html`<p class="mt-2 text-xs text-slate-500"><i class="${fa('spinner')} fa-spin"></i> ${this.busy}</p>` : nothing}
        ${this.error ? html`<p class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"><i class="${fa('circle-exclamation')}"></i> ${this.error}</p>` : nothing}
      </section>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-proton': Proton } }
