import { html, nothing } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import { api } from '../api.ts'
import { formatAddress } from '../format.ts'
import type { Identity } from '../types.ts'

/**
 * <mail-identities>: the "Send as" section of the Accounts dialog — every From address
 * with the name it sends with, which one is the default, adding an alias and removing
 * an address. Saved together; emits `identities-changed`.
 */
@customElement('mail-identities')
export class Identities extends BaseElement {
  @state() private list: Identity[] = []
  @state() private dirty = false
  @state() private email = ''
  @state() private name = ''
  @state() private busy = false
  @state() private error = ''

  connectedCallback() {
    super.connectedCallback()
    this.reload()
  }

  /** fetch the list again (an account added its address), dropping unsaved edits */
  async reload() {
    try {
      this.list = await api.identities()
      this.dirty = false
    } catch (e) { this.error = (e as Error).message }
  }

  private edit(list: Identity[]) {
    this.list = list
    this.dirty = true
  }

  private rename(i: number, name: string) { this.edit(this.list.map((x, j) => (j === i ? { ...x, name } : x))) }
  private makeDefault(i: number) { this.edit([this.list[i], ...this.list.filter((_, j) => j !== i)]) }
  private drop(i: number) { this.edit(this.list.filter((_, j) => j !== i)) }

  private add(e: Event) {
    e.preventDefault()
    const email = this.email.trim()
    if (this.list.some(x => x.email.toLowerCase() === email.toLowerCase())) { this.error = `${email} is already listed`; return }
    this.edit([...this.list, { email, name: this.name.trim() || this.list[0]?.name || '' }])
    this.email = this.name = ''
    this.error = ''
  }

  private async save() {
    this.busy = true
    this.error = ''
    try {
      this.list = await api.identitiesSave(this.list)
      this.dirty = false
      this.emit('identities-changed')
      this.emit('toast', { text: 'From addresses saved' })
    } catch (e) {
      this.error = (e as Error).message
    } finally {
      this.busy = false
    }
  }

  render() {
    const input = 'min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200 dark:border-slate-600 dark:bg-slate-900 dark:focus:ring-sky-900'
    return html`
      <section class="border-t border-slate-200 px-5 py-4 dark:border-slate-700">
        <h3 class="mb-1 font-medium"><i class="${fa('id-card')}"></i> Send as</h3>
        <p class="mb-3 text-xs text-slate-500">
          The addresses you send from and the name each one shows. Replies are sent from the address the mail came to;
          the default is used for new mail. Accounts add their address here.
        </p>
        <ul class="space-y-1.5">
          ${this.list.map((x, i) => html`
            <li class="flex items-center gap-2">
              <input type="radio" name="default" title="Default for new mail" .checked=${i === 0} @change=${() => this.makeDefault(i)}>
              <span class="w-44 shrink-0 truncate text-sm" title=${x.email}>${x.email}</span>
              <input class="${input} flex-1" placeholder="Name shown to recipients" aria-label="Name for ${x.email}" .value=${x.name}
                     @input=${(e: Event) => this.rename(i, (e.target as HTMLInputElement).value)}>
              <button class="rounded-md px-1.5 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700"
                      title="Stop sending from ${x.email} (its account and mail stay)" @click=${() => this.drop(i)}>
                <i class="${fa('xmark')}"></i>
              </button>
            </li>`)}
        </ul>
        ${this.list[0] ? html`<p class="mt-2 text-xs text-slate-500">New mail: <code>${formatAddress(this.list[0])}</code></p>` : nothing}

        <form class="mt-3 flex items-center gap-2" @submit=${this.add}>
          <span class="w-[13px] shrink-0"></span>
          <input class="${input} w-44 shrink-0" type="email" required placeholder="alias@example.com" .value=${this.email}
                 @input=${(e: Event) => { this.email = (e.target as HTMLInputElement).value }}>
          <input class="${input} flex-1" placeholder="Name" .value=${this.name} @input=${(e: Event) => { this.name = (e.target as HTMLInputElement).value }}>
          <button class="shrink-0 rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700">
            <i class="${fa('plus')}"></i> Add
          </button>
        </form>

        ${this.dirty ? html`
          <div class="mt-3 flex justify-end gap-2">
            <button class="rounded-lg px-4 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700" @click=${this.reload}>Undo</button>
            <button class="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
                    ?disabled=${this.busy || !this.list.length} @click=${this.save}>
              ${this.busy ? html`<i class="${fa('spinner')} fa-spin"></i>` : nothing} Save
            </button>
          </div>` : nothing}
        ${this.error ? html`<p class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">${this.error}</p>` : nothing}
      </section>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-identities': Identities } }
