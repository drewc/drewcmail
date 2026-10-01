/**
 * Calendar invitations (iCalendar, RFC 5545, as iTIP/iMIP mail — RFC 5546/6047):
 * parsing a VCALENDAR into the event it describes, and writing the METHOD:REPLY
 * that answers it. Only what an invite card needs — no recurrence expansion.
 */

export type Prop = { name: string; params: Record<string, string>; value: string }
export type Component = { name: string; props: Prop[]; children: Component[] }

/** unfold, split into properties, nest BEGIN/END */
export function parse(text: string): Component | undefined {
  const lines = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const root: Component = { name: '', props: [], children: [] }
  const stack = [root]
  for (const line of lines) {
    if (!line.trim()) continue
    const prop = parseLine(line)
    if (!prop) continue
    const top = stack[stack.length - 1]
    if (prop.name === 'BEGIN') {
      const c: Component = { name: prop.value.toUpperCase(), props: [], children: [] }
      top.children.push(c)
      stack.push(c)
    } else if (prop.name === 'END') {
      if (stack.length > 1) stack.pop()
    } else top.props.push(prop)
  }
  return root.children.find(c => c.name === 'VCALENDAR')
}

/** NAME;PARAM=a;PARAM="b:c":value — the value is kept escaped (see text()) */
function parseLine(line: string): Prop | undefined {
  let i = 0
  const name = line.match(/^[A-Za-z0-9-]+/)?.[0]
  if (!name) return
  i = name.length
  const params: Record<string, string> = {}
  while (line[i] === ';') {
    const eq = line.indexOf('=', i)
    if (eq < 0) return
    const key = line.slice(i + 1, eq).toUpperCase()
    i = eq + 1
    let v = ''
    // a parameter may have several values, each maybe quoted: A="x",B
    for (;;) {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1)
        v += line.slice(i + 1, close < 0 ? undefined : close)
        i = close < 0 ? line.length : close + 1
      } else {
        const m = line.slice(i).match(/^[^;:,]*/)![0]
        v += m
        i += m.length
      }
      if (line[i] !== ',') break
      v += ','
      i++
    }
    params[key] = v
  }
  if (line[i] !== ':') return
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) }
}

/** a TEXT value unescaped */
export const text = (v = '') => v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

const prop = (c: Component, name: string) => c.props.find(p => p.name === name)
const props = (c: Component, name: string) => c.props.filter(p => p.name === name)

// ── time ─────────────────────────────────────────────────────────────────────

/**
 * An instant, plus what it was written as: an all-day date, or a time in a zone.
 * `offset` is the zone's UTC offset (minutes) at that instant, when known.
 */
export type When = { date: Date; allDay: boolean; tz?: string; offset?: number }

const DT = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/

/** a zone's UTC offset in minutes at an instant, from Intl (IANA names only) */
function intlOffset(tz: string, ms: number): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(ms)
    const n = (t: string) => Number(parts.find(p => p.type === t)?.value)
    return (Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(ms / 1000) * 1000) / 60000
  } catch { return undefined }
}

