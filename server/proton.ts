import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { checkServerIdentity } from 'node:tls'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as activity from './activity.ts'
import * as imap from './imap.ts'
import * as notmuch from './notmuch.ts'
import { BadRequest } from './notmuch.ts'

/**
 * Proton Mail Bridge, built in: the server runs Bridge (`bridge --grpc`, built from
 * source into the image) and drives it through the gRPC API its desktop GUI uses —
 * login with 2FA, mailbox password and human verification, ports and TLS, split
 * mode. Each Proton address Bridge serves becomes an ordinary IMAP/SMTP account
 * (imap.ts) on 127.0.0.1, trusting Bridge's own certificate, so mbsync and msmtp
 * talk to it over STARTTLS/SSL like to any provider.
 *
 * Bridge keeps its secrets in a keychain: here `pass`, with a GPG key made for it on
 * first use. Its settings and keychain live in /config/proton/, its message cache
 * (as big as the mailbox) in /mail/.proton-bridge/.
 */

const BRIDGE = process.env.BRIDGE_BIN ?? '/usr/local/bin/bridge'
const CONFIG_DIR = process.env.CONFIG_DIR ?? '/config'
const MAIL_ROOT = process.env.MAIL_ROOT ?? '/mail'
const DIR = path.join(CONFIG_DIR, 'proton')
const SETTINGS_FILE = path.join(DIR, 'settings.json')
const CERT_DIR = path.join(DIR, 'tls')
const CERT = path.join(CERT_DIR, 'cert.pem')
const CACHE = path.join(MAIL_ROOT, '.proton-bridge')
const ENV = {
  ...process.env,
  GNUPGHOME: path.join(DIR, 'gnupg'),
  PASSWORD_STORE_DIR: path.join(DIR, 'password-store'),
  XDG_CONFIG_HOME: path.join(DIR, 'config'),
  XDG_DATA_HOME: path.join(CACHE, 'data'),
  XDG_CACHE_HOME: path.join(CACHE, 'cache'),
}
const GRPC_CONFIG = path.join(ENV.XDG_CONFIG_HOME, 'protonmail', 'bridge-v3', 'grpcServerConfig.json')
const PROTO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proton', 'bridge.proto')

export const available = () => existsSync(BRIDGE)

// ---- state ---------------------------------------------------------------------------

type Settings = { imapPort: number; smtpPort: number; useSSLForImap: boolean; useSSLForSmtp: boolean }
type User = { id: string; username: string; state: string; splitMode: boolean; usedBytes: number; totalBytes: number; password: Buffer; addresses: string[] }
type Event = Record<string, unknown> & { event?: string }

let child: ChildProcess | null = null
let client: grpc.Client & Record<string, Function> | null = null
let starting: Promise<void> | null = null
let stopping = false
let lastError: string | undefined
let settings: Settings | undefined
let version: string | undefined
const output: string[] = []
const progress = new Map<string, number>()
/** Bridge's syncs in progress, as activities (per user) */
const syncing = new Map<string, ReturnType<typeof activity.begin>>()
/** called when Bridge has new mail for us (a sync of its own finished): mail.ts syncs */
let onMail: () => void = () => {}
export const whenMailArrives = (fn: () => void) => { onMail = fn }

async function readSettings(): Promise<{ enabled: boolean }> {
  try { return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')) } catch { return { enabled: false } }
}

async function writeSettings(s: { enabled: boolean }) {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 })
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(s) + '\n')
}

// ---- the keychain --------------------------------------------------------------------

/** `pass` with a GPG key of its own, without a passphrase: Bridge must start unattended */
async function keychain() {
  if (existsSync(path.join(ENV.PASSWORD_STORE_DIR, '.gpg-id'))) return
  await fs.mkdir(ENV.GNUPGHOME, { recursive: true, mode: 0o700 })
  const gpg = (args: string[]) => run('gpg', ['--batch', '--homedir', ENV.GNUPGHOME, ...args])
  let keys = (await gpg(['--with-colons', '--list-secret-keys'])).toString()
  if (!/^sec:/m.test(keys)) {
    await gpg(['--pinentry-mode', 'loopback', '--passphrase', '', '--quick-gen-key', 'drewcmail Proton Mail Bridge keychain', 'default', 'default', 'never'])
    keys = (await gpg(['--with-colons', '--list-secret-keys'])).toString()
  }
  const fpr = keys.match(/^fpr:+([0-9A-F]{40}):/m)?.[1]
  if (!fpr) throw new Error('could not create the GPG key for the keychain')
  await run('pass', ['init', fpr])
}

