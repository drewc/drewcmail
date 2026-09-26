/** display helpers */

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

export function shortDate(ts: number) {
  const d = new Date(ts * 1000), now = new Date()
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

export const longDate = (ts: number) =>
  new Date(ts * 1000).toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** "Jane Doe <jane@example.com>" → "jane@example.com" (lower case, for comparing) */
export const addressOf = (addr = '') => (addr.match(/<([^>]*)>/)?.[1] ?? addr).trim().toLowerCase()

/** a From header value: `Name <email>`, the name quoted when it has more than letters, spaces and . ' - */
export const formatAddress = ({ email, name }: { email: string; name: string }) =>
  !name ? email : /^[\p{L}\p{N} .'-]+$/u.test(name) ? `${name} <${email}>` : `"${name.replace(/["\\]/g, '\\$&')}" <${email}>`

/** "Jane Doe <jane@example.com>" → "Jane Doe" */
export const displayName = (addr = '') => addr.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || addr

/** tags the UI shows as state, not as labels */
export const HIDDEN_TAGS = new Set(['unread', 'inbox', 'attachment', 'replied', 'signed', 'encrypted', 'flagged', 'sent', 'passed', 'new', 'important'])

export const humanSize = (n?: number) =>
  n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`
