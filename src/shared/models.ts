// How a Claude model id is spelled for a person to read.
//
// This lives in `@shared` rather than beside either caller because **both**
// processes name models: the renderer paints the header chip, the composer's
// status line and the picker, while `chatMapper` writes the `model · a → b`
// divider into the log itself. Two copies of a formatting rule drift, and the
// two surfaces disagreeing about what is answering you is exactly the confusion
// this exists to end.
//
// The rule: a capitalised family word followed by its generation, with the id's
// dashes read as a decimal point.
//
//   claude-opus-5-20260115    → Opus 5
//   claude-sonnet-4-5-…       → Sonnet 4.5
//   claude-3-5-sonnet-…       → Sonnet 3.5   (older ids put the digits first)
//   opus                      → Opus         (an alias genuinely has no number)
//
// Anything with no family word in it is handed back exactly as it arrived —
// inventing a name for a model this app has never heard of is how a chip ends
// up lying about what is answering.

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'instant'] as const

/**
 * The family and generation an id names, or `null` when it names neither.
 *
 * Split out of `parse` because two questions are asked of one id and both have
 * to be answered by the same reading of it: what to *call* it, and whether it is
 * the same model as some other spelling (see `sameModel`). A second tokeniser
 * would let the header and the "has this drifted?" test disagree about `fable`
 * and `claude-fable-5-20260101`, which is the disagreement this file exists to
 * prevent.
 */
interface ModelKey {
  family: string
  /** `5`, `4.5`, or empty for an alias that genuinely carries no generation */
  version: string
}

function key(id: string | null | undefined): ModelKey | null {
  const cleaned = (id ?? '')
    .trim()
    .toLowerCase()
    // The vendor prefix, the release date and a `-latest`/`-v2:0` pin are not
    // part of the name — and the date is most of what made the raw id
    // unreadable at 11.5px in the header.
    .replace(/^(claude-|anthropic[./])+/, '')
    // Repeated, not once: a Bedrock-style id carries two of these back to back
    // (`…-20250514-v1:0`), and stripping one leaves the date to be read as part
    // of the version — `Sonnet 4.20250514`.
    .replace(/([-@:](\d{8}|latest|v\d+(:\d+)?))+$/, '')
  const tokens = cleaned.split(/[-_.]/).filter(Boolean)
  const at = tokens.findIndex((t) => (FAMILIES as readonly string[]).includes(t))
  if (at < 0) return null
  // Digits on whichever side of the family word carries them.
  const trailing = digitRun(tokens, at + 1, 1)
  const version = trailing.length ? trailing : digitRun(tokens, at - 1, -1)
  return { family: tokens[at], version: version.join('.') }
}

/**
 * Parse an id into its display name, or `null` when it is not a model id at
 * all. The null is load-bearing: the picker feeds this both resolved ids and
 * free prose (`FALLBACK_MODELS` carries "whatever the CLI is configured for" as
 * a subtitle), and a parser that answers something for every input would put
 * that sentence in the chip.
 */
function parse(id: string): string | null {
  const k = key(id)
  if (!k) return null
  const family = k.family[0].toUpperCase() + k.family.slice(1)
  return k.version ? `${family} ${k.version}` : family
}

/**
 * Do these two spellings name the same model?
 *
 * The question is asked of an *alias* against a *resolved id* — `fable` against
 * `claude-fable-5-20260101` — because the two halves of a chat's model come from
 * different places: what `--model` and `set_model` are given (an alias, which is
 * what the CLI accepts back) against what the process reports (always resolved).
 * A raw `!==` between those is what made a model change look like it happened on
 * every turn.
 *
 * Two answers are deliberately "yes":
 *
 * - **An alias with no generation matches every generation of its family.**
 *   `opus` *means* the latest Opus, so `opus` against `Opus 4.5` is agreement,
 *   not drift — and treating it as drift would have the app re-sending
 *   `set_model opus` before every turn forever.
 * - **Anything unreadable matches.** `default`, empty, and an id with no family
 *   word in it (a Bedrock ARN, a name this app has never heard of) return `null`
 *   from `key`, and the honest answer for "is this the same model?" when neither
 *   side can be read is that we do not know. Callers act on a `false`, so an
 *   unknown must never produce one.
 */
export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = key(a)
  const y = key(b)
  if (!x || !y) return true
  if (x.family !== y.family) return false
  if (!x.version || !y.version) return true
  return x.version === y.version
}

/**
 * The consecutive numeric tokens from `from`, walking in `step`'s direction.
 *
 * One or two digits only. A generation is `5`, `4.5`, `3.7` — never `20250514`,
 * and treating a date that survived the suffix strip as a version component is
 * how a chip ends up reading `Sonnet 4.20250514`.
 */
function digitRun(tokens: string[], from: number, step: number): string[] {
  const out: string[] = []
  for (let i = from; i >= 0 && i < tokens.length && /^\d{1,2}$/.test(tokens[i]); i += step) {
    out.push(tokens[i])
  }
  return step < 0 ? out.reverse() : out
}

/**
 * The name for one model id. `null`/empty means the CLI has not said yet, which
 * reads as "Default" rather than as a blank chip.
 */
export function modelName(id: string | null | undefined): string {
  const raw = (id ?? '').trim()
  if (!raw || raw.toLowerCase() === 'default') return 'Default'
  return parse(raw) ?? raw
}

/**
 * The picker's label for one option.
 *
 * Preferred in order: a name derived from the *resolved* id, then from the
 * alias, then whatever the CLI called it. `list_models` hands back `value:
 * 'opus'` with `displayName: 'Opus'` — a label that tells you the family and
 * hides the generation, which is the whole complaint. `resolvedModel` knows the
 * number, so the label is derived from it and the raw id stays as the subtitle.
 */
export function modelOptionLabel(value: string, label?: string, detail?: string): string {
  const named = label?.trim()
  // The CLI's own name wins unless it is a **bare family word**. That exception
  // is the entire fix and it has to be that narrow: `Default (recommended)` is
  // not a model name and must not be rewritten to the model it happens to
  // resolve to today, and `Sonnet 4.5` is already right. Only `Sonnet` — a
  // family with the generation filed off — needs the number putting back.
  if (named && (/\d/.test(named) || !parse(named))) return named
  const numbered = [detail, value]
    .map((v) => (v ? parse(v) : null))
    .find((v): v is string => !!v && /\d/.test(v))
  if (numbered) return numbered
  if (named) return named[0].toUpperCase() + named.slice(1)
  return parse(value) ?? value
}