const offsetMinutes = (v = '') => {
  const m = v.match(/^([+-])(\d{2})(\d{2})/)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** the wall-clock time (as UTC ms) a yearly onset rule gives in `year`: BYMONTH=3;BYDAY=2SU / -1SU */
function onset(c: Component, year: number): number | undefined {
  const start = prop(c, 'DTSTART')?.value.match(DT)
  if (!start) return
  const [, , mo, d, h = '0', mi = '0', s = '0'] = start
  const rule = Object.fromEntries((prop(c, 'RRULE')?.value ?? '').split(';').map(kv => kv.split('=')))
  const month = rule.BYMONTH ? Number(rule.BYMONTH) - 1 : Number(mo) - 1
  let day = Number(d)
  const by = String(rule.BYDAY ?? '').match(/^([+-]?\d+)?([A-Z]{2})$/)
  if (rule.FREQ === 'YEARLY' && by) {
    const n = Number(by[1] ?? 1), wd = DAYS.indexOf(by[2])
    if (n > 0) {
      const first = new Date(Date.UTC(year, month, 1)).getUTCDay()
      day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7
    } else {
      const lastDay = new Date(Date.UTC(year, month + 1, 0))
      day = lastDay.getUTCDate() - ((lastDay.getUTCDay() - wd + 7) % 7) + (n + 1) * 7
    }
  } else if (!rule.FREQ && year !== Number(start[1])) return
  return Date.UTC(year, month, day, Number(h), Number(mi), Number(s))
}

/** a VTIMEZONE's offset at a wall-clock time: the STANDARD/DAYLIGHT whose last onset is latest */
function vtimezoneOffset(zone: Component, wall: number): number | undefined {
  const year = new Date(wall).getUTCFullYear()
  let best: { at: number; offset: number } | undefined
  for (const c of zone.children) {
    for (const y of [year - 1, year]) {
      const at = onset(c, y)
      if (at != null && at <= wall && (!best || at > best.at)) best = { at, offset: offsetMinutes(prop(c, 'TZOFFSETTO')?.value) }
    }
  }
  // before the first onset: what the earliest one changed from
  return best?.offset ?? (zone.children[0] ? offsetMinutes(prop(zone.children[0], 'TZOFFSETFROM')?.value) : undefined)
}

/** DTSTART and friends: UTC (Z), in a zone (TZID — IANA, else the calendar's VTIMEZONE), floating, or a date */
export function when(p: Prop | undefined, cal: Component): When | undefined {
  const m = p?.value.match(DT)
  if (!p || !m) return
  const [, y, mo, d, h, mi, s, z] = m
  if (h == null || p.params.VALUE === 'DATE') return { date: new Date(Number(y), Number(mo) - 1, Number(d)), allDay: true }
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))
  if (z) return { date: new Date(wall), allDay: false, tz: 'UTC', offset: 0 }
  const tz = p.params.TZID?.replace(/^\//, '')
  if (tz) {
    let offset = intlOffset(tz, wall)
    if (offset != null) offset = intlOffset(tz, wall - offset * 60000) ?? offset
    else {
      const zone = cal.children.find(c => c.name === 'VTIMEZONE' && prop(c, 'TZID')?.value === p.params.TZID)
      if (zone) offset = vtimezoneOffset(zone, wall)
    }
    if (offset != null) return { date: new Date(wall - offset * 60000), allDay: false, tz, offset }
  }
  // floating (or a zone we cannot place): the viewer's own time
  return { date: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)), allDay: false, tz }
}

