import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import * as notmuch from './notmuch.ts'
import { BadRequest } from './notmuch.ts'
import { schedulePush, send, sync, syncState, type Outgoing } from './mail.ts'
import * as gmail from './gmail.ts'
import * as imap from './imap.ts'
import * as proton from './proton.ts'
import * as filters from './filters.ts'
import * as activity from './activity.ts'
import { ExecError } from './exec.ts'

/**
 * The @drewc/mail server: a JSON API over notmuch, mbsync and msmtp, and the built
 * SPA (dist/) as static files. No framework — node:http and a route table.
 *
 * Environment:
 *   PORT (8025), HOST (0.0.0.0), STATIC_DIR (dist)
 *   MAIL_USER / MAIL_PASSWORD — HTTP Basic auth on everything when both are set
 *   SYNC_INTERVAL — seconds between automatic mbsync + notmuch new runs (0 = off)
 */

const PORT = Number(process.env.PORT ?? 8025)
const HOST = process.env.HOST ?? '0.0.0.0'
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? 'dist')
const SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL ?? 300)
const AUTH = process.env.MAIL_USER && process.env.MAIL_PASSWORD
  ? Buffer.from('Basic ' + Buffer.from(`${process.env.MAIL_USER}:${process.env.MAIL_PASSWORD}`).toString('base64'))
  : null
const MAX_BODY = 50 * 1024 * 1024

type Req = http.IncomingMessage & { params: Record<string, string>; url_: URL }
type Handler = (req: Req, res: http.ServerResponse) => Promise<unknown>

const routes: [string, RegExp, Handler][] = []
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h])

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  // requiring JSON makes a cross-site form POST impossible (it would need a CORS preflight)
  if (!req.headers['content-type']?.startsWith('application/json')) throw new BadRequest('expected application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw new BadRequest('body too large')
    chunks.push(c)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BadRequest('bad JSON') }
}

const int = (v: string | null, dflt: number, max = Infinity) => {
  const n = v == null ? dflt : Number(v)
  if (!Number.isInteger(n) || n < 0) throw new BadRequest('bad number')
  return Math.min(n, max)
}

// ---- API -----------------------------------------------------------------------------

route('GET', '/api/search', async (req) => {
  const q = req.url_.searchParams
  const sort = q.get('sort') === 'oldest-first' ? 'oldest-first' : 'newest-first'
  return notmuch.search(q.get('q') ?? '', { offset: int(q.get('offset'), 0), limit: int(q.get('limit'), 50, 500), sort })
})

route('GET', '/api/count', async (req) => {
  const queries = req.url_.searchParams.getAll('q')
  const counts = await Promise.all(queries.map(q => notmuch.count(q)))
  return Object.fromEntries(queries.map((q, i) => [q, counts[i]]))
})

route('GET', '/api/tags', () => notmuch.tags())

/** the SPA's version: the entry script dist/index.html loads — hashed, so every build that changes it names another */
route('GET', '/api/version', async () => {
  const index = await fs.readFile(path.join(STATIC_DIR, 'index.html'), 'utf8').catch(() => '')
  return { entry: /<script\b[^>]*\bsrc="([^"]+)"/.exec(index)?.[1] ?? null }
})

route('GET', '/api/identities', () => notmuch.identities())
route('POST', '/api/identities', async (req) => notmuch.setIdentities((await readJson<{ identities: notmuch.Identity[] }>(req)).identities))

route('GET', '/api/thread/:id', (req) => notmuch.showThread(req.params.id))

route('GET', '/api/message/:id/reply', (req) =>
  notmuch.reply(req.params.id, req.url_.searchParams.get('to') === 'sender' ? 'sender' : 'all'))

route('GET', '/api/message/:id/raw', async (req, res) => {
  const raw = await notmuch.messageRaw(req.params.id)
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' })
  res.end(raw)
})

/**
 * An attachment or inline part. The content type comes from notmuch, never the client;
 * only images are shown inline, everything else is a download, and the response is
 * sandboxed so a text/html part cannot run script on this origin.
 */
