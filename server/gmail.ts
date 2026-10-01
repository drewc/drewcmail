import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { exec, ExecError } from './exec.ts'
import * as activity from './activity.ts'
import * as notmuch from './notmuch.ts'
import { BadRequest } from './notmuch.ts'

/**
 * Gmail through lieer (`gmi`, https://lieer.gaute.vetsj.com): each account is a lieer
 * repository in /mail/gmail/<address>/, synced with the Gmail API — labels ⇄ tags.
 *
 * lieer's own `gmi auth` runs a local web server for the OAuth redirect, which is
 * awkward inside a container, so the OAuth flow is done here instead: the redirect
 * comes back to the web app (a loopback address, allowed for Google's "desktop"
 * clients), the app hands the code to finish(), and we write the credentials file
 * lieer expects (.credentials.gmailieer.json — it refreshes the token itself).
 */

const GMI = process.env.GMI_BIN ?? 'gmi'
const MAIL_ROOT = process.env.MAIL_ROOT ?? '/mail'
export const GMAIL_DIR = path.join(MAIL_ROOT, 'gmail')
const CREDENTIALS = '.credentials.gmailieer.json'
const CONFIG = '.gmailieer.json'
/** lieer's sync state: last_historyId stays 0 until the first full pull completes */
const STATE = '.state.gmailieer.json'
/** an interrupted first pull's progress: `gmi pull --resume` carries on from it instead of starting over */
const RESUME = '.resume-pull.gmailieer.json'

/** the first full pull has completed (before that there is nothing to push: lieer refuses every change) */
async function pulledOnce(email: string) {
  try { return JSON.parse(await fs.readFile(path.join(repo(email), STATE), 'utf8')).last_historyId > 0 } catch { return false }
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.modify',
]
const AUTH_URI = 'https://accounts.google.com/o/oauth2/auth'
const TOKEN_URI = 'https://oauth2.googleapis.com/token'

/** lieer's public "installed app" client (lieer/remote.py); override with GMAIL_CLIENT_ID/SECRET or per account */
const DEFAULT_CLIENT = {
  id: process.env.GMAIL_CLIENT_ID ?? '753933720722-ju82fu305lii0v9rdo6mf9hj40l5juv0.apps.googleusercontent.com',
  secret: process.env.GMAIL_CLIENT_SECRET ?? '8oudEG0Tvb7YI2V0ykp2Pzz9',
}

