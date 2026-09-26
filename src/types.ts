/** notmuch's JSON (format-version 5), as returned by the server */

export type ThreadSummary = {
  thread: string
  timestamp: number
  date_relative: string
  matched: number
  total: number
  authors: string
  subject: string
  query: [string | null, string | null]
  tags: string[]
}

export type Part = {
  id: number
  'content-type': string
  content?: string | Part[] | { headers: Record<string, string>; body: Part[] }[]
  filename?: string
  'content-id'?: string
  'content-length'?: number
  'content-disposition'?: string
  'content-charset'?: string
}

export type Message = {
  id: string
  match: boolean
  excluded: boolean
  filename: string[]
  timestamp: number
  date_relative: string
  tags: string[]
  headers: Record<string, string>
  body?: Part[]
}

/** a message and its replies */
export type ThreadNode = [Message, ThreadNode[]]
/** `notmuch show` output: a list of threads, each a forest of ThreadNodes */
export type ShowResult = ThreadNode[][]

export type ReplyTemplate = {
  'reply-headers': Record<string, string>
  original: Message
}

/** an address of ours and the display name it sends with; the first one is the default From */
export type Identity = { email: string; name: string }

export type SyncState = { running: boolean; last?: string; ok?: boolean; error?: string }

export type Draft = {
  from?: string
  to?: string
  cc?: string
  bcc?: string
  subject?: string
  text?: string
  inReplyTo?: string
  references?: string
}

export type GmailAccount = { email: string; authorized: boolean; syncing: boolean; last?: string; ok?: boolean; error?: string }

export type Security = 'tls' | 'starttls' | 'none'
export type Server = { host: string; port: number; security: Security; user: string }
export type ImapAccount = {
  id: string; name: string; email: string; imap: Server; smtp: Server; sentFolder: string
  proton?: { userId: string }
  syncing: boolean; last?: string; ok?: boolean; error?: string
}
export type ImapInput = Omit<ImapAccount, 'id' | 'sentFolder' | 'proton' | 'syncing' | 'last' | 'ok' | 'error'> & { id?: string; imapPassword?: string; smtpPassword?: string }
export type Discovery = { source: string; provider?: string; imap: Server; smtp: Server; hint?: string; gmail?: boolean; proton?: boolean }

export type BridgeSettings = { imapPort: number; smtpPort: number; useSSLForImap: boolean; useSSLForSmtp: boolean }
export type ProtonUser = {
  id: string; username: string; state: 'SIGNED_OUT' | 'LOCKED' | 'CONNECTED'; splitMode: boolean
  addresses: string[]; usedBytes: number; totalBytes: number; syncProgress?: number
}
export type ProtonStatus = {
  available: boolean; enabled: boolean; running: boolean; starting: boolean
  error?: string; version?: string; settings?: BridgeSettings; log: string[]; users: ProtonUser[]
}
export type ProtonStep = { step: '2fa' | 'mailbox'; error?: string } | { step: 'hv'; url: string } | { step: 'done'; username: string } | { step: 'aborted' }

/** a filter (afew): mail matching `query` gets `add` and loses `remove`; `criteria` is what the form filled in */
export type FilterCriteria = { from?: string; to?: string; subject?: string; words?: string }
export type MailFilter = { id: string; name: string; query: string; add: string[]; remove: string[]; criteria?: FilterCriteria }
