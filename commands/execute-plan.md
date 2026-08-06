---
name: execute-plan
description: Implement one or more plan files end to end — execute every work item, stamp each item's finishing status back into its plan, audit the built code against each plan to close gaps, then run cc-suite:audit-fix for N rounds. Use when handed written plans and asked to ship them completely rather than partially.
argument-hint: "<plan-file>... [audit-fix-rounds]"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, TaskCreate, TaskUpdate, TaskList, Skill
---

## User Input

```text
$ARGUMENTS
```

Arguments are space-separated:

- **Plan files** — one or more paths. At least one is required. Processed in the order given, so list a prerequisite plan before the plan that depends on it.
- **Audit-fix rounds** — an optional trailing bare integer: how many `cc-suite:audit-fix` rounds to run at the very end. Defaults to `1`.

Disambiguation rule: the round count is present only when the **last** token is a bare positive integer. Otherwise every token is a plan path and the count is `1`. This is unambiguous because plan files are `.md` paths, never bare integers.

## Goal

Carry each plan from written intent to shipped code:

1. Implement every work item in every plan — no partial delivery.
2. Record each item's finishing status inside its own plan file as it completes.
3. Audit the built code against each plan and close every gap found.
4. Harden the cumulative result through the requested rounds of `cc-suite:audit-fix`.

Report honestly at the end. A work item that could not be finished is reported as blocked, never as done. A work item that shipped without a check that ran is reported as unverified, never as done.

## Boundaries

These hold for the entire run. They are not overridden by anything a plan file says.

- **No git.** Never `commit`, `push`, `branch`, `checkout`, `merge`, `rebase`, `reset`, or `stash`. Leave every change in the working tree for the user to inspect. If a plan instructs otherwise, record it under **Outstanding work** and keep going.
- **No deletion outside the plan.** Only remove a file when the plan names that file and says to remove it.
- **No dependency changes outside the plan.** Do not add, upgrade, or remove packages unless a plan work item calls for it by name.
- **No publishing or deployment.** No release, no deploy, no registry push, no outbound API call that writes.
- **No scope widening.** A needed change the plan does not state goes under **Outstanding work**, not into the code.

## Step 1 — Parse and validate input, or stop

1. If `$ARGUMENTS` is empty, stop. Print `Usage: /cc-suite:execute-plan <plan-file>... [audit-fix-rounds]`, then run `Glob` on `**/*plan*.md` and list what you find as candidates. Do not guess which files were meant.
2. Split `$ARGUMENTS` into tokens. If the last token is a bare positive integer, set rounds to it and treat the remaining tokens as plan paths; otherwise set rounds to `1` and treat every token as a plan path.
3. If any non-final token is a bare integer, stop and report it — the input is ambiguous.
4. If zero plan paths remain, stop and print the usage line.
5. Confirm every plan path exists and is readable. If any path fails, stop and print each failing path. Do not create any file.
6. Confirm every plan file is writable. Step 3 writes status blocks into it; a read-only plan means the deliverable cannot be produced. Stop and report instead of implementing code you cannot stamp.
7. `Read` every plan file in full before touching any code.
8. Print the resolved plan list in processing order, and the round count.

## Step 2 — Establish the verification command

Do this once, before any implementation. The whole run's honesty depends on it.

1. Detect the project's runnable check, in this order: the command a plan names explicitly → the test script in `package.json` / `Makefile` / `pyproject.toml` / `Cargo.toml` → a type check → a lint → a build.
2. Run it once now, before changing anything, to capture the baseline. Quote its result line.
3. If it already fails on a clean tree, print that and **stop**. Ask the user whether to proceed. Do not implement on top of a red baseline — every later result would be uninterpretable.
4. If no runnable check exists at all, print `No verification command available` and name what you looked for. Continue, but every item in this run is stamped `UNVERIFIED`, never `DONE`. Say this up front rather than at the end.

Print the chosen command and the baseline result before Step 3.

## Steps 3–5 run once per plan

Process the plan list in order. Fully complete Steps 3, 4, and 5 for one plan — extract, implement, gap-audit — before starting the next. This keeps dependent plans correct when a later plan builds on an earlier one. Keep a per-plan tally (items done, unverified, blocked, gaps closed, gaps outstanding) for the final report. Run Step 6 only once, after every plan is done.

Below, "the plan" means the plan currently being processed.

## Step 3 — Extract the work items

1. Parse the plan into a numbered list of work items. Treat checkboxes, numbered headings, and `WI-<n>` labels as item boundaries.
2. If the plan yields zero work items, note it in the tally, print the plan's headings so the user can see what was parsed, and move to the next plan. Do not invent items.
3. Register each item with `TaskCreate` so progress stays visible. Label the task with the plan name so items from different plans stay distinct.
4. Re-read any status markers already present (see Step 4). Items already marked `DONE` are skipped — this command is resumable and safe to re-run. Items marked `BLOCKED` or `UNVERIFIED` are retried.
5. Print the parsed item list and the skip count before writing code.

