#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  AGY_R16_TOKEN_RELATIVE_PATH,
  auditAgyR16ToolTranscript,
  auditAgyR16TokenTransition,
  parseAgyR16TokenBuffer,
} from "./lib/agy-r16-home.mjs";

const SOURCE_TOKEN = path.join("/source", AGY_R16_TOKEN_RELATIVE_PATH);
const TARGET_TOKEN = path.join("/target", AGY_R16_TOKEN_RELATIVE_PATH);
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function readExactToken(filePath) {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
    stat.uid !== 65532 || stat.gid !== 65532 || (stat.mode & 0o777) !== 0o600
  ) fail("AGY_R16_TOKEN_FILE_INVALID");
  const buffer = fs.readFileSync(filePath);
  parseAgyR16TokenBuffer(buffer);
  return buffer;
}

function prepareTargetRoot() {
  fs.chownSync("/target", 65532, 65532);
  fs.chmodSync("/target", 0o700);
  const gemini = "/target/.gemini";
  const cli = "/target/.gemini/antigravity-cli";
  for (const directory of [gemini, cli]) {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    fs.chownSync(directory, 65532, 65532);
    fs.chmodSync(directory, 0o700);
  }
}

function writeAtomicToken(buffer, runId) {
  const temporary = `${TARGET_TOKEN}.r16-${runId}.tmp`;
  if (fs.existsSync(temporary)) fail("AGY_R16_TOKEN_TEMP_EXISTS");
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chownSync(temporary, 65532, 65532);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, TARGET_TOKEN);
    const directory = fs.openSync(path.dirname(TARGET_TOKEN), "r");
    fs.fsyncSync(directory);
    fs.closeSync(directory);
  } catch (error) {
    if (descriptor !== null && descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function seed() {
  const source = readExactToken(SOURCE_TOKEN);
  if (fs.readdirSync("/target").some((name) => name !== "lost+found")) {
    fail("AGY_R16_HOME_NOT_EMPTY");
  }
  prepareTargetRoot();
  writeAtomicToken(source, "00000000000000000000000000000000");
  const target = readExactToken(TARGET_TOKEN);
  const sourceHash = parseAgyR16TokenBuffer(source).hash;
  const targetHash = parseAgyR16TokenBuffer(target).hash;
  if (sourceHash !== targetHash) fail("AGY_R16_TOKEN_SEED_MISMATCH");
  process.stdout.write(`${JSON.stringify({ status: "seeded", sourceHash, targetHash })}\n`);
}

function merge(runId, expectedDurableHash) {
  if (!RUN_ID_PATTERN.test(runId || "") || !SHA256_PATTERN.test(expectedDurableHash || "")) {
    fail("AGY_R16_TOKEN_MERGE_SCOPE_INVALID");
  }
  const source = readExactToken(SOURCE_TOKEN);
  const target = readExactToken(TARGET_TOKEN);
  const beforeHash = parseAgyR16TokenBuffer(target).hash;
  if (beforeHash !== expectedDurableHash) fail("AGY_R16_TOKEN_DURABLE_CHANGED");
  const transition = auditAgyR16TokenTransition(target, source, new Date());
  if (transition.changed) writeAtomicToken(source, runId);
  const after = readExactToken(TARGET_TOKEN);
  const afterHash = parseAgyR16TokenBuffer(after).hash;
  if (afterHash !== transition.afterHash) fail("AGY_R16_TOKEN_MERGE_MISMATCH");
  process.stdout.write(`${JSON.stringify({
    status: "merged",
    changed: transition.changed,
    beforeHash,
    afterHash,
  })}\n`);
}

function auditTools(conversationId) {
  if (!CONVERSATION_ID_PATTERN.test(conversationId || "")) {
    fail("AGY_R16_TOOL_AUDIT_SCOPE_INVALID");
  }
  const transcript = path.join(
    "/source/.gemini/antigravity-cli/brain",
    conversationId,
    ".system_generated/logs/transcript_full.jsonl"
  );
  const stat = fs.lstatSync(transcript);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 65532) {
    fail("AGY_R16_TOOL_TRANSCRIPT_FILE_INVALID");
  }
  const audit = auditAgyR16ToolTranscript(fs.readFileSync(transcript, "utf8"));
  if (!audit.ready) fail(audit.findings[0] || "AGY_R16_TOOL_AUDIT_FAILED");
  process.stdout.write(`${JSON.stringify({
    status: "tool-audited",
    counts: audit.counts,
    targetCount: audit.targetCount,
    targets: audit.targets,
    targetsSha256: audit.targetsSha256,
  })}\n`);
}

try {
  if (process.argv.length === 3 && process.argv[2] === "seed") seed();
  else if (process.argv.length === 4 && process.argv[2] === "audit-tools") {
    auditTools(process.argv[3]);
  }
  else if (process.argv.length === 5 && process.argv[2] === "merge") {
    merge(process.argv[3], process.argv[4]);
  } else fail("AGY_R16_HOME_HELPER_USAGE");
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    event: "agy_r16_home_helper_failed",
    reason: error?.code || "AGY_R16_HOME_HELPER_FAILED",
  })}\n`);
  process.exitCode = 70;
}
