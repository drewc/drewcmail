import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { BaseElement, fa } from './base.ts'
import { api } from '../api.ts'
import { calendarPart } from '../body.ts'
import { addressOf, formatAddress } from '../format.ts'
import { describeRule, googleCalendarUrl, invite, reply, type Invite, type PartStat, type Person, type When } from '../ical.ts'
import type { Identity, Message } from '../types.ts'

const ANSWERS: { stat: PartStat; label: string; verb: string; subject: string }[] = [
  { stat: 'ACCEPTED', label: 'Yes', verb: 'accepted', subject: 'Accepted' },
  { stat: 'TENTATIVE', label: 'Maybe', verb: 'tentatively accepted', subject: 'Tentative' },
  { stat: 'DECLINED', label: 'No', verb: 'declined', subject: 'Declined' },
]

const STAT: Record<string, { icon: string; color: string; text: string }> = {
  ACCEPTED: { icon: 'circle-check', color: 'text-emerald-600 dark:text-emerald-400', text: 'yes' },
  TENTATIVE: { icon: 'circle-question', color: 'text-amber-500', text: 'maybe' },
  DECLINED: { icon: 'circle-xmark', color: 'text-red-500', text: 'no' },
  DELEGATED: { icon: 'circle-right', color: 'text-slate-400', text: 'delegated' },
  'NEEDS-ACTION': { icon: 'circle', color: 'text-slate-300 dark:text-slate-600', text: 'awaiting' },
}

const dayFmt: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
const timeFmt: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

/** "Tue, Sep 29, 2026 · 11:00 – 11:30 AM PDT", all-day and multi-day ranges too (all-day DTEND is exclusive) */
function range(start: When, end?: When): string {
  const s = start.date
  if (start.allDay) {
    const last = end ? new Date(end.date.getTime() - 86400000) : s
    return last > s && !sameDay(s, last)
      ? `${s.toLocaleDateString([], dayFmt)} – ${last.toLocaleDateString([], dayFmt)}`
      : `${s.toLocaleDateString([], dayFmt)} · all day`
  }
  const zone = (d: Date) => d.toLocaleTimeString([], { timeZoneName: 'short' }).split(' ').pop()
  if (!end || end.date.getTime() === s.getTime()) return `${s.toLocaleDateString([], dayFmt)} · ${s.toLocaleTimeString([], timeFmt)} ${zone(s)}`
  if (sameDay(s, end.date)) {
    return `${s.toLocaleDateString([], dayFmt)} · ${s.toLocaleTimeString([], timeFmt)} – ${end.date.toLocaleTimeString([], timeFmt)} ${zone(end.date)}`
  }
  const both: Intl.DateTimeFormatOptions = { ...dayFmt, ...timeFmt }
  return `${s.toLocaleString([], both)} – ${end.date.toLocaleString([], both)} ${zone(end.date)}`
}

/** the organizer's own wall-clock time, when their zone is not ours: "8:00 – 8:30 PM Europe/Athens" */
function theirTime(start: When, end?: When): string {
  if (start.allDay || start.offset == null || !start.tz || start.offset === -start.date.getTimezoneOffset()) return ''
  const wall = (w: When) => new Date(w.date.getTime() + (w.offset ?? start.offset!) * 60000)
    .toLocaleTimeString([], { ...timeFmt, timeZone: 'UTC' })
  const tz = start.tz === 'UTC' ? 'UTC' : start.tz.replace(/_/g, ' ')
  return end ? `${wall(start)} – ${wall(end)} ${tz}` : `${wall(start)} ${tz}`
}

const who = (p: Person) => p.name || p.email

/**
 * <mail-invite>: the calendar card of a message with an invitation — the event, its
 * guests and their answers, Yes/Maybe/No (an iTIP REPLY mailed to the organizer),
 * and adding it to a calendar. A REPLY shows as one line (who answered what);
 * a CANCEL as a struck-out event. Emits toast and changed.
 */
@customElement('mail-invite')
export class MailInvite extends BaseElement {
  @property({ attribute: false }) message!: Message
  /** the rest of the thread: our own REPLY sent later says what we answered */
  @property({ attribute: false }) thread: Message[] = []
  @property({ attribute: false }) identities: Identity[] = []
  @state() private inv?: Invite
  @state() private source = ''
  @state() private guests = false
  @state() private sending?: PartStat
  /** answered in this session (the sent copy arrives with the next sync) */
  @state() private answered?: PartStat
  @state() private addMenu = false

