#!/usr/bin/env node
// Transparent stdio adapter around the existing claude-octopus command.
// Only tools/call arguments.prompt is changed; all permissions and other fields survive.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { preparePrompt } from "./lib/prompt-bridge.mjs";
const split = process.argv.indexOf("--");
const command = split < 0 ? [] : process.argv.slice(split + 1);
if (!command.length) throw new Error("Expected -- <existing MCP command> [args]");
const child = spawn(command[0], command.slice(1), {
  stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, REX_LANG_BRIDGE_ACTIVE: "1" },
});
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
child.on("error", () => { process.stderr.write("Claude MCP backend could not start\n"); process.exitCode = 1; });
child.on("close", (code) => { process.exitCode = code ?? 1; lines.close(); process.stdin.destroy(); });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { child.kill(signal); });
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
lines.on("line", (line) => {
  queue = queue.then(async () => {
    let forwarded = line;
    try {
      const message = JSON.parse(line);
      const args = message.method === "tools/call" ? message.params?.arguments : undefined;
      if (typeof args?.prompt === "string") {
        args.prompt = await preparePrompt(args.prompt, {
          cwd: typeof args.cwd === "string" ? args.cwd : (process.env.CLAUDE_CWD || process.cwd()),
          report: text => process.stderr.write(text + "\n"),
        });
        forwarded = JSON.stringify(message);
      }
    } catch { /* Preserve malformed or non-JSON upstream input verbatim. */ }
    if (child.stdin.writable) child.stdin.write(forwarded + "\n");
  });
});
lines.on("close", () => queue.finally(() => child.stdin.end()));
