import { promises as fs } from 'node:fs'
import path from 'node:path'
import { exec } from './exec.ts'

/**
 * A thin wrapper over the notmuch CLI. Every query is passed after `--` as a single
 * argument, so user input can never be read as an option.
 */

const NOTMUCH = process.env.NOTMUCH_BIN ?? 'notmuch'
const CONFIG_DIR = process.env.CONFIG_DIR ?? '/config'
const IDENTITIES_FILE = path.join(CONFIG_DIR, 'identities.json')
const FORMAT = ['--format=json', '--format-version=5']

const json = async <T>(args: string[], input?: Buffer): Promise<T> =>
  JSON.parse((await exec(NOTMUCH, args, input)).toString('utf8')) as T

/** `id:"…"` with notmuch's quoting (a literal `"` is doubled) */
export const idQuery = (messageId: string) => `id:"${messageId.replaceAll('"', '""')}"`

/** thread ids are 16 hex digits */
export const threadQuery = (threadId: string) => {
  if (!/^[0-9a-f]{16}$/.test(threadId)) throw new BadRequest('bad thread id')
  return `thread:${threadId}`
}

export class BadRequest extends Error {}

export type Sort = 'newest-first' | 'oldest-first'

export function search(query: string, { offset = 0, limit = 50, sort = 'newest-first' as Sort } = {}) {
  return json<unknown[]>(['search', ...FORMAT, `--sort=${sort}`, `--offset=${offset}`, `--limit=${limit}`, '--', query || '*'])
}

export async function count(query: string, output: 'messages' | 'threads' = 'threads') {
  return Number((await exec(NOTMUCH, ['count', `--output=${output}`, '--', query || '*'])).toString().trim())
}

export function tags() {
  return json<string[]>(['search', '--format=json', '--output=tags', '--', '*'])
}

export function showThread(threadId: string) {
  return json<unknown>(['show', ...FORMAT, '--entire-thread=true', '--include-html', '--', threadQuery(threadId)])
}

/** one part's JSON (content-type, filename, …) — without its content for non-text parts */
export function partInfo(messageId: string, part: number) {
  return json<Record<string, unknown>>(['show', ...FORMAT, `--part=${part}`, '--', idQuery(messageId)])
}

/** one part's decoded bytes */
export function partRaw(messageId: string, part: number) {
  return exec(NOTMUCH, ['show', '--format=raw', `--part=${part}`, '--', idQuery(messageId)])
}

/** the whole message as stored */
export function messageRaw(messageId: string) {
  return exec(NOTMUCH, ['show', '--format=raw', '--', idQuery(messageId)])
}

export function reply(messageId: string, replyTo: 'all' | 'sender' = 'all') {
  return json<unknown>(['reply', ...FORMAT, `--reply-to=${replyTo}`, '--', idQuery(messageId)])
}