route('GET', '/api/message/:id/part/:part', async (req, res) => {
  const part = int(req.params.part, 0)
  const [info, body] = await Promise.all([notmuch.partInfo(req.params.id, part), notmuch.partRaw(req.params.id, part)])
  const type = String(info['content-type'] ?? 'application/octet-stream').toLowerCase()
  const filename = String(info['filename'] ?? `part-${part}`)
  const inline = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(type) && req.url_.searchParams.get('download') == null
  res.writeHead(200, {
    'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    'cache-control': 'private, max-age=86400',
  })
  res.end(body)
})

route('POST', '/api/tag', async (req) => {
  const { query, add, remove } = await readJson<{ query: string; add?: string[]; remove?: string[] }>(req)
  await notmuch.tag(query, add ?? [], remove ?? [])
  schedulePush()
  return { ok: true }
})

// filters (afew): list, add/replace (and optionally apply to the mail already there), run once without saving, remove
route('GET', '/api/filters', () => filters.list())
route('POST', '/api/filters', async (req) => {
  const { filter, apply } = await readJson<{ filter: filters.FilterInput; apply?: boolean }>(req)
  const result = await filters.save(filter ?? ({} as filters.FilterInput), apply === true)
  if (result.applied) schedulePush()
  return result
})
route('POST', '/api/filters/apply', async (req) => {
  const { filter } = await readJson<{ filter: filters.FilterInput }>(req)
  const result = await filters.applyOnce(filter ?? ({} as filters.FilterInput))
  if (result.applied) schedulePush()
  return result
})
route('DELETE', '/api/filters/:id', async (req) => { await filters.remove(req.params.id); return { ok: true } })

route('POST', '/api/send', async (req) => send(await readJson<Outgoing>(req)))

route('GET', '/api/sync', async () => syncState)
/** what is running now (and queued), and how the last sync went — for the app's spinner */
route('GET', '/api/activity', async () => ({ activity: activity.list(), sync: syncState }))
route('POST', '/api/sync', async (req) => {
  const { fetch } = await readJson<{ fetch?: boolean }>(req)
  return sync({ fetch: fetch !== false })
})

// Gmail accounts (lieer): list, connect (OAuth start → Google → finish), disconnect
route('GET', '/api/gmail', () => gmail.accounts())
route('POST', '/api/gmail/start', async (req) => {
  const { email, redirect, client } = await readJson<{ email: string; redirect: string; client?: string }>(req)
  return gmail.start(String(email ?? '').trim(), String(redirect ?? ''), client)
})
route('POST', '/api/gmail/finish', async (req) => {
  const { url } = await readJson<{ url: string }>(req)
  // the first pull of a big mailbox takes a long time: it runs in the background
  return gmail.finish(String(url ?? ''), () => { sync().then(s => { if (!s.ok) console.error('first gmail pull:', s.error) }) })
})
route('DELETE', '/api/gmail/:email', async (req) => { await gmail.disconnect(req.params.email); return { ok: true } })

// IMAP/SMTP accounts: find the servers, test and save (writes mbsyncrc/msmtprc), remove
route('GET', '/api/imap', () => imap.accounts())
route('GET', '/api/imap/discover', (req) => imap.discover(req.url_.searchParams.get('email') ?? ''))
route('POST', '/api/imap', async (req) => {
  const account = await imap.save(await readJson<imap.AccountInput>(req))
  sync().then(s => { if (!s.ok) console.error('first imap sync:', s.error) })
  return account
})
route('DELETE', '/api/imap/:id', async (req) => { await imap.remove(req.params.id); return { ok: true } })