const EMAIL_RE = /^[^\s/@"\\]+@[^\s/@"\\]+\.[^\s/@"\\]+$/
const repo = (email: string) => {
  if (!EMAIL_RE.test(email) || email.includes('..')) throw new BadRequest('not an email address')
  return path.join(GMAIL_DIR, email.toLowerCase())
}

// ---- accounts ------------------------------------------------------------------------

type Status = { syncing: boolean; last?: string; ok?: boolean; error?: string }
const status = new Map<string, Status>()

export type Account = { email: string; authorized: boolean } & Status

export async function accounts(): Promise<Account[]> {
  const names = await fs.readdir(GMAIL_DIR).catch(() => [] as string[])
  return names.filter(n => existsSync(path.join(GMAIL_DIR, n, CONFIG))).sort().map(email => ({
    email,
    authorized: existsSync(path.join(GMAIL_DIR, email, CREDENTIALS)),
    ...(status.get(email) ?? { syncing: false }),
  }))
}

/** the Gmail account a From: address belongs to, if any */
export async function accountFor(from: string) {
  const addr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase()
  return (await accounts()).find(a => a.authorized && a.email === addr)
}

/** lieer fails with a Python traceback: its last line says what went wrong */
function lieerError(e: unknown) {
  const lines = (e instanceof ExecError ? e.stderr : (e as Error).message).trim().split('\n')
  const error = lines[lines.length - 1] || (e as Error).message
  return /invalid_grant|RefreshError/.test(error) ? 'Google refused the saved sign-in (revoked or expired) — sign in again in Accounts' : error
}

/**
 * lieer's output without a terminal (--no-progress): a phase is `receiving metadata (209395) ...`
 * then a dot per 10 items and `done: …`; other lines (`remote: waiting 3.0 seconds..`,
 * `push: …`) are notes. Returns a stdout handler that says where it is (`set`) and logs
 * the lines worth keeping.
 */
export function lieerProgress(email: string, set: (detail: string) => void) {
  let buf = ''
  let phase: { desc: string; total?: number; dots: number } | null = null
  const log = (line: string) => { if (!/batch request size/.test(line)) console.log(`gmi ${email}: ${line}`) }
  const show = () => {
    if (!phase) return
    const done = phase.dots * 10
    // no total, or a placeholder one (lieer's full pull starts "fetching messages (1)"): just count
    if (!phase.total || phase.total <= 1 || done > phase.total) return set(done ? `${phase.desc}: ${done.toLocaleString('en')}…` : `${phase.desc}…`)
    set(`${phase.desc}: ${done.toLocaleString('en')} of ${phase.total.toLocaleString('en')} (${Math.floor((done / phase.total) * 100)}%)`)
  }
  return (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    for (;;) {
      const dots = /^\.+/.exec(buf)
      if (dots) {
        if (phase) { phase.dots += dots[0].length; show() }
        buf = buf.slice(dots[0].length)
        continue
      }
      const start = /^([^.\n]*?) (?:\((\d+)\) )?\.\.\./.exec(buf)
      if (start) {
        phase = { desc: start[1].trim(), total: start[2] ? Number(start[2]) : undefined, dots: 0 }
        log(`${phase.desc}${phase.total ? ` (${phase.total})` : ''}`)
        show()
        buf = buf.slice(start[0].length)
        continue
      }
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      if (line.startsWith('done:')) { log(`${phase?.desc ?? ''} ${line}`); phase = null; continue }
      log(line)
      set(line)
    }
  }
}

async function run(email: string, action: 'push' | 'pull') {
  const s: Status = { ...(status.get(email) ?? {}), syncing: true }
  status.set(email, s)
  try {
    const resume = action === 'pull' && existsSync(path.join(repo(email), RESUME)) ? ['--resume'] : []
    await activity.track(`Gmail ${action} · ${email}`, set =>
      exec(GMI, [action, ...resume, '-C', repo(email), '--no-progress'], undefined, { onStdout: lieerProgress(email, set) }))
    Object.assign(s, { ok: true, error: undefined })
  } catch (e) {
    const error = lieerError(e)
    Object.assign(s, { ok: false, error })
    throw new Error(error)
  } finally {
    Object.assign(s, { syncing: false, last: new Date().toISOString() })
  }
}

/**
 * Pull new mail and label changes for every account. A pull touches only messages that
 * changed in Gmail; for those Gmail wins whichever runs first (a push skips a message
 * changed remotely since the last pull), so new mail need not wait for pushes. An
 * interrupted first download resumes (`--resume`) rather than starting over.
 */
export async function pullAll() {
  const errors: string[] = []
  for (const a of (await accounts()).filter(a => a.authorized))
    await run(a.email, 'pull').catch(e => errors.push(`${a.email}: ${(e as Error).message}`))
  if (errors.length) throw new Error(errors.join('\n'))
}

/**
 * Push local tag changes for every account — right after a pull, so few messages have
 * changed remotely meanwhile (each one that has stops lieer saving its push point, and
 * the next push reviews everything again). `yieldTo()` true between accounts stops early:
 * mail is waiting to be fetched (the sync after it pushes again).
 */
export async function pushAll(yieldTo: () => boolean = () => false) {
  const errors: string[] = []
  for (const a of (await accounts()).filter(a => a.authorized)) {
    if (yieldTo()) break
    // until its first download completes, lieer sees every message as changed remotely and pushes
    // nothing — after fetching metadata for all of them, every time
    if (!await pulledOnce(a.email)) continue
    await run(a.email, 'push').catch(e => errors.push(`${a.email}: ${(e as Error).message}`))
  }
  if (errors.length) throw new Error(errors.join('\n'))
}

/** send through the Gmail API: Gmail files it in Sent, the next pull brings it here */
export async function send(email: string, raw: Buffer) {
  try {
    await exec(GMI, ['send', '-t', '-C', repo(email), '--quiet'], raw)
  } catch (e) { throw new Error(`Gmail: ${lieerError(e)}`) }
}

/** stop syncing an account: forget its credentials, keep its mail */
export async function disconnect(email: string) {
  await fs.rm(path.join(repo(email), CREDENTIALS), { force: true })
  status.delete(email.toLowerCase())
}

// ---- OAuth ---------------------------------------------------------------------------

type Client = { id: string; secret: string }
type Pending = { email: string; verifier: string; redirect: string; client: Client; expires: number }
const pending = new Map<string, Pending>()
const b64url = (b: Buffer) => b.toString('base64url')

/** a pasted client_secret.json (Google Cloud → Credentials → OAuth client ID → Desktop app) */
function parseClient(json?: string): Client {
  if (!json?.trim()) return DEFAULT_CLIENT
  let c: { installed?: Record<string, string>; web?: Record<string, string> }
  try { c = JSON.parse(json) } catch { throw new BadRequest('the OAuth client is not valid JSON') }
  const inner = c.installed ?? c.web
  if (!inner?.client_id || !inner?.client_secret) throw new BadRequest('the OAuth client JSON has no client_id / client_secret')
  return { id: inner.client_id, secret: inner.client_secret }
}

/** step 1: the Google consent URL. `redirect` is where Google sends the browser back to — the web app */
export function start(email: string, redirect: string, clientJson?: string) {
  repo(email)
  let url: URL
  try { url = new URL(redirect) } catch { throw new BadRequest('bad redirect') }
  if (!/^https?:$/.test(url.protocol)) throw new BadRequest('bad redirect')
  const now = Date.now()
  for (const [k, p] of pending) if (p.expires < now) pending.delete(k)

  const state = b64url(randomBytes(24))
  const verifier = b64url(randomBytes(48))
  const client = parseClient(clientJson)
  pending.set(state, { email: email.toLowerCase(), verifier, redirect: url.href, client, expires: now + 15 * 60_000 })
  const auth = new URL(AUTH_URI)
  auth.search = new URLSearchParams({
    client_id: client.id,
    redirect_uri: url.href,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',            // always return a refresh token
    login_hint: email,
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  }).toString()
  return { url: auth.href }
}

/**
 * step 2: `returned` is the URL Google redirected to (the app passes on its own
 * location, or what the user pasted). Exchange the code, set the repository up,
 * and start the first pull in the background.
 */
export async function finish(returned: string, onReady: (email: string) => void) {
  let params: URLSearchParams
  try { params = new URL(returned.trim()).searchParams } catch { throw new BadRequest('paste the whole address, starting with http') }
  const err = params.get('error')
  if (err) throw new BadRequest(`Google said: ${err}`)
  const p = pending.get(params.get('state') ?? '')
  const code = params.get('code')
  if (!p || !code) throw new BadRequest('this sign-in has expired or was already used — start again')
  pending.delete(params.get('state')!)

  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: p.client.id, client_secret: p.client.secret,
      redirect_uri: p.redirect, grant_type: 'authorization_code', code_verifier: p.verifier,
    }),
  })
  const token = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !token.refresh_token) throw new BadRequest(`token exchange failed: ${token.error_description ?? token.error ?? 'no refresh token'}`)

  const dir = repo(p.email)
  await fs.mkdir(GMAIL_DIR, { recursive: true })
  if (!existsSync(path.join(dir, CONFIG))) await exec(GMI, ['init', '--no-auth', '-C', dir, '--quiet', p.email])
  // the format google.oauth2.credentials.Credentials.from_authorized_user_file() reads
  await fs.writeFile(path.join(dir, CREDENTIALS), JSON.stringify({
    token: token.access_token,
    refresh_token: token.refresh_token,
    token_uri: TOKEN_URI,
    client_id: p.client.id,
    client_secret: p.client.secret,
    scopes: SCOPES,
    expiry: new Date(Date.now() + (token.expires_in ?? 0) * 1000).toISOString().replace(/\.\d+Z$/, ''),
  }), { mode: 0o600 })
  // our UI's delete is the `deleted` tag; `new` is our transient tag for fresh mail, never a label
  await exec(GMI, ['set', '-C', dir, '--local-trash-tag', 'deleted', '--ignore-tags-local', 'new'])
  await notmuch.prepareForLieer(p.email)

  status.set(p.email, { syncing: true })
  onReady(p.email)
  return { email: p.email }
}