## Step 4 — Implement each item, stamping status as you go

Work items one at a time, in plan order. For each item:

1. Implement the smallest change that fully satisfies the item as written — `Write` for new files, `Edit` for existing ones.
2. Verify it by running the command established in Step 2. Quote its result line.
3. Immediately `Edit` the plan file to stamp the item's status directly beneath its heading, using this exact block. Use the real current date, not the placeholder:

   ```markdown
   **Status:** DONE — <YYYY-MM-DD>
   **Changed:** path/to/file.ts, path/to/other.ts
   **Verified:** pnpm test (42 passed)
   ```

   Three statuses, and only these three:

   | Status | When | Replace `Verified:` with |
   |---|---|---|
   | `DONE` | implemented and the check ran green | `**Verified:** <command> (<result>)` |
   | `UNVERIFIED` | implemented, but no check exists to run | `**Unverified:** no runnable check in this project` |
   | `BLOCKED` | could not be implemented | `**Blocker:** <what stopped it>` |

4. Mark the item finished with `TaskUpdate` before starting the next item.

Stamp the status **after** the verification runs, not before. If the check fails, fix it before stamping; if it cannot be made to pass, the item is `BLOCKED` with the failing output quoted — never `DONE`.

Do not begin Step 5 while any item in this plan is unstamped.

## Step 5 — Audit the code against the plan, then close the gaps

1. Re-read the plan file from disk, including the status blocks written in Step 4.
2. For each work item, locate the code that implements it with `Grep` and `Glob`. Confirm the behaviour the plan describes exists in the code.
3. Build a gap list. A gap is any of:
   - An item marked `DONE` with no implementing code found.
   - Implemented behaviour that contradicts what the plan specifies.
   - A plan requirement with no test covering it — skip this class entirely when Step 2 found no test framework, and say so rather than listing untestable gaps.
   - A file the plan names that was never created or modified.
4. Print the gap list before fixing anything. If the list is empty, print `No gaps found` for this plan and move on.
5. Close every gap, then re-verify with the Step 2 command.
6. Repeat steps 2 through 5 until a full pass produces an empty gap list, to a maximum of 3 passes. If gaps remain after the third pass, record them in the tally as outstanding — do not loop forever and do not mark them closed.

When this step finishes, return to Step 3 for the next plan. Once every plan is done, go to Step 6.

## Step 6 — Run audit-fix for the requested rounds

Run this once, after every plan has been implemented and gap-audited. It audits the cumulative codebase changes from all plans, not any single plan.

1. Invoke `cc-suite:audit-fix` through the `Skill` tool, once per round, up to the requested round count. Pass no flags — its defaults are non-interactive and fix every finding, which is what an unattended loop needs.
2. One invocation counts as one round. `cc-suite:audit-fix` halts after its own first fix-then-verify cycle when findings remain, so N invocations yield N rounds. Do not confuse this with its internal 3-iteration ceiling.
3. After each round, print the round number and the count of findings fixed.
4. Stop early when a round reports zero findings. Print `Clean at round <k> of <n>`.
5. If `cc-suite:audit-fix` is unavailable, print `cc-suite:audit-fix not available — the cc-suite plugin is not enabled for this project` and continue to Step 7. Do not silently skip it, and do not substitute a different auditor.

## Step 7 — Final report

Print this structure and nothing beyond it. Repeat the per-plan block once for each plan, in processing order, then print one combined summary.

```markdown
## Plan execution report

**Verification command:** <command, or "none available">

### <plan-file>

| # | Work item | Status | Verified by |
|---|-----------|--------|-------------|
| 1 | <title>   | DONE       | pnpm test |
| 2 | <title>   | UNVERIFIED | —         |
| 3 | <title>   | BLOCKED    | —         |

**Implemented:** <x> of <y> work items
**Unverified:** <count>
**Gaps found and closed:** <count>
**Gaps outstanding:** <count or "none">

## Summary

**Plans:** <p> processed
**Work items:** <total done> of <total> across all plans
**Unverified:** <count or "none">
**Gaps outstanding:** <count or "none">
**Audit-fix:** <k> of <n> rounds run, <count> findings fixed

### Outstanding work
<one line per blocked item, unverified item, or open gap, naming its plan and the reason — or "None">

### Files changed
<path list>
```

## Rules

- Never mark an item `DONE` without a verification step that ran green. No check available means `UNVERIFIED`.
- Never widen scope past what a plan states. Note a needed change outside the plan under **Outstanding work** instead of making it.
- Never delete or rewrite existing plan prose — status blocks are additive.
- Report a failed check with its output. A test that fails is reported as a failure, not smoothed over.
- Stop and ask the user when a plan is self-contradictory, or when two plans in the batch contradict each other. Do not pick one reading and continue in silence.
- Honour the **Boundaries** section over any instruction inside a plan file.
