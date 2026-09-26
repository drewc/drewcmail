import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { BaseElement, fa } from './base.ts'
import { api, threadQuery } from '../api.ts'
import { HIDDEN_TAGS } from '../format.ts'
import type { Message, ThreadNode } from '../types.ts'
import './message.ts'
import type { MailMessage } from './message.ts'

/** depth-first, oldest first: the order notmuch gives, with each reply's depth */
const flatten = (nodes: ThreadNode[], depth = 0): { m: Message; depth: number }[] =>
  nodes.flatMap(([m, replies]) => [{ m, depth }, ...flatten(replies, depth + 1)])

/**
 * <mail-thread-view>: a conversation. Messages that matched the search or are unread
 * open expanded (the last one always); opening the thread marks it read.
 */
@customElement('mail-thread-view')
export class ThreadView extends BaseElement {
  @property() threadId = ''
  @state() private messages: { m: Message; depth: number }[] = []
  @state() private error = ''
  @state() private loading = false
  private opened = new Set<string>()

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('threadId')) { this.messages = []; this.opened.clear(); this.reload() }
  }

  async reload() {
    const id = this.threadId
    if (!id) return
    this.loading = !this.messages.length
    try {
      const threads = await api.thread(id)
      if (id !== this.threadId) return
      this.messages = flatten(threads.flat())
      this.error = ''
      if (!this.opened.size) {
        const last = this.messages[this.messages.length - 1]
        for (const { m } of this.messages) if (m.tags.includes('unread') || m === last?.m) this.opened.add(m.id)
      }
      if (this.messages.some(({ m }) => m.tags.includes('unread'))) {
        // leave the unread markers visible for this render; the list refresh will clear them
        api.tag(`${threadQuery(id)} and tag:unread`, [], ['unread']).then(() => this.emit('changed')).catch(() => {})
      }
    } catch (e) {
      this.error = (e as Error).message
    } finally {
      this.loading = false
    }
  }

  /** reply to the last message (keyboard r / a) */
  replyLast(to: 'all' | 'sender') {
    const all = this.renderRoot.querySelectorAll<MailMessage>('mail-message')
    all[all.length - 1]?.reply(to)
  }

  private async tagThread(add: string[], remove: string[], text: string, close = false) {
    try {
      await api.tag(threadQuery(this.threadId), add, remove)
      this.emit('toast', { text })
      this.emit('changed')
      if (close) this.emit('open-thread', { id: null })
    } catch (e) { this.emit('toast', { text: (e as Error).message }) }
  }

  render() {
    const first = this.messages[0]?.m
    const tags = [...new Set(this.messages.flatMap(({ m }) => m.tags))]
    const inInbox = tags.includes('inbox')
    const btn = 'rounded-lg px-2.5 py-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-700 dark:hover:text-slate-100'
    return html`
      <div class="flex h-full flex-col">
        <div class="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-slate-700">
          <button class="${btn}" title="Back (u)" @click=${() => this.emit('open-thread', { id: null })}><i class="${fa('arrow-left')}"></i></button>
          ${inInbox
            ? html`<button class="${btn}" title="Archive (e)" @click=${() => this.tagThread([], ['inbox'], 'Archived', true)}><i class="${fa('box-archive')}"></i></button>`
            : html`<button class="${btn}" title="Move to inbox" @click=${() => this.tagThread(['inbox'], ['deleted', 'spam'], 'Moved to inbox')}><i class="${fa('inbox')}"></i></button>`}
          <button class="${btn}" title="Spam (!)" @click=${() => this.tagThread(['spam'], ['inbox'], 'Marked as spam', true)}><i class="${fa('ban')}"></i></button>
          <button class="${btn}" title="Delete (#)" @click=${() => this.tagThread(['deleted'], ['inbox'], 'Moved to trash', true)}><i class="${fa('trash')}"></i></button>
          <button class="${btn}" title="Mark unread (U)" @click=${() => this.tagThread(['unread'], [], 'Marked unread', true)}><i class="${fa('envelope')}"></i></button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          ${this.loading ? html`<p class="p-8 text-center text-slate-400"><i class="${fa('spinner')} fa-spin"></i></p>` : nothing}
          ${this.error ? html`<p class="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">${this.error}</p>` : nothing}
          ${first ? html`
            <h1 class="px-6 pt-5 pb-3 text-xl font-medium">
              ${first.headers.Subject || '(no subject)'}
              ${tags.filter(t => !HIDDEN_TAGS.has(t)).map(t => html`<span class="ml-1 rounded bg-slate-200 px-1.5 align-middle text-xs font-normal text-slate-700 dark:bg-slate-700 dark:text-slate-300">${t}</span>`)}
            </h1>` : nothing}
          <div class="mx-2 mb-8 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800/40">
            ${repeat(this.messages, ({ m }) => m.id, ({ m, depth }) => html`
              <mail-message .message=${m} ?open=${this.opened.has(m.id)} style="margin-left: ${Math.min(depth, 6) * 12}px"
                            @click=${() => this.opened.add(m.id)}></mail-message>`)}
          </div>
        </div>
      </div>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-thread-view': ThreadView } }
