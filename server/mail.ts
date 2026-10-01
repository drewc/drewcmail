import nodemailer from 'nodemailer'
import * as notmuch from './notmuch.ts'
import * as gmail from './gmail.ts'
import * as imap from './imap.ts'
import * as proton from './proton.ts'
import * as filters from './filters.ts'
import * as activity from './activity.ts'
import { BadRequest } from './notmuch.ts'

/**
 * The external services, all configured in the web app: Gmail accounts sync with
 * lieer (gmail.ts), other accounts with mbsync and msmtp (imap.ts) — Proton ones
 * through the built-in Proton Mail Bridge (proton.ts). Mail comes in,
 * `notmuch new` indexes it; it goes out through the account the From address belongs to.
 */

export type SyncState = { running: boolean; last?: string; ok?: boolean; error?: string }
export const syncState: SyncState = { running: false }

/**
 * lieer, mbsync and notmuch must not run over each other: everything that touches the
 * database queues here, shown as waiting (`what`) until its turn. Fetching mail is
 * `urgent`: it goes ahead of anything still waiting that is not (tag pushes) — new mail
 * matters more than Gmail seeing tags a little later. Nothing running is interrupted
 * (a push stopped half-way saves no push point: the next one starts over).
 */
type Job = { urgent: boolean; start: () => Promise<void> }
const jobs: Job[] = []
let busy = false

function exclusive<T>(what: string, fn: () => Promise<T>, { urgent = false } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const waiting = activity.begin(what, { waiting: true })
    const job: Job = { urgent, start: () => { waiting.end(); return fn().then(resolve, reject) } }
    const at = urgent ? jobs.findIndex(j => !j.urgent) : -1
    if (at < 0) jobs.push(job)
    else jobs.splice(at, 0, job)
    void drain()
  })
}

async function drain() {
  if (busy) return
  busy = true
  while (jobs.length) await jobs.shift()!.start()
  busy = false
}

/** a fetch is waiting: a push between accounts stops for it */
const mailWaiting = () => jobs.some(j => j.urgent)

let current: Promise<SyncState> | null = null

/**
 * Fetch (Gmail pulls, then IMAP) and index — the mail first; the tag push to Gmail is
 * queued after it, as its own job that the next fetch goes ahead of. Concurrent calls
 * share one run.
 */
export function sync({ fetch = true } = {}): Promise<SyncState> {
  current ??= exclusive('Sync', async () => {
    syncState.running = true
    const errors: string[] = []
    if (fetch) {
      await gmail.pullAll().catch(e => errors.push((e as Error).message))
      await imap.syncAll(proton.skipReason).catch(e => errors.push((e as Error).message))
    }
    try {
      await activity.track('Indexing new mail (notmuch new)', () => notmuch.indexNew())
      await activity.track('Tagging new mail', async () => notmuch.tagNew(await imap.newMailRules()))
      // the user's filters (afew) see fresh mail after the folder rules and before it stops being new
      await activity.track('Filters (afew)', () => filters.runNew())
        .catch(e => { errors.push(`filters: ${(e as Error).message}`); return false })
      await notmuch.doneNew()
    } catch (e) { errors.push((e as Error).message) }
    Object.assign(syncState, { running: false, last: new Date().toISOString(), ok: !errors.length, error: errors.join('\n') || undefined })
    current = null
    // tags changed here (and in the UI meanwhile) go to Gmail now, behind any fetch asked for since
    if (fetch) void queuePush()
    return { ...syncState }
  }, { urgent: true })
  return current
}

let pushTimer: NodeJS.Timeout | undefined
/** tags changed: push them to Gmail soon (batched) */
export function schedulePush(delay = 5000) {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => void queuePush(), delay)
}

/** a push waiting in the queue covers every change made before it starts: one at a time is enough */
let pushQueued = false
async function queuePush() {
  if (pushQueued) return
  pushQueued = true
  if (!(await gmail.accounts()).some(a => a.authorized)) { pushQueued = false; return }
  exclusive('Push tag changes to Gmail', async () => {
    pushQueued = false
    await gmail.pushAll(mailWaiting)
  }).catch(e => console.error('gmail push:', (e as Error).message))
}

