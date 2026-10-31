---
name: release
description: Cut and publish a new Vivarium version — version bump, release commit, NSIS build, annotated tag, GitHub release with the installer attached. Use when asked to release, ship, cut, or publish a new version of this app.
---

# Releasing Vivarium

Seven steps, in order. Steps 1–4 must run **on the Windows host** — the dev container has no
electron-builder toolchain and cannot produce an NSIS installer. Say so rather than faking it.

## 1. Decide the version

Every release so far has been a minor bump (`0.1.0` → `0.6.0`), because the app has no external
users and no stability promise to break. Read `git log --oneline <lasttag>..HEAD` and pick:
minor for anything user-visible, patch only for a hotfix on top of a release.

## 2. Typecheck

```
npm run typecheck
```

There is no test suite by design, so this is the whole automated gate. Do not add one.

## 3. Bump the version

```
npm version <x.y.z> --no-git-tag-version
```

`--no-git-tag-version` because the tag is created in step 6, annotated, after the build proves
the version actually builds. electron-builder derives the installer filename from
`package.json` (`artifactName: ${productName}-${version}-setup.${ext}`), so the bump must land
*before* the build or the artifact carries the old number.

Expect `tsconfig.*.tsbuildinfo` in the diff alongside `package.json` / `package-lock.json` —
they are tracked in this repo. Commit them.

## 4. Release commit

Subject: `vX.Y: <two or three headline topics, lowercase, comma-separated>`

Body: `Release build of everything since vX.Y-1 (<sha>..<sha>): <one sentence listing what
shipped>.` Include the actual commit range — it is how a later reader maps a release to its
work without trusting the notes.

## 5. Build the installer

```
npm run build:win
```

Produces `dist/Vivarium-<version>-setup.exe` (~83 MB) plus a blockmap. Check the filename
carries the new version; if it doesn't, step 3 didn't land.

## 6. Annotated tag

```
git tag -a vX.Y.Z -F -   # message: the version on line 1, blank line, one paragraph of scope
git push origin main && git push origin vX.Y.Z
```

Always annotated, never lightweight — the tag message is a second, terser copy of the release
scope that survives independently of GitHub.

## 7. GitHub release

Draft the notes into `dist/RELEASE-<version>.md` (`dist/` is gitignored, so the draft is
scratch — the published release is the copy of record), then:

```
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file dist/RELEASE-<version>.md \
  "dist/Vivarium-<version>-setup.exe#Vivarium-<version>-setup.exe"
```

Verify the asset actually uploaded — an 83 MB upload can fail long after the release exists:

```
gh release view vX.Y.Z --json assets --jq '[.assets[]|{name,size,state}]'
```

`state` must read `uploaded`.

## Release-notes style

This is the part worth getting right; the rest is mechanical. Read the previous release
(`gh release view <lasttag>`) before writing, and match its voice and format. Do not match its
length: that follows from what shipped.

**Rank the changes before writing a word of the notes.** The session running the release has just
done some of this work, so that work feels biggest. It is not a reason to lead with it.

1. Go through **every** commit since the last tag, oldest included: `git log <lasttag>..HEAD`
   with bodies, and `git show --stat` for what each one touched. Read the diff of any commit
   whose message says little (`Random fixes`).
2. List every user-visible change and rank the list by how much it changes the user's daily use.
   Ask what the user will notice most after installing, and what they could now do that they
   could not before.
3. These do not count towards importance: which session made the change, how recent it is, how
   much work it took, how large the diff or the commit body is, and how good its numbers look.
4. Write the sections in that order, and give the release commit subject its headline topics in
   the same order.

**Length follows importance.** Not everything deserves the same number of words.

- The top change or two get a section with the reasoning and trade-offs. Nothing gets more words
  than the change ranked above it.
- A moderate change gets a short section: a sentence or two on the symptom and the fix.
- A small change gets one line under `### Fixes`, however interesting it was to build.
- If nothing in a release is big, the notes are short. Do not inflate a change to fill a section.

- `## Vivarium vX.Y` heading, then one `###` section per change that earns one, in ranked order.
  Everything smaller collects in a single `### Fixes` list at the end.
- **Lead with the symptom, not the change.** "An agent that finished planning sat there showing
  a climbing timer" before "both tools now report through the bridge". The reader recognises
  the symptom; they have never heard of the bridge.
- In the sections that earn it, explain the *why* and the constraint in prose — the WSL clock
  drift, the capture-phase listener, the 3-second probe. These notes double as the public record
  of decisions this repo's comments make internally.
- Say what was traded away, not only what was gained (Ctrl+F taking the chord from readline).
- Bold the sentence a skimmer needs. Do not bold whole paragraphs.
- Close with `---` and `**Install:** download \`Vivarium-<version>-setup.exe\` below and run it
  (Windows, NSIS installer).`

Write the notes from the commit bodies, which are long and explanatory in this repo — they are
the source material, not `--oneline`.

## What this does not cover

The build passing is not the app working. Nothing here launches the installer, and the CDP
smoke run in CLAUDE.md exercises the dev build, not the packaged one. If the release was not
manually installed and opened, say that plainly rather than reporting it as verified.
