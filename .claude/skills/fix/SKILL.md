---
name: fix
description: Work an item from the code-review backlog — verify it is still real, implement it, typecheck, commit with "Fixes #N", push. Takes an issue number; with no argument works every open code-review issue in turn. Use when asked to fix a review finding, build a backlog idea, or clear the issues the daily review job filed.
---

# Working the code-review backlog

The daily review job (`.github/workflows/dailycodereview.yml`) files one issue per item under
`label:code-review`, split into findings (`severity:*`, a defect) and ideas (`idea`, something
worth building). This skill turns one of those issues, or all of them, into commits.

**Argument:** an issue number — `/fix 21`. With no argument, work every open `code-review`
issue, findings before ideas: findings are smaller and uncontentious, so if the run is going
to go wrong you would rather find out on those.

**One issue, one commit, always.** Never batch two issues into a commit even when they touch
the same file. `Fixes #N` closes exactly one issue, the commit body explains exactly one
change, and a revert takes back exactly one decision. Finish an issue completely — change,
typecheck, commit, push — before reading the next one.

## 1. Read the issue, then read the code

```
gh issue view <N> --json number,title,body,labels
```

The body names a file and a line range, states the defect or proposal, and says why it
matters. Read that, then go read the code it points at. Read `CLAUDE.md` for the area you are
about to touch — it is an index into the invariants, and the file you are editing very likely
has a rule attached to it.

## 2. Verify the item is still real — before changing anything

Line numbers in the issue are from the day it was filed and drift with every commit since.
Locate the actual code by what the issue describes, not by the line range.

Then decide whether the item still stands. Three outcomes, and only the first one leads to a
change:

- **Still real** — carry on to step 3.
- **Already fixed** — someone got there first. Close it and stop:
  `gh issue close <N> --reason completed --comment "Already fixed by <sha>: <what changed>."`
  then `gh issue edit <N> --add-label cr-auto-closed`.
- **Not real** — the finding was wrong, or the code it describes is gone, or it contradicts a
  deliberate decision in `CLAUDE.md` that the review job missed. Close it as
  `--reason "not planned"` with a comment saying which, add `cr-auto-closed`, and stop.

Do not invent a change to satisfy a stale issue. An issue is a claim about the code, and the
code is the authority — if they disagree, the issue loses.

## 3. Make the change

Match the surrounding code: this repo is deliberately densely commented, and a fix that
silently changes behaviour without explaining the constraint it now respects is half a fix.
The comment policy in `CLAUDE.md` overrides the usual "don't add comments" default — explain
the *why* and the constraint the code cannot express, at the density of the code around it.

Two rules that catch out fixes specifically:

- **Fix the cause the issue names, not the symptom near it.** If the issue says a clear path
  drops four of five fields, add the fifth — do not add a defensive guard downstream that
  hides the asymmetry.
- **Do not widen the change.** No adjacent cleanups, no drive-by refactors, no "while I'm
  here". Those belong in their own issue, and mixing them makes the fix unreviewable and
  un-revertable. If you find something else worth doing, say so at the end.

## 4. Typecheck

```
npm run typecheck
```

There is no test suite by design, so this is the whole automated gate — do not add one. If it
fails, fix it before committing; a red typecheck is never "unrelated".

## 5. Commit, push, and mark the closure as reopenable

Commit straight onto `main` — no branch, no PR. That is this repo's rule, and it is deliberate:
a branch here is only a merge step nobody is going to review.

Subject: what changed, in the imperative, no issue number. Body: the reasoning — what was
wrong, why it was wrong, and what constrains the fix — at the density of the commit messages
already in `git log`. End the body with the closing trailer:

```
Fixes #<N>
```

Then push in the same turn, per `CLAUDE.md`:

```
git push origin main
```

`Fixes #N` closes the issue automatically when the commit lands on `main`. **Then label the
closure:**

```
gh issue edit <N> --add-label cr-auto-closed
```

That label is load-bearing and easy to skip. The review job treats a closed issue *without* it
as a human decision and will never re-file that item — permanently, by design, so that it
cannot nag you about something you refused. A fix is not a refusal: if the defect regresses
later you want to hear about it, and the label is what lets the job reopen the issue instead
of staying silent. Skip the label and you have quietly told the job to ignore that defect
forever.

## Ideas are not findings

An `idea` issue is a proposal to build something, not a defect to repair, and the bar for
starting is different. Before writing code:

- Check it against `CLAUDE.md` again yourself. The review job is told to reject anything
  contradicting a documented deliberate decision, but that guard runs at filing time on a
  reading of the codebase — you are closer to the code, and you may see that a proposal
  reintroduces something this project removed on purpose. If so, close it as not planned.
- If the idea touches architecture — a new IPC channel, a new persisted `Config` field, a new
  surface in the store — say what you intend to do and get agreement before building it. Adding
  an IPC feature alone touches four files in a fixed order; that is not a change to make on a
  guess about what was wanted.

Small, self-contained ideas (a button, a snippet in an existing dialog) need no ceremony —
build them like a fix.

## What this does not cover

`npm run typecheck` proves the types, and nothing else. It does not prove the app runs, and
several classes of change here cannot be verified in the dev container at all: anything
touching Docker, PowerShell, WSL, or the packaged Windows build. `CLAUDE.md` is explicit that
those paths are verified by the user on the Windows host.

So when a fix lands in one of those areas, say plainly that it typechecks and has not been
run — do not report it as working. For renderer-side changes you can go further and probe the
running app over CDP (`npm run dev:cdp` plus the `playwright` MCP server, per `CLAUDE.md`);
that is worth doing for anything with visible behaviour, and is still not the same as the user
having used it.
