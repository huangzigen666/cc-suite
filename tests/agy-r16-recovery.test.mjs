import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  completeAgyR16RunManifest,
  createAgyR16RunManifest,
} from "../scripts/lib/agy-r16-recovery.mjs";
import { resolveJobLogFile } from "../scripts/lib/state.mjs";

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "cc-suite test",
      GIT_AUTHOR_EMAIL: "cc-suite@example.invalid",
      GIT_COMMITTER_NAME: "cc-suite test",
      GIT_COMMITTER_EMAIL: "cc-suite@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-r16-recovery-"));
  const source = path.join(root, "source");
  const workspace = path.join(root, "worktree");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(source);
  git(source, ["init", "-q"]);
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-qm", "fixture"]);
  git(source, ["worktree", "add", "--detach", workspace, "HEAD"]);
  const priorPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  t.after(() => {
    if (priorPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = priorPluginData;
    spawnSync("git", ["-C", source, "worktree", "remove", "--force", workspace]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { workspace };
}

test("R16 recovery manifest is private and resource-identity-bound", (t) => {
  const { workspace } = fixture(t);
  const jobId = "agy-r16-recovery-fixture";
  const created = createAgyR16RunManifest({
    cwd: workspace,
    jobId,
    logFile: resolveJobLogFile(workspace, jobId),
    oauthVolumeName: "cc-suite-agy-oauth-0123456789abcdef",
    runId: "0123456789abcdef0123456789abcdef",
    runnerIdentity: { pid: process.pid, pgid: process.pid, started: "fixture" },
    suffix: "0123456789ab",
  });
  const stat = fs.lstatSync(created.manifestPath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(created.manifest.names.client,
    "cc-suite-agy-r16-workspace-0123456789ab");
  assert.equal(created.manifest.names.home,
    "cc-suite-agy-r16-home-0123456789ab");

  completeAgyR16RunManifest(created.manifestPath);
  assert.equal(fs.existsSync(created.manifestPath), false);
});