export type Outgoing = {
  from: string
  to?: string
  cc?: string
  bcc?: string
  subject?: string
  text?: string
  /** the rich body; `text` is then its plain alternative */
  html?: string
  inReplyTo?: string
  references?: string
  attachments?: { filename: string; contentType?: string; content: string /* base64 */; cid?: string /* an inline image of the html */ }[]
  /** parts of messages we have, attached again as they are: a quote's inline images (cid), a forward's attachments */
  parts?: { message: string; part: number; cid?: string }[]
  /** an iTIP message (an invitation's REPLY): a text/calendar;method=… alternative, and invite.ics */
  icalEvent?: { method: string; content: string }
}

/** the message without its Bcc header (and its folded continuation lines) — for the wire */
export function withoutBcc(raw: Buffer): Buffer {
  const text = raw.toString('latin1')
  // the header block, up to and including its last line's newline
  const blank = /\r?\n(\r?\n)/.exec(text)
  const split = blank ? blank.index + blank[0].length - blank[1].length : text.length
  const head = text.slice(0, split).replace(/^bcc:.*(?:\r?\n[ \t].*)*(?:\r?\n|$)/gim, '')
  return Buffer.from(head + text.slice(split), 'latin1')
}

// the stream transport keeps Bcc in the headers: withoutBcc() for msmtp, as is for the Sent copy
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })

/** compose and send through the From address's account; SMTP accounts get a copy in their Sent folder */
export async function send(m: Outgoing) {
  if (!m.from) throw new BadRequest('no From')
  if (!m.to && !m.cc && !m.bcc) throw new BadRequest('no recipients')
  const again = await Promise.all((m.parts ?? []).map(async p => {
    if (!Number.isInteger(p.part) || p.part < 1) throw new BadRequest('bad part')
    const [info, content] = await Promise.all([notmuch.partInfo(p.message, p.part), notmuch.partRaw(p.message, p.part)])
    return {
      filename: String(info.filename ?? `part-${p.part}`),
      contentType: String(info['content-type'] ?? 'application/octet-stream'),
      content, cid: p.cid || undefined,
    }
  }))
  const info = await composer.sendMail({
    from: m.from, to: m.to, cc: m.cc, bcc: m.bcc,
    subject: m.subject ?? '',
    text: m.text ?? '',
    html: m.html || undefined,
    inReplyTo: m.inReplyTo || undefined,
    references: m.references || undefined,
    attachments: [
      ...(m.attachments ?? []).map(a => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content, 'base64'), cid: a.cid || undefined })),
      ...again,
    ],
    icalEvent: m.icalEvent && { method: m.icalEvent.method, content: m.icalEvent.content, filename: 'invite.ics' },
    headers: { 'User-Agent': 'drewcmail' },
  })
  const raw = info.message as Buffer
  const { from, to } = info.envelope as { from: string; to: string[] }
  const account = await gmail.accountFor(m.from)
  if (account) {
    // Gmail reads the recipients (Bcc too) from the headers, and files the message in Sent
    await gmail.send(account.email, raw)
    if (m.inReplyTo) await notmuch.tag(notmuch.idQuery(m.inReplyTo.replace(/^<|>$/g, '')), ['replied']).catch(() => {})
    setTimeout(() => sync(), 3000)
    return { messageId: info.messageId }
  }
  const smtp = await imap.accountFor(m.from)
  if (!smtp) throw new BadRequest(`no account sends as ${from} — add it in Accounts`)
  // explicit envelope: Bcc is not in the headers
  const sentFolder = await imap.send(smtp, from, to, withoutBcc(raw))
  // mbsync uploads it to the server's Sent folder on the next sync; Proton files it itself
  if (sentFolder) await notmuch.insert(raw, sentFolder, ['sent'], ['unread', 'inbox', 'new'])
  else setTimeout(() => sync(), 5000)
  if (m.inReplyTo) await notmuch.tag(notmuch.idQuery(m.inReplyTo.replace(/^<|>$/g, '')), ['replied']).catch(() => {})
  return { messageId: info.messageId }
}

// Bridge finished a sync of its own (new mail, or the first download): fetch it
proton.whenMailArrives(() => { setTimeout(() => sync(), 2000) })
