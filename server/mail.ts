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
 * lieer and notmuch must not run over each other: everything that touches the database
 * queues here — shown as waiting (`what`) until its turn
 */
let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const waiting = activity.begin(what, { waiting: true })
  const start = () => { waiting.end(); return fn() }
  const run = queue.then(start, start)
  queue = run.catch(() => {})
  return run
}

let current: Promise<SyncState> | null = null

/** fetch (Gmail, then IMAP) and index; concurrent calls share one run */
export function sync({ fetch = true } = {}): Promise<SyncState> {
  current ??= exclusive('Sync', async () => {
    syncState.running = true
    const errors: string[] = []
    if (fetch) {
      await gmail.syncAll().catch(e => errors.push((e as Error).message))
      await imap.syncAll(proton.skipReason).catch(e => errors.push((e as Error).message))
    }
    try {
      await activity.track('Indexing new mail (notmuch new)', () => notmuch.indexNew())
      await activity.track('Tagging new mail', async () => notmuch.tagNew(await imap.newMailRules()))
      // the user's filters (afew) see fresh mail after the folder rules and before it stops being new
      const filtered = await activity.track('Filters (afew)', () => filters.runNew())
        .catch(e => { errors.push(`filters: ${(e as Error).message}`); return false })
      if (filtered) schedulePush()
      await notmuch.doneNew()
    } catch (e) { errors.push((e as Error).message) }
    Object.assign(syncState, { running: false, last: new Date().toISOString(), ok: !errors.length, error: errors.join('\n') || undefined })
    current = null
    return { ...syncState }
  })
  return current
}

let pushTimer: NodeJS.Timeout | undefined
/** tags changed: push them to Gmail soon (batched) */
export function schedulePush() {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    exclusive('Push tag changes to Gmail', async () => { if ((await gmail.accounts()).some(a => a.authorized)) await gmail.syncAll('push') })
      .catch(e => console.error('gmail push:', (e as Error).message))
  }, 5000)
}

export type Outgoing = {
  from: string
  to?: string
  cc?: string
  bcc?: string
  subject?: string
  text?: string
  inReplyTo?: string
  references?: string
  attachments?: { filename: string; contentType?: string; content: string /* base64 */ }[]
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
  const info = await composer.sendMail({
    from: m.from, to: m.to, cc: m.cc, bcc: m.bcc,
    subject: m.subject ?? '',
    text: m.text ?? '',
    inReplyTo: m.inReplyTo || undefined,
    references: m.references || undefined,
    attachments: m.attachments?.map(a => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content, 'base64') })),
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
