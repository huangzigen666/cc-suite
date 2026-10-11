#!/usr/bin/env node
// MCP callers can prepare a prompt without executing the delegated task.
import { preparePrompt } from "./lib/prompt-bridge.mjs";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Prompt exceeds 1 MiB");
}
const request = JSON.parse(input);
if (typeof request.prompt !== "string") throw new Error("Expected prompt string");
const prompt = await preparePrompt(request.prompt, {
  cwd: request.cwd || process.cwd(), report: (message) => process.stderr.write(message + "\n"),
});
process.stdout.write(JSON.stringify({ prompt }) + "\n");