/** PT1H30M, P1D, P1W → ms */
function duration(v = ''): number {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return 0
  const [, sign, w, d, h, mi, s] = m.map(x => x ?? '0')
  return (sign === '-' ? -1 : 1) * ((((Number(w) * 7 + Number(d)) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(s)) * 1000
}

// ── the event ────────────────────────────────────────────────────────────────

export type PartStat = 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'DELEGATED'
export type Person = { email: string; name: string; partstat: PartStat; role: string; rsvp: boolean; prop: Prop }

const person = (p: Prop): Person => {
  const email = p.value.replace(/^mailto:/i, '').trim().toLowerCase()
  const name = p.params.CN?.replace(/^"|"$/g, '') ?? ''
  // Google names a guest without a name by their address
  return {
    email,
    name: name.toLowerCase() === email ? '' : name,
    partstat: (p.params.PARTSTAT?.toUpperCase() ?? 'NEEDS-ACTION') as PartStat,
    role: p.params.ROLE?.toUpperCase() ?? 'REQ-PARTICIPANT',
    rsvp: p.params.RSVP?.toUpperCase() === 'TRUE',
    prop: p,
  }
}

export type Invite = {
  /** REQUEST (an invitation or update), CANCEL, REPLY (an answer), PUBLISH (just an event), COUNTER… */
  method: string
  uid: string
  sequence: number
  summary: string
  description: string
  location: string
  url: string
  /** a meeting link: Google Meet, Teams, Zoom — from the X- properties, the location or the description */
  join: string
  status: string
  start?: When
  end?: When
  rrule: string
  recurrenceId?: When
  organizer?: Person
  attendees: Person[]
  calendar: Component
  event: Component
}

const MEETING = /https:\/\/(?:meet\.google\.com|teams\.microsoft\.com\/l\/meetup-join|(?:[\w-]+\.)?zoom\.us\/[jw]|[\w-]+\.webex\.com|meet\.jit\.si)\/[^\s<>"'\\]*/i

/** the event of a VCALENDAR — the master (no RECURRENCE-ID) if there are several */
export function invite(source: string): Invite | undefined {
  const calendar = parse(source)
  const events = calendar?.children.filter(c => c.name === 'VEVENT') ?? []
  const event = events.find(e => !prop(e, 'RECURRENCE-ID')) ?? events[0]
  if (!calendar || !event) return
  const t = (name: string) => text(prop(event, name)?.value)
  const start = when(prop(event, 'DTSTART'), calendar)
  let end = when(prop(event, 'DTEND'), calendar)
  const dur = prop(event, 'DURATION')
  if (!end && start && dur) end = { ...start, date: new Date(start.date.getTime() + duration(dur.value)) }
  const description = t('DESCRIPTION'), location = t('LOCATION')
  const join = [prop(event, 'X-GOOGLE-CONFERENCE')?.value, prop(event, 'X-MICROSOFT-SKYPETEAMSMEETINGURL')?.value, location, description]
    .map(v => v?.match(MEETING)?.[0]).find(Boolean) ?? ''
  const org = prop(event, 'ORGANIZER')
  return {
    method: (prop(calendar, 'METHOD')?.value ?? 'PUBLISH').toUpperCase(),
    uid: prop(event, 'UID')?.value ?? '',
    sequence: Number(prop(event, 'SEQUENCE')?.value ?? 0),
    summary: t('SUMMARY'), description, location, url: prop(event, 'URL')?.value ?? '', join,
    status: (prop(event, 'STATUS')?.value ?? '').toUpperCase(),
    start, end,
    rrule: prop(event, 'RRULE')?.value ?? '',
    recurrenceId: when(prop(event, 'RECURRENCE-ID'), calendar),
    organizer: org && person(org),
    attendees: props(event, 'ATTENDEE').map(person),
    calendar, event,
  }
}

const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=… → "Every 2 weeks on Monday, Wednesday, until Dec 1, 2026" */
export function describeRule(rrule: string, cal?: Component): string {
  const r = Object.fromEntries(rrule.split(';').map(kv => kv.split('='))) as Record<string, string>
  const unit = ({ DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' } as Record<string, string>)[r.FREQ]
  if (!unit) return 'Repeats'
  const n = Number(r.INTERVAL ?? 1)
  let s = n > 1 ? `Every ${n} ${unit}s` : ({ day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' } as Record<string, string>)[unit]
  const days = (r.BYDAY ?? '').split(',').filter(Boolean).map(d => {
    const m = d.match(/^([+-]?\d+)?([A-Z]{2})$/)
    if (!m) return d
    const name = DAY_NAMES[DAYS.indexOf(m[2])] ?? m[2]
    const k = Number(m[1] ?? 0)
    return k === -1 ? `last ${name}` : k > 0 ? `${ORDINAL[k] ?? `${k}th`} ${name}` : name
  })
  if (days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every(d => r.BYDAY.includes(d)) && unit === 'week' && n === 1) s = 'Every weekday'
  else if (days.length) s += ` on ${days.join(', ')}`
  if (r.COUNT) s += `, ${r.COUNT} times`
  if (r.UNTIL && cal) {
    const u = when({ name: 'UNTIL', params: {}, value: r.UNTIL }, cal)
    if (u) s += `, until ${u.date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
  }
  return s
}

// ── answering ────────────────────────────────────────────────────────────────

/** a property line, folded at 75 octets (not inside a UTF-8 sequence) */
function line(p: Prop): string {
  const params = Object.entries(p.params).map(([k, v]) => `;${k}=${/[;:,]/.test(v) ? `"${v.replace(/"/g, '')}"` : v}`).join('')
  const bytes = new TextEncoder().encode(`${p.name}${params}:${p.value}`)
  const out: string[] = []
  let i = 0
  while (i < bytes.length) {
    let j = Math.min(bytes.length, i + (out.length ? 74 : 75))
    while (j < bytes.length && (bytes[j] & 0xc0) === 0x80) j--
    out.push(new TextDecoder().decode(bytes.slice(i, j)))
    i = j
  }
  return out.join('\r\n ')
}

const component = (c: Component): string[] =>
  [`BEGIN:${c.name}`, ...c.props.map(line), ...c.children.flatMap(component), `END:${c.name}`]

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/**
 * METHOD:REPLY for `me` (an attendee's address) with a new PARTSTAT: the event's
 * identity (UID, SEQUENCE, RECURRENCE-ID, DTSTART…), the organizer and just my ATTENDEE line.
 */
export function reply(inv: Invite, me: { email: string; name: string }, partstat: PartStat): string {
  const keep = ['UID', 'SEQUENCE', 'RECURRENCE-ID', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'SUMMARY', 'ORGANIZER']
  const mine = inv.attendees.find(a => a.email === me.email.toLowerCase())
  const params: Record<string, string> = { ...(mine?.prop.params ?? {}), PARTSTAT: partstat }
  delete params.RSVP
  if (me.name) params.CN = me.name
  const event: Component = {
    name: 'VEVENT',
    props: [
      ...inv.event.props.filter(p => keep.includes(p.name)),
      { name: 'ATTENDEE', params, value: `mailto:${mine?.prop.value.replace(/^mailto:/i, '') ?? me.email}` },
      { name: 'DTSTAMP', params: {}, value: utcStamp(new Date()) },
    ],
    children: [],
  }
  const zones = new Set(event.props.map(p => p.params.TZID).filter(Boolean))
  const calendar: Component = {
    name: 'VCALENDAR',
    props: [
      { name: 'PRODID', params: {}, value: '-//drewcmail//EN' },
      { name: 'VERSION', params: {}, value: '2.0' },
      { name: 'CALSCALE', params: {}, value: 'GREGORIAN' },
      { name: 'METHOD', params: {}, value: 'REPLY' },
    ],
    children: [...inv.calendar.children.filter(c => c.name === 'VTIMEZONE' && zones.has(prop(c, 'TZID')?.value ?? '')), event],
  }
  return component(calendar).join('\r\n') + '\r\n'
}

/** a Google Calendar "add event" link, for mail from anywhere else */
export function googleCalendarUrl(inv: Invite): string | undefined {
  if (!inv.start) return
  const fmt = (w: When) => (w.allDay
    ? `${w.date.getFullYear()}${String(w.date.getMonth() + 1).padStart(2, '0')}${String(w.date.getDate()).padStart(2, '0')}`
    : utcStamp(w.date))
  const end = inv.end ?? (inv.start.allDay ? { ...inv.start, date: new Date(inv.start.date.getTime() + 86400000) } : inv.start)
  const q = new URLSearchParams({ action: 'TEMPLATE', text: inv.summary, dates: `${fmt(inv.start)}/${fmt(end)}`, details: inv.description, location: inv.location })
  if (inv.rrule) q.set('recur', `RRULE:${inv.rrule}`)
  return `https://calendar.google.com/calendar/render?${q}`
}