  private closeMenu = () => { this.addMenu = false }
  connectedCallback() { super.connectedCallback(); window.addEventListener('click', this.closeMenu) }
  disconnectedCallback() { window.removeEventListener('click', this.closeMenu); super.disconnectedCallback() }

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('message')) this.load()
  }

  private async load() {
    const m = this.message
    const part = calendarPart(m)
    if (!part) { this.inv = undefined; return }
    let source = typeof part.content === 'string' ? part.content : ''
    if (!source) {
      try { source = await (await fetch(api.partUrl(m.id, part.id))).text() } catch { return }
      if (m !== this.message) return
    }
    this.source = source
    this.inv = invite(source)
  }

  private ours(email?: string) { return !!email && this.identities.some(i => i.email.toLowerCase() === email.toLowerCase()) }

  /** which of our addresses was invited: an attendee that is ours, else ours among the message's recipients, else the default */
  private get me(): { identity?: Identity; attendee?: Person } {
    const inv = this.inv!
    const attendee = inv.attendees.find(a => this.ours(a.email))
    const byEmail = (e: string) => this.identities.find(i => i.email.toLowerCase() === e)
    if (attendee) return { identity: byEmail(attendee.email), attendee }
    const h = this.message.headers
    const to = [h.To, h.Cc, h['Delivered-To']].filter(Boolean).join(',').split(',').map(addressOf)
    return { identity: to.map(byEmail).find(Boolean) ?? this.identities[0] }
  }

  /** what we answered: a REPLY of ours later in the thread, else our PARTSTAT in this invitation */
  private get myAnswer(): PartStat | undefined {
    if (this.answered) return this.answered
    const inv = this.inv!
    let latest: { ts: number; stat: PartStat } | undefined
    for (const m of this.thread) {
      if (m.timestamp < this.message.timestamp) continue
      const p = calendarPart(m)
      const r = typeof p?.content === 'string' && p.content.includes('REPLY') ? invite(p.content) : undefined
      const a = r?.method === 'REPLY' && r.uid === inv.uid ? r.attendees.find(x => this.ours(x.email)) : undefined
      if (a && (!latest || m.timestamp >= latest.ts)) latest = { ts: m.timestamp, stat: a.partstat }
    }
    return latest?.stat ?? this.me.attendee?.partstat
  }

  private async rsvp(stat: PartStat) {
    const inv = this.inv!
    const { identity } = this.me
    if (!identity || !inv.organizer) return
    const answer = ANSWERS.find(a => a.stat === stat)!
    this.sending = stat
    try {
      await api.send({
        from: formatAddress(identity),
        to: formatAddress({ email: inv.organizer.email, name: inv.organizer.name }),
        subject: `${answer.subject}: ${inv.summary}`,
        text: `${identity.name || identity.email} has ${answer.verb} this invitation.\n`,
        inReplyTo: `<${this.message.id}>`,
        references: `<${this.message.id}>`,
        icalEvent: { method: 'REPLY', content: reply(inv, identity, stat) },
      })
      this.answered = stat
      this.emit('toast', { text: `Replied “${answer.label}” to ${who(inv.organizer)}` })
      this.emit('changed')
    } catch (e) {
      this.emit('toast', { text: (e as Error).message })
    } finally { this.sending = undefined }
  }

  private download() {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([this.source], { type: 'text/calendar' }))
    a.download = `${(this.inv?.summary || 'invite').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80)}.ics`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  private renderTile(inv: Invite, cancelled: boolean) {
    const d = inv.start?.date
    return html`
      <div class="flex w-14 shrink-0 flex-col self-start overflow-hidden rounded-lg border text-center
                  ${cancelled ? 'border-slate-300 opacity-60 dark:border-slate-600' : 'border-sky-200 dark:border-sky-800'}">
        <div class="${cancelled ? 'bg-slate-400' : 'bg-sky-600'} py-0.5 text-[10px] font-semibold tracking-wider text-white uppercase">
          ${d ? d.toLocaleDateString([], { month: 'short' }) : '—'}</div>
        <div class="bg-white py-1 text-2xl leading-none font-semibold dark:bg-slate-900">${d?.getDate() ?? '?'}</div>
        <div class="bg-white pb-1 text-[10px] text-slate-500 uppercase dark:bg-slate-900">${d?.toLocaleDateString([], { weekday: 'short' }) ?? ''}</div>
      </div>`
  }

  private renderGuests(inv: Invite) {
    const people = inv.attendees
    if (!people.length) return nothing
    const tally = new Map<string, number>()
    for (const p of people) tally.set(p.partstat, (tally.get(p.partstat) ?? 0) + 1)
    const counts = [...tally].map(([s, n]) => `${n} ${STAT[s]?.text ?? s.toLowerCase()}`).join(', ')
    return html`
      <div class="flex items-start gap-2">
        <i class="${fa('user-group')} mt-1 w-4 text-center text-xs text-slate-400"></i>
        <div class="min-w-0 flex-1">
          <button class="text-left hover:underline" @click=${() => { this.guests = !this.guests }}>
            ${people.length} ${people.length === 1 ? 'guest' : 'guests'}
            <span class="text-slate-500">· ${counts}</span>
            <i class="${fa(this.guests ? 'chevron-up' : 'chevron-down')} ml-1 text-[10px] text-slate-400"></i>
          </button>
          ${this.guests ? html`
            <ul class="mt-1 space-y-0.5">
              ${people.map(p => {
                const s = STAT[p.partstat] ?? STAT['NEEDS-ACTION']
                return html`
                  <li class="flex items-center gap-2" title=${`${p.email} — ${s.text}`}>
                    <i class="${fa(s.icon, p.partstat === 'NEEDS-ACTION' ? 'regular' : 'solid')} ${s.color}"></i>
                    <span class="truncate">${who(p)}</span>
                    ${p.name ? html`<span class="truncate text-xs text-slate-400">${p.email}</span>` : nothing}
                    ${p.email === inv.organizer?.email ? html`<span class="text-xs text-slate-400">organizer</span>` : nothing}
                    ${p.role === 'OPT-PARTICIPANT' ? html`<span class="text-xs text-slate-400">optional</span>` : nothing}
                  </li>`
              })}
            </ul>` : nothing}
        </div>
      </div>`
  }

  private renderAdd(inv: Invite) {
    const google = googleCalendarUrl(inv)
    const item = 'flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm whitespace-nowrap hover:bg-slate-100 dark:hover:bg-slate-700'
    return html`
      <span class="relative">
        <button class="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                aria-haspopup="menu" aria-expanded=${this.addMenu}
                @click=${(e: Event) => { e.stopPropagation(); this.addMenu = !this.addMenu }}>
          <i class="${fa('calendar-plus')}"></i> Add to calendar</button>
        ${this.addMenu ? html`
          <div role="menu" class="absolute right-0 bottom-full z-30 mb-1 w-52 rounded-lg border border-slate-200 bg-white py-1 text-slate-700 shadow-xl dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
            <button role="menuitem" class="${item}" @click=${this.download}><i class="${fa('download')} w-4 text-slate-500"></i>Download .ics</button>
            ${google ? html`<a role="menuitem" class="${item}" href=${google} target="_blank" rel="noopener noreferrer">
              <i class="${fa('google', 'brands')} w-4 text-slate-500"></i>Google Calendar</a>` : nothing}
          </div>` : nothing}
      </span>`
  }

  /** someone's answer to an invitation of ours: one line */
  private renderReply(inv: Invite) {
    const a = inv.attendees[0]
    if (!a) return nothing
    const s = STAT[a.partstat] ?? STAT['NEEDS-ACTION']
    const verb = ANSWERS.find(x => x.stat === a.partstat)?.verb ?? `answered ${a.partstat.toLowerCase()} to`
    return html`
      <div class="mb-3 flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800">
        <i class="${fa(s.icon)} ${s.color} text-lg"></i>
        <div class="min-w-0">
          <div><b>${this.ours(a.email) ? 'You' : who(a)}</b> ${verb} <b>${inv.summary || 'the invitation'}</b></div>
          ${inv.start ? html`<div class="text-xs text-slate-500">${range(inv.start, inv.end)}</div>` : nothing}
        </div>
      </div>`
  }

  render() {
    const inv = this.inv
    if (!inv) return nothing
    if (inv.method === 'REPLY') return this.renderReply(inv)
    const cancelled = inv.method === 'CANCEL' || inv.status === 'CANCELLED'
    const mine = this.ours(inv.organizer?.email)
    const answer = this.myAnswer
    const past = !inv.rrule && (inv.end ?? inv.start)?.date && (inv.end ?? inv.start)!.date.getTime() < Date.now()
    const canAnswer = inv.method === 'REQUEST' && !cancelled && !mine && !!inv.organizer && !!this.me.identity
    const badge = cancelled ? ['Cancelled', 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300']
      : inv.method === 'REQUEST' ? ['Invitation', 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300']
      : inv.method === 'COUNTER' ? ['New time proposed', 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300']
      : ['Event', 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300']
    const theirs = inv.start ? theirTime(inv.start, inv.end) : ''
    const row = (icon: string, body: unknown) => html`
      <div class="flex items-start gap-2"><i class="${fa(icon)} mt-1 w-4 text-center text-xs text-slate-400"></i><div class="min-w-0 flex-1 break-words">${body}</div></div>`
    const btn = (on: boolean) => `rounded-full border px-3 py-1 text-sm font-medium transition-colors disabled:opacity-50 ${on
      ? 'border-sky-600 bg-sky-600 text-white'
      : 'border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700'}`

    return html`
      <section class="mb-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-800/60" aria-label="Calendar invitation">
        <div class="flex gap-4">
          ${this.renderTile(inv, cancelled)}
          <div class="min-w-0 flex-1 space-y-1.5 text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-base font-semibold ${cancelled ? 'text-slate-500 line-through' : ''}">${inv.summary || '(no title)'}</h2>
              <span class="rounded-full px-2 py-0.5 text-[11px] font-medium ${badge[1]}">${badge[0]}</span>
              ${past ? html`<span class="text-xs text-slate-400">past</span>` : nothing}
            </div>
            ${inv.start ? row('clock', html`
              ${range(inv.start, inv.end)}
              ${theirs ? html`<div class="text-xs text-slate-500">${theirs}</div>` : nothing}`) : nothing}
            ${inv.rrule ? row('repeat', describeRule(inv.rrule, inv.calendar)) : nothing}
            ${inv.location || inv.join ? row('location-dot', html`
              ${/^https?:\/\//.test(inv.location)
                ? html`<a class="text-sky-700 underline dark:text-sky-400" href=${inv.location} target="_blank" rel="noopener noreferrer">${inv.location}</a>`
                : inv.location}
              ${inv.join && !cancelled ? html`
                <a class="ml-1 inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-700"
                   href=${inv.join} target="_blank" rel="noopener noreferrer"><i class="${fa('video')}"></i> Join</a>` : nothing}`) : nothing}
            ${inv.organizer ? row('user', html`${mine ? 'You' : who(inv.organizer)} <span class="text-slate-500">· organizer</span>`) : nothing}
            ${this.renderGuests(inv)}
          </div>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
          ${canAnswer ? html`
            <span class="mr-1 text-sm text-slate-500">Going?</span>
            ${ANSWERS.map(a => html`
              <button class="${btn(answer === a.stat)}" ?disabled=${!!this.sending} @click=${() => this.rsvp(a.stat)}
                      title=${answer === a.stat ? `You answered ${a.label}` : `Reply ${a.label} to ${who(inv.organizer!)}`}>
                ${this.sending === a.stat ? html`<i class="${fa('spinner')} fa-spin"></i>` : answer === a.stat ? html`<i class="${fa('check')}"></i>` : nothing}
                ${a.label}</button>`)}`
            : cancelled ? html`<span class="text-sm text-slate-500">This event was cancelled${inv.organizer ? ` by ${who(inv.organizer)}` : ''}.</span>`
            : mine ? html`<span class="text-sm text-slate-500">You organized this event.</span>` : nothing}
          <span class="flex-1"></span>
          ${cancelled ? nothing : this.renderAdd(inv)}
        </div>
      </section>`
  }
}

declare global { interface HTMLElementTagNameMap { 'mail-invite': MailInvite } }
