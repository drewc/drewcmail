import { spawn } from 'node:child_process'

export class ExecError extends Error {
  code: number | null
  stderr: string
  constructor(cmd: string, code: number | null, stderr: string) {
    super(`${cmd} exited with ${code}: ${stderr.trim()}`)
    this.code = code
    this.stderr = stderr
  }
}

/**
 * Run a program with an argument vector (never through a shell) and collect its
 * stdout. `input` is written to stdin. Rejects with ExecError on a non-zero exit
 * (or when killed after `timeout` ms). `env` is added to the server's environment;
 * `onStdout` sees the output as it comes (progress).
 */
export function exec(bin: string, args: string[], input?: Buffer | string, { timeout = 0, env = {} as Record<string, string>, onStdout = undefined as ((chunk: Buffer) => void) | undefined } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', env: { ...process.env, ...env } })
    const out: Buffer[] = [], err: Buffer[] = []
    child.stdout.on('data', d => { out.push(d); onStdout?.(d) })
    child.stderr.on('data', d => err.push(d))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new ExecError(bin, code, Buffer.concat(err).toString() || (code === null ? `timed out after ${timeout / 1000}s` : '')))
    })
    child.stdin.on('error', () => { /* the program may exit without reading stdin */ })
    child.stdin.end(input)
  })
}
