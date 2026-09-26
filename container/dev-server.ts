import { spawn, type ChildProcess } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'

/**
 * Development (container/dev.sh): run the server and restart it whenever something
 * under server/ changes. Not `bun --watch`: it loses a file an editor saves by
 * renaming a new copy over it (and ignores that file from then on); watching the
 * directory does not. A restart is SIGTERM to the server's whole process group — the
 * server stops Bridge and exits, and gmi/mbsync/notmuch runs stop with it (left alone,
 * they would hold the repository and database locks against the new server) — then a
 * fresh start.
 */

const DIR = path.resolve(import.meta.dir, '..', 'server')
const WATCHED = /\.(ts|proto)$/

let child: ChildProcess | null = null

function start() {
  // its own process group, so a restart stops what it started too
  const c = spawn(process.execPath, [path.join(DIR, 'index.ts')], { stdio: 'inherit', detached: true })
  child = c
  c.on('exit', (code, signal) => {
    if (child !== c) return
    child = null
    console.log(`dev: server exited (${signal ?? code}) — fix it and save; it starts again on the next change`)
  })
}

function stop(): Promise<void> {
  const c = child
  child = null
  if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve()
  const group = (signal: NodeJS.Signals) => { try { process.kill(-c.pid!, signal) } catch { /* all gone */ } }
  return new Promise(resolve => {
    const kill = setTimeout(() => group('SIGKILL'), 10_000)
    c.once('exit', () => {
      clearTimeout(kill)
      group('SIGKILL')   // whatever ignored the SIGTERM
      resolve()
    })
    group('SIGTERM')
  })
}

let timer: Timer | undefined
let restarting: Promise<void> = Promise.resolve()
watch(DIR, { recursive: true }, (_event, file) => {
  if (!file || !WATCHED.test(file)) return
  // an editor's save is several events; one restart per burst, never two at once
  clearTimeout(timer)
  timer = setTimeout(() => {
    restarting = restarting.then(async () => {
      console.log(`dev: server/${file} changed — restarting`)
      await stop()
      start()
    })
  }, 200)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop().finally(() => process.exit(0)) })

start()
