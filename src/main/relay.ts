// What one chat says to another, spelled once for both directions of the trip:
// written by ChatService into the target's pipe, read back by the mapper when
// the transcript line comes round again. Its own module, with no electron in
// it, so the mapper's offline esbuild harness still bundles.
//
// **The wrapper is in the transcript, and that is the point.** It is what tells
// the receiving model that another agent wrote this rather than the user, and
// what lets the mapper draw the row as `from <name>` on every later read —
// including a reopen, where nothing but the file is left to say who sent it.
// Read unrecognised, either one would be a `you` bubble of markup the user
// never typed, the same lie the interrupt marker, a command's stdout, a task
// notification and a compaction summary were each caught telling.

/** How a turn another chat started ended, as its reply reports it. */
export type ReplyStatus = 'done' | 'failed' | 'stopped'

export interface ChatReply {
  chat: string
  name: string
  status: ReplyStatus
  text: string
}

/** A relayed line, recognised: what to draw and whose name to draw it under. */
export interface RelayedText {
  md: string
  from: string
}

const MESSAGE_RE = /^<chat-message from-chat="([^"]*)" from-name="([^"]*)">\n([\s\S]*)\n<\/chat-message>$/

const REPLY_RE =
  /^<chat-notification chat="([^"]*)" name="([^"]*)" status="(done|failed|stopped)">\n([\s\S]*)\n<\/chat-notification>$/

/** A message from chat `fromId` (called `fromName`) to the chat it is written into. */
export function wrapMessage(fromId: string, fromName: string, text: string): string {
  return `<chat-message from-chat="${escapeAttr(fromId)}" from-name="${escapeAttr(fromName)}">\n${text}\n</chat-message>`
}

/** A reply, delivered into the chat that sent the message it answers. */
export function wrapReply(reply: ChatReply): string {
  const head = `<chat-notification chat="${escapeAttr(reply.chat)}" name="${escapeAttr(reply.name)}" status="${reply.status}">`
  return `${head}\n${reply.text}\n</chat-notification>`
}

/**
 * The row label a reply is drawn under. The status is only spelled out when it
 * is not the ordinary one, so a log of finished replies reads as names.
 */
export function formatReplyLabel(name: string, status: ReplyStatus): string {
  return status === 'done' ? `reply · ${name}` : `reply · ${name} · ${status}`
}

/** Either wrapper, unwrapped; null for anything else. */
export function readRelayed(text: string): RelayedText | null {
  const message = MESSAGE_RE.exec(text)
  if (message) return { md: message[3], from: `from ${unescapeAttr(message[2])}` }
  const reply = REPLY_RE.exec(text)
  if (reply) {
    return { md: reply[4], from: formatReplyLabel(unescapeAttr(reply[2]), reply[3] as ReplyStatus) }
  }
  return null
}

// A chat name is free text, and an id from config.json is only a uuid by
// convention, so both are escaped on the way into an attribute — a quote in a
// name would otherwise end the attribute early and the line would stop matching.
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/\r?\n/g, ' ')
}

function unescapeAttr(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}
