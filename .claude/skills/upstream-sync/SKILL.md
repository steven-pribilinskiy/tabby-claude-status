---
name: upstream-sync
description: Check the upstream `tabby-claude-status-gse` npm package for new versions and surface changes worth backporting to this fork. Use when the user asks to "check upstream", "sync from upstream", "diff against upstream", "see if there's a new upstream version", or similar. Idempotent — reports "no new changes" when upstream hasn't moved since the last reviewed version recorded in plugin/UPSTREAM.md.
---

# Upstream sync

This fork was forked from `tabby-claude-status-gse@1.0.1` (MIT, hosted on a private GitLab). Upstream still publishes to npm but the source isn't browsable, so we diff against the npm tarball to spot changes.

## State file

Source of truth for "what version we last reviewed" lives in **`plugin/UPSTREAM.md`** at the repo root. Read it first, update it last.

## Procedure

### 1. Read current state

Open `plugin/UPSTREAM.md`. Extract:
- `LAST_REVIEWED` ← the version after "Reviewed up to upstream version:"
- `LAST_DATE` ← the date after "Reviewed at:"
- The bullet list under "Pending backports" — items still waiting to be ported from prior reviews.

If the file is missing, the fork hasn't been bootstrapped for this skill — write a fresh skeleton (see "Initial state" below) and treat `LAST_REVIEWED` as `1.0.1` (the fork base).

### 2. Check upstream

```bash
npm view tabby-claude-status-gse version
```

Call the result `CURRENT`. If you also want context on what versions exist:

```bash
npm view tabby-claude-status-gse versions --json
npm view tabby-claude-status-gse time --json   # publish dates
```

### 3. Decide whether there's work

- **`CURRENT === LAST_REVIEWED`** → report:
  > Upstream is at `{CURRENT}`, last reviewed on `{LAST_DATE}`. No new versions to look at.
  > Pending backports from prior reviews:
  > - {item 1}
  > - {item 2}

  Stop. Don't touch any files.

- **`CURRENT > LAST_REVIEWED`** → continue to step 4.

- **`CURRENT < LAST_REVIEWED`** → flag as anomaly (upstream rolled back, or the state file got mis-edited). Stop and ask the user what they want to do.

### 4. Fetch and unpack the new tarball

```bash
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
npm pack tabby-claude-status-gse@{CURRENT}
tar -xzf tabby-claude-status-gse-{CURRENT}.tgz
ls package/
```

Upstream ships `dist/`, `hook.js`, `package.json`, `README.md` only — **no source**. The `dist/*.d.ts` files are the cleanest API-surface diff target.

### 5. Diff against the fork

Useful pairings (run in parallel where possible):

| Upstream file | Fork file | What you're looking for |
|---|---|---|
| `package/dist/interfaces/types.d.ts` | `plugin/src/interfaces/types.ts` | New config knobs, type changes, new defaults |
| `package/hook.js` | `plugin/hook.js` | Hook protocol changes, new fields forwarded |
| `package/dist/services/*.d.ts` | `plugin/src/services/*.ts` | Service API additions/removals |
| `package/dist/decorator/*.d.ts` | `plugin/src/decorator/*.ts` | Behavioral changes in the tab decorator |
| `package/README.md` | `plugin/README.md` | What the upstream maintainer wrote up as new |

For each meaningful difference, also `grep` the fork's source for whether the relevant feature is *already covered by a different mechanism*.

### 6. Classify each change

For every observed difference, decide one of:

1. **Already in fork** (superseded) — fork has equivalent or stronger behavior, possibly under a different name/structure. Cite the fork file and explain why the upstream change is redundant.
2. **Worth porting** — upstream fixes a bug or adds a knob the fork lacks. Cite specific fork file paths + lines that would need to change. If you have a concrete suggestion (like the `safeRenderer` example), say so.
3. **Not applicable** — change conflicts with the fork's diverged design or removes a feature the fork relies on. Explain why.

The fork's divergence list is documented in the "Notes on divergence" section of `plugin/UPSTREAM.md`. Re-read it before classifying — it will catch most "already in fork" cases.

### 7. Report

Output a concise structured summary the user can scan:

```markdown
## Upstream sync: tabby-claude-status-gse {LAST_REVIEWED} → {CURRENT}

Published: {date from npm view ... time}.

### Worth porting ({N})
- {short title} — {what it does} — fork file:line that would change — suggested approach.

### Already in fork ({N})
- {short title} — {why it's superseded, citing fork code}.

### Not applicable ({N})
- {short title} — {why it conflicts}.
```

Don't auto-apply ports. Present the classification, let the user decide what to do.

### 8. Update the state file

After the user has reviewed (and either ported, deferred, or rejected each item), update `plugin/UPSTREAM.md`:

- "Reviewed at:" → today's date in absolute `YYYY-MM-DD` form (never "today" / relative).
- "Reviewed up to upstream version:" → `CURRENT`.
- "Pending backports" → carry over un-ported items from before, plus newly-classified "worth porting" items the user didn't immediately apply.
- "Already-applied / superseded from upstream" → move newly-applied items here (with the commit SHA that landed them, if known).

If the user wants to commit this change, propose a message like:

```
Refresh upstream sync state: reviewed up to {CURRENT}

{N} new items worth porting / {N} already in fork / {N} not applicable.
See plugin/UPSTREAM.md for the full breakdown.
```

## Initial state (if `plugin/UPSTREAM.md` is missing)

Write a skeleton with `LAST_REVIEWED = 1.0.1`, `LAST_DATE` = the date of commit `0b27862` ("Fork tabby-claude-status, ..."), and an empty pending list. Then proceed with steps 4–7 against the current upstream as if you were doing a fresh review.

## Notes

- The upstream maintainer (`graphix` / npm user `jpgeek`) ships only compiled `dist/` — diffing minified JS is possible but messy. Stick to `.d.ts` API surface unless behavior diff is unavoidable.
- The fork has significantly diverged: multi-backend TTS, dynamic Haiku-narrated phrases, session restore, mic/Zoom-aware muting, sound mode, display surfaces beyond color, activity log, configurable webhook. Most upstream changes will *not* apply cleanly. Look for small targeted fixes (the `safeRenderer` no-DOM-read fix from 1.1.0 is a good example of what's worth porting).
- The fork publishes its own npm package (`tabby-claude-status@1.x`), on a separate version line from upstream's `tabby-claude-status-gse@1.x`. The upstream version is *not* the fork's version.
