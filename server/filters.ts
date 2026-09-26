import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { exec } from './exec.ts'
import * as notmuch from './notmuch.ts'
import { BadRequest } from './notmuch.ts'

/**
 * Filters: a notmuch query and the tags to add/remove on mail matching it — trash
 * (+deleted −inbox), archive (−inbox), a label (+list/clojure), a "move" (a label and
 * −inbox). Set up in the web app; /config/filters.json is the list, and from it the
 * server writes afew's config (/config/afew/config, one generic `[Filter.N]` section
 * per filter) — nobody edits it by hand.
 *
 * afew runs on fresh mail during a sync (mail.ts): after `notmuch new` and the folder
 * rules (which put IMAP mail in the inbox, so −inbox means something), before `new` is
 * dropped. That is afew's usual `post-new` hook job, done by the server instead, because
 * the folder rules run after `notmuch new` returns. Mail already in the database is
 * tagged directly with `notmuch tag` — when the filter is saved, or by applyOnce(),
 * which runs a filter once without saving it.
 */

const AFEW = process.env.AFEW_BIN ?? 'afew'
const CONFIG_DIR = process.env.CONFIG_DIR ?? '/config'
const FILTERS_FILE = path.join(CONFIG_DIR, 'filters.json')
/** afew reads $XDG_CONFIG_HOME/afew/config (it has no option for it) */
const AFEW_CONFIG = path.join(CONFIG_DIR, 'afew', 'config')

/** what the form filled in, kept so the filter can be edited the way it was made */
export type Criteria = { from?: string; to?: string; subject?: string; words?: string }
export type Filter = { id: string; name: string; query: string; add: string[]; remove: string[]; criteria?: Criteria }
export type FilterInput = Omit<Filter, 'id'> & { id?: string }

export async function list(): Promise<Filter[]> {
  try { return JSON.parse(await fs.readFile(FILTERS_FILE, 'utf8')).filters ?? [] } catch { return [] }
}

async function store(filters: Filter[]) {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(FILTERS_FILE + '.new', JSON.stringify({ filters }, null, 2) + '\n')
  await fs.rename(FILTERS_FILE + '.new', FILTERS_FILE)
  await writeAfewConfig(filters)
}

/** afew's config is Python's ConfigParser: one line per value, `%` is interpolation, `;` separates tags */
const iniValue = (s: string) => s.replace(/%/g, '%%')

export function afewConfig(filters: Filter[]) {
  const sections = filters.map((f, i) => [
    `[Filter.${i}]`,
    `message = ${iniValue(f.name || f.query)}`,
    `query = ${iniValue(f.query)}`,
    `tags = ${[...f.add.map(t => `+${t}`), ...f.remove.map(t => `-${t}`)].join(';')}`,
  ].join('\n'))
  return `# written by drewcmail from ${FILTERS_FILE} — edit filters in the web app\n\n${sections.join('\n\n')}\n`
}

async function writeAfewConfig(filters: Filter[]) {
  await fs.mkdir(path.dirname(AFEW_CONFIG), { recursive: true })
  await fs.writeFile(AFEW_CONFIG, afewConfig(filters))
}

async function check(f: FilterInput): Promise<Filter> {
  const query = String(f.query ?? '').trim()
  const name = String(f.name ?? '').trim()
  if (!query || query === '*') throw new BadRequest('a filter needs a query')
  if (/[\r\n]/.test(query + name)) throw new BadRequest('one line only')
  const add = [...new Set((f.add ?? []).map(String))], remove = [...new Set((f.remove ?? []).map(String))]
  if (!add.length && !remove.length) throw new BadRequest('choose what the filter does')
  notmuch.checkTags([...add, ...remove])
  if ([...add, ...remove].some(t => t.includes(';'))) throw new BadRequest('tags cannot contain ;')
  // a query notmuch cannot parse fails here rather than in every sync
  await notmuch.count(query)
  return { id: f.id || randomBytes(6).toString('hex'), name, query, add, remove, criteria: f.criteria }
}

/**
 * Add or replace a filter; `apply` also tags the mail already matching it.
 * Returns the filter and how many messages that was.
 */
export async function save(input: FilterInput, apply = false) {
  const f = await check(input)
  const all = await list()
  const i = all.findIndex(x => x.id === f.id)
  if (i >= 0) all[i] = f
  else all.push(f)
  await store(all)
  return { filter: f, applied: apply ? await tagMatching(f) : undefined }
}

/** run a filter once, on the mail matching it now — it is not saved (a saved one: pass it as is) */
export async function applyOnce(input: FilterInput) {
  return { applied: await tagMatching(await check(input)) }
}

/** tag the mail matching the filter now; how many messages that was */
async function tagMatching(f: Filter) {
  const applied = await notmuch.count(f.query, 'messages')
  await notmuch.tag(`(${f.query})`, f.add, f.remove)
  return applied
}

export async function remove(id: string) {
  await store((await list()).filter(f => f.id !== id))
}

/** run the filters over fresh mail (tag:new); false when there are none */
export async function runNew() {
  const filters = await list()
  if (!filters.length) return false
  await writeAfewConfig(filters)
  await exec(AFEW, ['--tag', '--new'], undefined, { timeout: 10 * 60_000, env: { XDG_CONFIG_HOME: CONFIG_DIR } })
  return true
}
