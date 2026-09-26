import type { BridgeSettings, ProtonStatus, ProtonStep, Discovery, Draft, GmailAccount, ImapAccount, ImapInput, Identity, MailFilter, ReplyTemplate, ShowResult, SyncState, ThreadSummary } from './types.ts'

export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({ error: res.statusText }))
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText)
  return data as T
}

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()

const mid = (id: string) => encodeURIComponent(id)

export const api = {
  search: (q: string, offset = 0, limit = 50) => call<ThreadSummary[]>('GET', `/api/search?${qs({ q, offset, limit })}`),
  count: (queries: string[]) =>
    call<Record<string, number>>('GET', `/api/count?${new URLSearchParams(queries.map(q => ['q', q]))}`),
  tags: () => call<string[]>('GET', '/api/tags'),
  version: () => call<{ entry: string | null }>('GET', '/api/version'),
  identities: () => call<Identity[]>('GET', '/api/identities'),
  identitiesSave: (identities: Identity[]) => call<Identity[]>('POST', '/api/identities', { identities }),
  thread: (id: string) => call<ShowResult>('GET', `/api/thread/${id}`),
  reply: (id: string, to: 'all' | 'sender' = 'all') => call<ReplyTemplate>('GET', `/api/message/${mid(id)}/reply?to=${to}`),
  tag: (query: string, add: string[] = [], remove: string[] = []) => call<{ ok: true }>('POST', '/api/tag', { query, add, remove }),
  send: (draft: Draft & { from: string; attachments?: { filename: string; contentType: string; content: string }[] }) =>
    call<{ messageId: string }>('POST', '/api/send', draft),
  syncState: () => call<SyncState>('GET', '/api/sync'),
  sync: () => call<SyncState>('POST', '/api/sync', {}),
  gmailAccounts: () => call<GmailAccount[]>('GET', '/api/gmail'),
  gmailStart: (email: string, redirect: string, client?: string) => call<{ url: string }>('POST', '/api/gmail/start', { email, redirect, client }),
  gmailFinish: (url: string) => call<{ email: string }>('POST', '/api/gmail/finish', { url }),
  gmailDisconnect: (email: string) => call<{ ok: true }>('DELETE', `/api/gmail/${encodeURIComponent(email)}`),
  imapAccounts: () => call<ImapAccount[]>('GET', '/api/imap'),
  imapDiscover: (email: string) => call<Discovery>('GET', `/api/imap/discover?${qs({ email })}`),
  imapSave: (account: ImapInput) => call<ImapAccount>('POST', '/api/imap', account),
  imapRemove: (id: string) => call<{ ok: true }>('DELETE', `/api/imap/${encodeURIComponent(id)}`),
  proton: () => call<ProtonStatus>('GET', '/api/proton'),
  protonEnable: (enabled: boolean) => call<ProtonStatus>('POST', '/api/proton/enabled', { enabled }),
  protonLogin: (body: { username?: string; password?: string; code?: string; mailboxPassword?: string; verified?: boolean; abort?: boolean }) =>
    call<ProtonStep>('POST', '/api/proton/login', body),
  protonSettings: (s: BridgeSettings) => call<BridgeSettings>('POST', '/api/proton/settings', s),
  protonSplit: (id: string, active: boolean) => call<ProtonStatus>('POST', `/api/proton/users/${encodeURIComponent(id)}/split`, { active }),
  protonRemove: (id: string) => call<{ ok: true }>('DELETE', `/api/proton/users/${encodeURIComponent(id)}`),
  filters: () => call<MailFilter[]>('GET', '/api/filters'),
  filterSave: (filter: Omit<MailFilter, 'id'> & { id?: string }, apply: boolean) =>
    call<{ filter: MailFilter; applied?: number }>('POST', '/api/filters', { filter, apply }),
  filterApply: (filter: Omit<MailFilter, 'id'>) => call<{ applied: number }>('POST', '/api/filters/apply', { filter }),
  filterRemove: (id: string) => call<{ ok: true }>('DELETE', `/api/filters/${encodeURIComponent(id)}`),
  partUrl: (id: string, part: number, download = false) => `/api/message/${mid(id)}/part/${part}${download ? '?download' : ''}`,
  rawUrl: (id: string) => `/api/message/${mid(id)}/raw`,
}

/** `id:"…"` for tagging one message */
export const idQuery = (id: string) => `id:"${id.replaceAll('"', '""')}"`
export const threadQuery = (id: string) => `thread:${id}`
