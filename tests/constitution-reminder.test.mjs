import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  CONSTITUTION_ROLE_REMINDER,
  withConstitutionReminder,
} from "../scripts/lib/constitution-reminder.mjs";

const PLUGIN_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);

function readScript(name) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", name), "utf8");
}

test("the reminder names agy's constitution role and the source-of-truth path", () => {
  assert.ok(CONSTITUTION_ROLE_REMINDER.includes("AGENTS_CONSTITUTION.md"));
  assert.ok(CONSTITUTION_ROLE_REMINDER.includes("Gemini 执行层/委派后端"));
  assert.ok(
    /not the final decision-maker/i.test(CONSTITUTION_ROLE_REMINDER),
    "Reminder should state agy does not make the final call"
  );
});

test("withConstitutionReminder prefixes the prompt without losing it", () => {
  const prompted = withConstitutionReminder("Refactor src/parser.ts");
  assert.ok(prompted.startsWith(CONSTITUTION_ROLE_REMINDER));
  assert.ok(prompted.endsWith("Refactor src/parser.ts"));
  assert.ok(
    prompted.includes(`${CONSTITUTION_ROLE_REMINDER}\n\nRefactor`),
    "Blank line should separate the reminder from the task"
  );
});

test("withConstitutionReminder tolerates an empty prompt", () => {
  assert.equal(withConstitutionReminder(""), CONSTITUTION_ROLE_REMINDER);
  assert.equal(withConstitutionReminder("   "), CONSTITUTION_ROLE_REMINDER);
  assert.equal(withConstitutionReminder(undefined), CONSTITUTION_ROLE_REMINDER);
});

test("the agy runner applies both the delegation boundary and the constitution reminder", () => {
  const source = readScript("agy-runner.mjs");
  assert.match(
    source,
    /from "\.\/lib\/constitution-reminder\.mjs"/,
    "agy-runner.mjs should import the constitution reminder"
  );
  assert.match(
    source,
    /withConstitutionReminder\(/,
    "agy-runner.mjs should apply the reminder to the delegated prompt"
  );
  assert.match(
    source,
    /withDelegationBoundary\(withConstitutionReminder\(args\.prompt\)\)/,
    "boundary should wrap the reminder, which wraps the raw prompt"
  );
});

test("the reminder is applied where the child is invoked, not where args parse", () => {
  // Same reasoning as the delegation boundary: the background path re-spawns
  // the runner with the original prompt, so applying the reminder during
  // parseArgs would stack a second copy onto every backgrounded run.
  const source = readScript("agy-runner.mjs");
  const parseStart = source.indexOf("function parseArgs");
  assert.ok(parseStart !== -1, "agy-runner.mjs should define parseArgs");

  const afterParse = source.indexOf("\nfunction ", parseStart + 1);
  const parseBody = source.slice(parseStart, afterParse);
  assert.doesNotMatch(
    parseBody,
    /withConstitutionReminder/,
    "agy-runner.mjs must not apply the reminder inside parseArgs"
  );
});

test("only agy carries the reminder — Codex and Grok already have their own pointer", () => {
  // Codex reads AGENTS_CONSTITUTION.md via a standing pointer in
  // ~/.codex/AGENTS.md and doesn't need a prompt-injected copy. Grok's own
  // AGENTS.md-loading behavior in `-p` mode hasn't been tested, so it is
  // deliberately left out of this fix rather than assumed broken.
  const grokSource = readScript("grok-runner.mjs");
  assert.doesNotMatch(
    grokSource,
    /constitution-reminder\.mjs/,
    "grok-runner.mjs was not part of this fix — its AGENTS.md loading is unverified, not confirmed broken"
  );
});