function run(bin: string, args: string[]) {
  return new Promise<Buffer>((resolve, reject) => {
    const p = spawn(bin, args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = [], err: Buffer[] = []
    p.stdout.on('data', d => out.push(d))
    p.stderr.on('data', d => err.push(d))
    p.on('error', reject)
    p.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${bin}: ${Buffer.concat(err).toString().trim()}`)))
  })
}

// ---- the Bridge process and its gRPC client -------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function remember(chunk: Buffer) {
  // eslint-disable-next-line no-control-regex
  for (const line of chunk.toString().replace(/\x1b\[[0-9;]*m/g, '').split('\n')) if (line.trim()) output.push(line.trimEnd())
  output.splice(0, Math.max(0, output.length - 40))
}

/** call a unary method: `call('GetUser', { value: id })` */
function call<T = unknown>(method: string, request: object = {}, timeout = 30_000): Promise<T> {
  if (!client) return Promise.reject(new BadRequest('Proton Mail Bridge is not running'))
  return new Promise((resolve, reject) =>
    client![method](request, { deadline: Date.now() + timeout }, (err: grpc.ServiceError | null, res: T) =>
      err ? reject(new Error(`Bridge ${method}: ${err.details || err.message}`)) : resolve(res)))
}

async function connect() {
  const cfg = JSON.parse(await fs.readFile(GRPC_CONFIG, 'utf8')) as { port: number; cert: string; token: string; fileSocketPath: string }
  const def = protoLoader.loadSync(PROTO, { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true })
  const Bridge = (grpc.loadPackageDefinition(def).grpc as grpc.GrpcObject).Bridge as grpc.ServiceClientConstructor
  const token = grpc.credentials.createFromMetadataGenerator((_, cb) => {
    const m = new grpc.Metadata()
    m.add('server-token', cfg.token)
    cb(null, m)
  })
  // Bridge's certificate is for the IP 127.0.0.1; TLS server names cannot be IPs, so name
  // it `localhost` on the wire and check the certificate against 127.0.0.1 ourselves
  const ssl = grpc.credentials.createSsl(Buffer.from(cfg.cert), null, null, {
    checkServerIdentity: (_host, cert) => checkServerIdentity('127.0.0.1', cert),
  })
  const creds = grpc.credentials.combineChannelCredentials(ssl, token)
  const target = cfg.fileSocketPath ? `unix:${cfg.fileSocketPath}` : `127.0.0.1:${cfg.port}`
  const c = new Bridge(target, creds, { 'grpc.ssl_target_name_override': 'localhost', 'grpc.default_authority': 'localhost' }) as unknown as grpc.Client & Record<string, Function>
  client = c
  await call('GuiReady')

  const stream = c.RunEventStream({ ClientPlatform: 'drewcmail' }) as grpc.ClientReadableStream<Event>
  stream.on('data', onEvent)
  stream.on('error', () => { /* Bridge went away: the exit handler restarts it */ })

  // no self-updates inside a container (a new image is the update); All Mail would duplicate every message
  await call('SetIsAutomaticUpdateOn', { value: false })
  await call('SetIsAllMailVisible', { value: false })
  version = (await call<{ value: string }>('Version')).value
  settings = await call<Settings>('MailServerSettings')
  await exportCert()
}

/** Bridge's IMAP/SMTP certificate (self-signed, for 127.0.0.1), for mbsync and msmtp to trust */
async function exportCert() {
  await fs.mkdir(CERT_DIR, { recursive: true, mode: 0o700 })
  await fs.rm(CERT, { force: true })
  await call('ExportTLSCertificates', { value: CERT_DIR })
  for (let i = 0; i < 50 && !existsSync(CERT); i++) await sleep(100)
  await fs.rm(path.join(CERT_DIR, 'key.pem'), { force: true })   // we only need to trust it
  if (!existsSync(CERT)) throw new Error('Bridge did not export its TLS certificate')
}

/** start Bridge (once; concurrent callers share the start) */
export function start(): Promise<void> {
  if (client) return Promise.resolve()
  starting ??= (async () => {
    if (!available()) throw new BadRequest('this image was built without Proton Mail Bridge')
    stopping = false
    lastError = undefined
    await keychain()
    await notmuch.ignore('.proton-bridge')   // Bridge's cache is not mail
    for (const dir of [ENV.XDG_CONFIG_HOME, ENV.XDG_DATA_HOME, ENV.XDG_CACHE_HOME]) await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.rm(GRPC_CONFIG, { force: true })

    const p = spawn(BRIDGE, ['--grpc', '--no-window', '--parent-pid', String(process.pid)], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    child = p
    p.stdout!.on('data', remember)
    p.stderr!.on('data', remember)
    p.on('exit', code => {
      if (child === p) { child = null; client?.close(); client = null }
      if (stopping) return
      lastError = `Bridge stopped (exit ${code}): ${output.slice(-3).join(' | ')}`
      console.error('proton:', lastError)
      // keep it running: try again in a while
      setTimeout(() => { readSettings().then(s => { if (s.enabled && !child) start().catch(() => {}) }) }, 15_000)
    })

    for (let i = 0; i < 600 && !existsSync(GRPC_CONFIG); i++) {
      if (child !== p) throw new Error(lastError ?? 'Bridge stopped while starting')
      await sleep(100)
    }
    if (!existsSync(GRPC_CONFIG)) { p.kill(); throw new Error(`Bridge did not start: ${output.slice(-3).join(' | ')}`) }
    await connect()
    console.log(`proton: Bridge ${version} running`)
    await reconcile().catch(e => console.error('proton:', (e as Error).message))
  })().catch(e => {
    lastError = (e as Error).message
    throw e
  }).finally(() => { starting = null })
  return starting
}

export async function stop() {
  stopping = true
  const p = child
  if (!p) return
  await call('Quit').catch(() => {})
  await Promise.race([new Promise(r => p.once('exit', r)), sleep(10_000)])
  if (child === p) p.kill('SIGKILL')
}

export const running = () => !!client

/** start at server start, when the user has turned Bridge on */
export async function boot() {
  if ((await readSettings()).enabled && available()) await start()
}

export async function setEnabled(enabled: boolean) {
  await writeSettings({ enabled })
  if (enabled) await start()
  else await stop()
}

// ---- events ---------------------------------------------------------------------------

type LoginEvent = { event: string } & Record<string, Record<string, unknown>>
let loginWaiters: ((e: LoginEvent) => void)[] = []
let loginQueue: LoginEvent[] = []

function onEvent(e: Event) {
  const kind = e.event as string
  const inner = e[kind] as Event
  const what = inner?.event as string
  const body = (inner?.[what] ?? {}) as Record<string, unknown>
  switch (kind) {
    case 'login': {
      if (['loginFidoTouchRequested', 'loginFidoTouchCompleted'].includes(what)) return
      const waiter = loginWaiters.shift()
      if (waiter) waiter(inner as LoginEvent)
      else loginQueue.push(inner as LoginEvent)
      return
    }
    case 'user':
      if (what === 'syncProgressEvent') {
        progress.set(String(body.userID), Number(body.progress))
        syncing.get(String(body.userID))?.set(`${Math.floor(Number(body.progress) * 100)}%`)
      }
      if (what === 'syncStartedEvent') {
        progress.set(String(body.userID), 0)
        syncing.get(String(body.userID))?.end()
        syncing.set(String(body.userID), activity.begin('Proton Mail Bridge sync'))
      }
      if (what === 'syncFinishedEvent') {
        progress.delete(String(body.userID))
        syncing.get(String(body.userID))?.end()
        syncing.delete(String(body.userID))
        onMail()
      }
      if (what === 'userChanged' || what === 'toggleSplitModeFinished') reconcile().catch(e => console.error('proton:', (e as Error).message))
      if (what === 'userBadEvent') lastError = `Bridge: ${body.errorMessage}`
      return
    case 'mailServerSettings':
      if (what === 'mailServerSettingsChanged') { settings = body.settings as Settings; reconcile().catch(e => console.error('proton:', (e as Error).message)) }
      if (what === 'error') settingsError = String(body.type)
      if (what === 'changeMailServerSettingsFinished') settingsDone?.()
      return
    case 'keychain':
      if (what === 'hasNoKeychain') lastError = 'Bridge found no usable keychain'
      return
  }
}

function nextLoginEvent(timeout = 120_000): Promise<LoginEvent> {
  const queued = loginQueue.shift()
  if (queued) return Promise.resolve(queued)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { loginWaiters = loginWaiters.filter(w => w !== waiter); reject(new Error('Bridge did not answer')) }, timeout)
    const waiter = (e: LoginEvent) => { clearTimeout(t); resolve(e) }
    loginWaiters.push(waiter)
  })
}

// ---- users and their IMAP accounts ---------------------------------------------------

const users = async () => (await call<{ users: User[] }>('GetUserList')).users

/**
 * Make the IMAP accounts match what Bridge serves: one per signed-in user (combined
 * mode) or one per address (split mode), on the current ports, with the current
 * Bridge password. Accounts are re-tested and rewritten only when something changed.
 */
function reconcile(): Promise<void> {
  // events can ask for this while it runs: one at a time
  const run = reconciling.then(reconcileNow, reconcileNow)
  reconciling = run.catch(() => {})
  return run
}
let reconciling: Promise<unknown> = Promise.resolve()

async function reconcileNow() {
  if (!client || !settings) return
  const list = await users()
  const existing = (await imap.accounts()).filter(a => a.proton)
  const s = settings
  const server = (port: number, ssl: boolean, user: string) => ({ host: '127.0.0.1', port, security: ssl ? 'tls' as const : 'starttls' as const, user })
  const wanted = new Set<string>()
  for (const u of list.filter(u => u.state === 'CONNECTED')) {
    const password = Buffer.from(u.password).toString('utf8')
    for (const email of u.splitMode ? u.addresses : u.addresses.slice(0, 1)) {
      const old = existing.find(a => a.proton!.userId === u.id && a.email.toLowerCase() === email.toLowerCase())
      const imapServer = server(s.imapPort, s.useSSLForImap, email)
      const smtpServer = server(s.smtpPort, s.useSSLForSmtp, email)
      const saved = old ? await fs.readFile(path.join(CONFIG_DIR, 'passwords', `${old.id}.imap`), 'utf8').catch(() => '') : ''
      const same = old && saved === password && JSON.stringify([old.imap, old.smtp]) === JSON.stringify([imapServer, smtpServer]) && old.ca === CERT
      if (old) wanted.add(old.id)
      if (same) continue
      const a = await imap.saveAccount({
        id: old?.id, name: old?.name || u.username, email, imap: imapServer, smtp: smtpServer,
        imapPassword: password, smtpPassword: password, proton: { userId: u.id }, ca: CERT,
      })
      wanted.add(a.id)
    }
  }
  // addresses that went away (split mode off, user removed or signed out)
  for (const a of existing) if (!wanted.has(a.id)) await imap.remove(a.id, { proton: true })
}

export async function status() {
  const on = (await readSettings()).enabled
  let list: User[] = []
  if (client) list = await users().catch(() => [])
  return {
    available: available(),
    enabled: on,
    running: !!client,
    starting: !!starting,
    error: lastError,
    version,
    settings,
    log: client ? [] : output.slice(-8),
    users: list.map(u => ({
      id: u.id, username: u.username, state: u.state, splitMode: u.splitMode,
      addresses: u.addresses, usedBytes: u.usedBytes, totalBytes: u.totalBytes,
      syncProgress: progress.get(u.id),
    })),
  }
}

// ---- login -------------------------------------------------------------------------------

/** the login in progress: Bridge's steps need the username (and the password again after human verification) */
let pending: { username: string; password: string } | null = null
/**
 * Bridge wants the password field (protobuf `bytes`) to hold base64 *text*; a JS string
 * there would itself be taken as base64 and decoded, so send the text's bytes
 */
const b64 = (s: string) => Buffer.from(Buffer.from(s).toString('base64'))

export type LoginStep =
  | { step: '2fa' | 'mailbox'; error?: string }
  | { step: 'hv'; url: string }
  | { step: 'done'; username: string }

const LOGIN_ERRORS: Record<string, string> = {
  USERNAME_PASSWORD_ERROR: 'Wrong username or password',
  FREE_USER: 'Bridge needs a paid Proton plan',
  CONNECTION_ERROR: 'Cannot reach Proton',
  TFA_ERROR: 'Wrong two-factor code',
  TFA_ABORT: 'Sign-in cancelled',
  TWO_PASSWORDS_ERROR: 'Wrong mailbox password',
  TWO_PASSWORDS_ABORT: 'Sign-in cancelled',
  HV_ERROR: 'Human verification failed — try again',
  FIDO_ERROR: 'Security key sign-in failed',
}

async function answer(): Promise<LoginStep> {
  const e = await nextLoginEvent()
  const body = e[e.event] ?? {}
  switch (e.event) {
    case 'tfaRequested':
    case 'tfaOrFidoRequested':
      return { step: '2fa' }
    case 'twoPasswordRequested':
      return { step: 'mailbox' }
    case 'hvRequested':
      return { step: 'hv', url: String(body.hvUrl) }
    case 'fidoRequested':
      await call('LoginAbort', { username: pending?.username ?? '' }).catch(() => {})
      pending = null
      throw new BadRequest('This account signs in only with a security key, which cannot reach a server in a container. Add an authenticator app (TOTP) to your Proton account and try again.')
    case 'finished':
    case 'alreadyLoggedIn': {
      const username = pending?.username ?? ''
      pending = null
      await reconcile()
      onMail()
      return { step: 'done', username }
    }
    case 'error': {
      const type = String(body.type)
      const message = [LOGIN_ERRORS[type] ?? type, body.message].filter(Boolean).join(': ')
      // Bridge lets you retry a wrong code or mailbox password in the same login
      if (type === 'TFA_ERROR') return { step: '2fa', error: message }
      if (type === 'TWO_PASSWORDS_ERROR') return { step: 'mailbox', error: message }
      pending = null
      throw new BadRequest(message)
    }
    default:
      return answer()
  }
}

export async function login(username: string, password: string): Promise<LoginStep> {
  if (!username.trim() || !password) throw new BadRequest('enter your Proton username and password')
  await start()
  loginQueue = []
  pending = { username: username.trim(), password }
  await call('Login', { username: pending.username, password: b64(password) })
  return answer()
}

function needPending() {
  if (!pending) throw new BadRequest('no sign-in in progress — start again')
  return pending
}

export async function login2fa(code: string) {
  const p = needPending()
  await call('Login2FA', { username: p.username, password: b64(code.replace(/\s/g, '')) })
  return answer()
}

export async function loginMailbox(mailboxPassword: string) {
  const p = needPending()
  await call('Login2Passwords', { username: p.username, password: b64(mailboxPassword) })
  return answer()
}

/** after the user solved the CAPTCHA at the hv URL */
export async function loginVerified() {
  const p = needPending()
  await call('Login', { username: p.username, password: b64(p.password), useHvDetails: true })
  return answer()
}

export async function loginAbort() {
  if (pending) await call('LoginAbort', { username: pending.username }).catch(() => {})
  pending = null
}

// ---- configuration -------------------------------------------------------------------

let settingsDone: (() => void) | undefined
let settingsError: string | undefined

const SETTINGS_ERRORS: Record<string, string> = {
  IMAP_PORT_STARTUP_ERROR: 'the IMAP port is in use',
  SMTP_PORT_STARTUP_ERROR: 'the SMTP port is in use',
  IMAP_PORT_CHANGE_ERROR: 'could not change the IMAP port',
  SMTP_PORT_CHANGE_ERROR: 'could not change the SMTP port',
  IMAP_CONNECTION_MODE_CHANGE_ERROR: 'could not change the IMAP security',
  SMTP_CONNECTION_MODE_CHANGE_ERROR: 'could not change the SMTP security',
}

/** ports and SSL/STARTTLS of Bridge's IMAP and SMTP servers; the accounts follow */
export async function setMailServer(s: Settings) {
  for (const port of [s.imapPort, s.smtpPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new BadRequest('ports must be between 1024 and 65535')
  if (s.imapPort === s.smtpPort) throw new BadRequest('IMAP and SMTP need different ports')
  settingsError = undefined
  const done = new Promise<void>(r => { settingsDone = r })
  await call('SetMailServerSettings', { imapPort: s.imapPort, smtpPort: s.smtpPort, useSSLForImap: !!s.useSSLForImap, useSSLForSmtp: !!s.useSSLForSmtp })
  await Promise.race([done, sleep(20_000)])
  if (settingsError) throw new BadRequest(`Bridge: ${SETTINGS_ERRORS[settingsError] ?? settingsError}`)
  settings = await call<Settings>('MailServerSettings')
  await reconcile()
  return settings
}

/** split mode: one account per Proton address instead of one for all */
export async function setSplitMode(userId: string, active: boolean) {
  await call('SetUserSplitMode', { userID: userId, active })
  for (let i = 0; i < 100; i++) {
    const u = (await users()).find(u => u.id === userId)
    if (!u || u.splitMode === active) break
    await sleep(200)
  }
  await reconcile()
}

/** sign a user out of Bridge and forget their accounts here (the mail stays) */
export async function removeUser(userId: string) {
  await call('RemoveUser', { value: userId })
  for (const a of (await imap.accounts()).filter(a => a.proton?.userId === userId)) await imap.remove(a.id, { proton: true })
}

/** sync status for mail.ts: Proton accounts cannot sync while Bridge is down */
export const skipReason = (a: imap.ImapAccount) =>
  a.proton && !client ? (starting ? 'Proton Mail Bridge is starting' : 'Proton Mail Bridge is not running — turn it on in Accounts') : undefined