const TAG_RE = /^[^\s"()]+$/
export function checkTags(tags: string[]) {
  const bad = tags.find(t => !TAG_RE.test(t))
  if (bad !== undefined) throw new BadRequest(`bad tag: ${JSON.stringify(bad)}`)
}

export async function tag(query: string, add: string[] = [], remove: string[] = []) {
  checkTags([...add, ...remove])
  if (!query) throw new BadRequest('empty query')
  if (!add.length && !remove.length) return
  await exec(NOTMUCH, ['tag', ...add.map(t => `+${t}`), ...remove.map(t => `-${t}`), '--', query])
}

export function indexNew() {
  return exec(NOTMUCH, ['new', '--quiet'])
}

/** store a message (e.g. one just sent) in the maildir and index it */
export function insert(raw: Buffer, folder: string, add: string[], remove: string[]) {
  return exec(NOTMUCH, ['insert', `--folder=${folder}`, '--create-folder', ...add.map(t => `+${t}`), ...remove.map(t => `-${t}`)], raw)
}

async function configGet(key: string): Promise<string[]> {
  try {
    return (await exec(NOTMUCH, ['config', 'get', key])).toString('utf8').split('\n').map(s => s.trim()).filter(Boolean)
  } catch { return [] }
}

/** set a (possibly list-valued) key in the config file and in the database, which lieer reads */
async function configSet(key: string, values: string[]) {
  await exec(NOTMUCH, ['config', 'set', key, ...values])
  await exec(NOTMUCH, ['config', 'set', '--database', key, ...values]).catch(() => {})
}

/** lieer's files in the repository are not mail */
export const LIEER_IGNORE = '/.*[.](json|lock|bak)$/'

/**
 * Before the first lieer pull: lieer gives every message it pulls the new.tags, so
 * they must not be `inbox;unread` (Gmail's labels say what is in the inbox) — fresh
 * mail is tagged `new` and tagNew() sorts it out. Also ignore lieer's JSON files and
 * know the address as ours.
 */
export async function prepareForLieer(email: string) {
  await configSet('new.tags', ['new'])
  await ignore(LIEER_IGNORE)
  await addIdentity(email)
}

/** add a file/directory name (or /regex/) to what `notmuch new` skips */
export async function ignore(pattern: string) {
  const current = await configGet('new.ignore')
  if (!current.includes(pattern)) await configSet('new.ignore', [...current, pattern])
}

/** make an address one of ours, named `name` or like the default address (the first one becomes the default) */
export async function addIdentity(email: string, name = '') {
  const all = await identities()
  if (all.some(i => i.email.toLowerCase() === email.toLowerCase())) return
  await setIdentities([...all, { email, name: name || all[0]?.name || '' }])
}

export type TagRule = { query: string; add: string[]; remove: string[] }

/**
 * After indexing, sort out fresh mail (tag:new): lieer's already carries its Gmail
 * labels; IMAP mail is tagged by folder (`rules`, from imap.ts); anything delivered
 * into the Maildir some other way goes to the inbox unread. It stays `new` for the
 * user's filters (filters.ts) until doneNew().
 */
export async function tagNew(rules: TagRule[] = []) {
  for (const r of rules) {
    if (!r.add.length && !r.remove.length) continue
    await exec(NOTMUCH, ['tag', ...r.add.map(t => `+${t}`), ...r.remove.map(t => `-${t}`), '--', `tag:new and (${r.query})`])
  }
  await exec(NOTMUCH, ['tag', '+inbox', '+unread', '--', 'tag:new and not path:gmail/** and not path:imap/**'])
}

/**
 * Fresh mail is sorted: drop `new`. Through the CLI, so the maildir flags of every
 * message catch up with its tags — afew's tag changes (python bindings) do not sync them.
 */
export function doneNew() {
  return exec(NOTMUCH, ['tag', '-new', '--', 'tag:new'])
}

// ---- identities: the From addresses and the name each one sends with ------------------

/** an address of ours and the display name it sends with; the first one is the default From */
export type Identity = { email: string; name: string }

const EMAIL_RE = /^[^\s@"\\<>,;]+@[^\s@"\\<>,;/]+\.[^\s@"\\<>,;/]+$/
/** a name notmuch-config's template leaves behind — not a name to send with */
const PLACEHOLDER = /^your name$/i

/** notmuch's user.* keys: one name for all addresses */
async function notmuchIdentity() {
  const [name, primary, other] = await Promise.all([configGet('user.name'), configGet('user.primary_email'), configGet('user.other_email')])
  const emails = [...primary, ...other.flatMap(s => s.split(';'))].map(s => s.trim()).filter(Boolean)
  return { name: name[0] ?? '', emails }
}

/**
 * Our addresses, from /config/identities.json. Before that file exists (it is written
 * the first time they change), notmuch's user.* keys, every address with user.name.
 */
export async function identities(): Promise<Identity[]> {
  try { return JSON.parse(await fs.readFile(IDENTITIES_FILE, 'utf8')).identities ?? [] } catch { /* not yet */ }
  const { name, emails } = await notmuchIdentity()
  return emails.map(email => ({ email, name: PLACEHOLDER.test(name) ? '' : name }))
}

/**
 * Save the addresses (the first is the default) and mirror them into notmuch's
 * config — user.primary_email, user.other_email and user.name (the default's) — which
 * `notmuch reply` and lieer read.
 */
export async function setIdentities(input: Identity[]) {
  const list: Identity[] = []
  for (const i of input ?? []) {
    const email = String(i?.email ?? '').trim(), name = String(i?.name ?? '').trim()
    if (!EMAIL_RE.test(email)) throw new BadRequest(`not an email address: ${JSON.stringify(email)}`)
    if (/[\r\n<>]/.test(name)) throw new BadRequest(`a name cannot contain line breaks, < or >: ${JSON.stringify(name)}`)
    if (list.some(x => x.email.toLowerCase() === email.toLowerCase())) throw new BadRequest(`${email} is listed twice`)
    list.push({ email, name })
  }
  if (!list.length) throw new BadRequest('keep at least one address to send from')
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(IDENTITIES_FILE + '.new', JSON.stringify({ identities: list }, null, 2) + '\n')
  await fs.rename(IDENTITIES_FILE + '.new', IDENTITIES_FILE)
  await configSet('user.primary_email', [list[0].email])
  await configSet('user.other_email', list.slice(1).map(i => i.email))
  await configSet('user.name', [list[0].name])
  return list
}