// Proton Mail Bridge: on/off, sign-in steps, ports and security, split mode, removal
route('GET', '/api/proton', () => proton.status())
route('POST', '/api/proton/enabled', async (req) => {
  const { enabled } = await readJson<{ enabled: boolean }>(req)
  await proton.setEnabled(!!enabled)
  return proton.status()
})
route('POST', '/api/proton/login', async (req) => {
  const b = await readJson<{ username?: string; password?: string; code?: string; mailboxPassword?: string; verified?: boolean; abort?: boolean }>(req)
  if (b.abort) { await proton.loginAbort(); return { step: 'aborted' } }
  if (b.code !== undefined) return proton.login2fa(String(b.code))
  if (b.mailboxPassword !== undefined) return proton.loginMailbox(String(b.mailboxPassword))
  if (b.verified) return proton.loginVerified()
  return proton.login(String(b.username ?? ''), String(b.password ?? ''))
})
route('POST', '/api/proton/settings', async (req) => {
  const s = await readJson<{ imapPort: number; smtpPort: number; useSSLForImap: boolean; useSSLForSmtp: boolean }>(req)
  return proton.setMailServer({ imapPort: Number(s.imapPort), smtpPort: Number(s.smtpPort), useSSLForImap: !!s.useSSLForImap, useSSLForSmtp: !!s.useSSLForSmtp })
})
route('POST', '/api/proton/users/:id/split', async (req) => {
  const { active } = await readJson<{ active: boolean }>(req)
  await proton.setSplitMode(req.params.id, !!active)
  return proton.status()
})
route('DELETE', '/api/proton/users/:id', async (req) => { await proton.removeUser(req.params.id); return { ok: true } })

// ---- static files (the SPA) ----------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json',
}

async function serveStatic(req: Req, res: http.ServerResponse) {
  let file = path.join(STATIC_DIR, path.normalize(decodeURIComponent(req.url_.pathname)).replace(/^([/\\]|\.\.)+/, ''))
  if (!file.startsWith(STATIC_DIR)) file = path.join(STATIC_DIR, 'index.html')
  let stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) { file = path.join(STATIC_DIR, 'index.html'); stat = await fs.stat(file).catch(() => null) }
  if (!stat) { res.writeHead(404).end('not built: run `pnpm build`'); return }
  const hashed = file.includes(`${path.sep}assets${path.sep}`)
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  res.end(await fs.readFile(file))
}

// ---- the server ----------------------------------------------------------------------

const authorised = (req: http.IncomingMessage) => {
  if (!AUTH) return true
  const got = Buffer.from(req.headers.authorization ?? '')
  return got.length === AUTH.length && timingSafeEqual(got, AUTH)
}

const server = http.createServer(async (req_, res) => {
  const req = req_ as Req
  try {
    if (!authorised(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="drewcmail", charset="UTF-8"' }).end()
      return
    }
    req.url_ = new URL(req.url ?? '/', 'http://localhost')
    if (!req.url_.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
      return await serveStatic(req, res)
    }
    for (const [method, re, h] of routes) {
      const m = method === req.method && re.exec(req.url_.pathname)
      if (!m) continue
      req.params = Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]))
      const result = await h(req, res)
      if (!res.headersSent) sendJson(res, 200, result ?? null)
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    const status = e instanceof BadRequest ? 400 : 500
    if (status === 500) console.error(req.method, req.url, e)
    const error = e instanceof ExecError ? e.stderr.trim() || e.message : (e as Error).message
    if (!res.headersSent) sendJson(res, status, { error })
    else res.end()
  }
})

server.listen(PORT, HOST, () => console.log(`drewcmail on http://${HOST}:${PORT} (static: ${STATIC_DIR}, auth: ${AUTH ? 'basic' : 'none'})`))

proton.boot().catch(e => console.error('proton:', (e as Error).message))
// stop Bridge, then exit — without waiting for idle keep-alive connections (open tabs), which close() would
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { proton.stop().finally(() => { server.closeAllConnections(); server.close(() => process.exit(0)) }) })

// index at start (creates the database on first run), then fetch every SYNC_INTERVAL seconds
sync({ fetch: false }).then(s => console.log('notmuch new:', s.ok ? 'ok' : s.error))
if (SYNC_INTERVAL > 0) setInterval(() => { sync().then(s => { if (!s.ok) console.error('sync:', s.error) }) }, SYNC_INTERVAL * 1000)

