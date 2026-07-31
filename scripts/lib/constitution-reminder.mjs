// constitution-reminder.mjs — Tell a delegated agent which row of the
// constitution it occupies, since it cannot read the file itself.
//
// AGENTS_CONSTITUTION.md (~/knowledge-base/06 - SYSTEM/AGENTS_CONSTITUTION.md)
// is the shared source of truth for huanghao's multi-agent system. Codex reads
// it via a standing pointer in ~/.codex/AGENTS.md; CodeBuddy and Qoder CLI pick
// it up automatically because both walk cwd up to a repo root looking for
// AGENTS.md, and the vault ships one. agy's own --help text claims the same
// AGENTS.md/GEMINI.md/.agents/rules discovery, but empirically does not perform
// it in `-p` (headless print) mode — confirmed by two direct tests (AGENTS.md
// and GEMINI.md placed at the vault root, cwd set to the vault root, neither
// loaded; see AGENTS_CONSTITUTION.md changelog v0.3). Interactive mode
// (bubbletea) needs a real TTY and could not be tested, so this may not be a
// permanent limitation of agy itself — but as long as the `-p` lane cc-suite
// drives doesn't load it, the only reliable channel left is the prompt
// cc-suite already controls.
//
// This mirrors withDelegationBoundary (same file family, same injection point
// in agy-runner.mjs) rather than folding into it: the delegation boundary's
// invariant sentences are shared with the Codex-side preamble in
// commands/shared/codex-call.md and asserted by
// tests/delegation-boundary.test.mjs. Codex already has its own standing
// constitution pointer and doesn't need this reminder, so mixing the two
// concerns into one exported constant would drag Codex's copy along for
// nothing.

export const CONSTITUTION_ROLE_REMINDER = [
  'Per AGENTS_CONSTITUTION.md (source of truth: ~/knowledge-base/06 - SYSTEM/AGENTS_CONSTITUTION.md),',
  'your role in this system is "Antigravity CLI (agy) — Gemini 执行层/委派后端".',
  "Do the delegated task yourself; you are not the final decision-maker.",
  "Do not escalate your own permissions beyond what this call already granted.",
  "If the task actually belongs to another agent's role, say so in your answer instead of acting outside it.",
].join(" ");

/**
 * Prefix a delegated prompt with the constitution role reminder.
 *
 * Call this where the prompt is handed to the child process, not where it is
 * parsed — same reasoning as withDelegationBoundary: the background path
 * re-spawns the runner with the original prompt, so prefixing earlier would
 * stack a second copy onto every backgrounded run.
 *
 * @param {string} prompt
 * @returns {string}
 */
export function withConstitutionReminder(prompt) {
  if (!prompt || !prompt.trim()) return CONSTITUTION_ROLE_REMINDER;
  return `${CONSTITUTION_ROLE_REMINDER}\n\n${prompt}`;
}
