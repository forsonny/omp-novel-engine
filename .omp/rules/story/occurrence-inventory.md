# Exhaustive Occurrence Reporting

This file controls how review reports handle findings.

## Core rule

A full review must report every issue or occurrence the reviewer finds.

Do not pull one example from each category and move on. Representative examples are only allowed when the user explicitly asks for a quick review, a short summary, or a high-level overview.

For normal chapter reviews, produce an occurrence inventory.

## What counts as an occurrence

An occurrence is any specific sentence, phrase, paragraph, beat, or cluster that triggers one of the AI-ism checks.

Examples:

- one decorative verb
- one poetic ending
- one redundant explanatory sentence
- one hard narrator-distance construction
- one over-explained emotional beat
- one symbolic conversion
- one aphoristic narrator sentence
- one repeated motif line that adds redundant meaning
- one quote-ready sentence that explains the scene's meaning

Do not list neutral uses of a motif. List only the uses that create AI-ism risk, over-polish, redundancy, narrator distance, or plain-physical-prose weakness.

## Required workflow

1. Read the whole chapter once without fixing it.
2. Run the hard-ban scan.
3. Run the plain physical prose scan.
4. Run the flexible AI-ism judgment pass.
5. Build an occurrence inventory before writing the final verdict.
6. Use the inventory to create the report.
7. Do not omit low-risk findings silently. Put them in a minor-findings section if needed.

## Required report behavior

Every review report must include:

1. A count summary table.
2. An exhaustive occurrence inventory.
3. A category diagnosis.
4. A prioritized revision plan.
5. Do-not-change notes.

The count summary should look like this:

| Category | Count | Highest severity |
|---|---:|---|
| Hard narrator-distance bans | 0 | None |
| Plain physical prose issues | 7 | Medium |
| Flexible AI-ism risks | 12 | Medium |
| Minor or near-miss findings | 4 | Low |

The occurrence inventory should look like this:

| # | Category | Severity | Exact quote or location | Why it is flagged | Fix strategy |
|---:|---|---|---|---|---|
| 1 | Redundant explanation | Medium | "Assigned, not entrusted. There was a difference." | The second sentence explains the first. | Keep the sharp contrast and remove the explanation. |

## Severity labels

Use these labels for individual occurrences:

- Hard ban
- High
- Medium
- Low
- Near-miss

Hard ban is reserved for banned narrator-distance constructions that violate the rules.

High means the occurrence clearly weakens naturalness or creates strong AI-ism risk.

Medium means the occurrence is worth revising but not fatal.

Low means the occurrence is mild, optional, or style-dependent.

Near-miss means it resembles a banned or risky pattern but may be acceptable in context.

## Exact quote requirement

For every occurrence, quote the exact triggering words if possible.

If the passage is too long, quote the smallest useful phrase and describe the location.

Do not invent line numbers. If line numbers are unavailable, use plain location labels such as:

- opening paragraph
- ritual setup
- after the second bell
- Bryn freezing beat
- post-rite confrontation
- final quarry scene

## De-duplication rule

Do not double-count the same exact issue under five categories.

Choose one primary category for each occurrence and add secondary tags only when useful.

Example:

Primary category: Redundant explanatory sentence  
Secondary tags: theme over-reinforcement, aphoristic line

This keeps the report exhaustive without becoming padded.

## No sampling rule

Avoid these phrases unless the user asked for a brief review:

- examples include
- a few examples
- one example is
- the strongest examples are
- representative examples
- I will discuss only the strongest

Use instead:

- occurrences found
- full inventory
- all flagged instances
- count by category
- additional minor findings

## If there are many occurrences

Still report them.

Use a compact appendix instead of omitting them.

Structure:

1. Main report gives diagnosis and top priorities.
2. Occurrence inventory lists every finding.
3. Minor findings appendix lists low-risk items more compactly.

If the passage is extremely long and the context limit would prevent a complete list, say so clearly and split the report by section. Do not pretend the report is exhaustive when it is not.

## Good exhaustive report behavior

Correct:

- Lists every hard-ban hit.
- Lists every plain physical prose issue found.
- Lists every flexible AI-ism issue that materially affects the prose.
- Gives counts for each category.
- Gives a fix strategy for each occurrence or points recurring issues to a shared fix code.

Incorrect:

- Pulls one example from each category.
- Says a pattern exists but gives only one quote when several were found.
- Gives a diagnosis but no occurrence inventory.
- Reports "mostly clean" without proving that a scan was run.
- Says "discuss only the strongest examples" during a full review.

## Review mode vs revision mode

In review mode, report every occurrence.

In revision mode, do not necessarily explain every occurrence unless the user asks. Fix the passage, then summarize the main types of changes.

If the user asks for both review and rewrite, do the exhaustive inventory first, then rewrite.
