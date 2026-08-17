# Dev note: the agy "unsupported location" failure, and rolling back agy credentials

Date: 2026-08-18
Status: **root cause unresolved** — see "Conclusion". The value here is the
ruled-out list and the reusable checks, not an answer.

## Context

Every `agy` agent run on the macOS host failed with the same backend error,
while the CLI itself looked healthy:

```text
FAILED_PRECONDITION (code 400): User location is not supported for the API use.
```

The failure is specific to the *serving* path. The control plane was fine
throughout: OAuth resolved (`applyAuthResult: email=<account>, authMethod=consumer`),
and `agy models` returned the full 14-model list on every attempt. Only the
planner stream was rejected.

Environment at the time: `agy` 1.1.13, consumer (personal Gmail) auth, macOS
host behind a local HTTP proxy on `127.0.0.1:7892`.

## What the error is not

The obvious reading — "the egress IP is in an unsupported country" — is wrong,
and it costs real time to chase. Three checks rule it out.

**1. `agy` does honor the proxy environment variables.** Point them at a dead
port and the CLI fails at connect time rather than silently going direct:

```console
$ HTTPS_PROXY=http://127.0.0.1:1 ... agy models
Error: Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist":
proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused
```

**2. No traffic escapes the proxy, including the planner stream.** Sampling the
process's established sockets for the whole duration of a run shows every
outbound connection going to the proxy — the only other socket is the local
Chrome debug port:

```bash
(agy --print --model gemini-3.5-flash-low --print-timeout 90s 'PONG' &) 
for i in $(seq 10); do
  sleep 1
  lsof -nP -iTCP -a -c agy -sTCP:ESTABLISHED | awk 'NR>1{print $9}'
done | sort -u
```

```text
127.0.0.1:56474->127.0.0.1:7892      # 16 connections, all to the proxy
127.0.0.1:56481->127.0.0.1:9222      # local Chrome debug port
...
```

This matters because the eligibility check and the planner stream are different
code paths (`server_oauth.go` / `loadCodeAssist` vs `stream_handler.go` /
`executor.go`). Proving the *planner* is proxied requires socket observation;
the dead-proxy test alone aborts too early to tell you.

**3. The error survives an egress change across ASN classes.** Two exits were
tested, both reported by three independent services (ipinfo.io, api.ipify.org,
ifconfig.co):

| Exit IP | Location | ASN | Result |
|---|---|---|---|
| `165.140.240.45` | Los Angeles, US | AS18450 WebNX (hosting) | `User location is not supported` |
| `174.236.228.238` | Oakdale, US | CELLCO-PART / Verizon (mobile) | `User location is not supported` |

A datacenter ASN being rejected would be unsurprising. A consumer mobile-carrier
ASN in the US being rejected identically is the discriminating observation: the
region decision is not being made from the egress IP.

**4. The account's own country is a supported one.** Checked directly in Google
Payments settings: the account country is **United States**. This kills the
follow-on hypothesis that the gate reads the account's sticky country setting
rather than the request IP — both are US, and the call is still refused.

**5. It is not model-specific.** `agy models` lists non-Gemini backends too.
Running the same prompt through `claude-sonnet-4-6` and `gpt-oss-120b-medium`
produces the identical `User location is not supported`, so the gate sits at the
Antigravity service layer, ahead of any model backend.

**6. Neither an API key nor a missing GCP project explains it.** A stray
`GEMINI_API_KEY` in the environment is irrelevant (`env -u GEMINI_API_KEY`
changes nothing). `GOOGLE_CLOUD_PROJECT` is simply not read by agy — the log
still shows `quotaProject=` empty — and supplying a project by hand at the API
level is accepted (`"gcpManaged": true`) without changing agy's behavior.

## Conclusion — unresolved

**The root cause is not established.** Everything reachable from the host has
been ruled out: egress path, egress country, egress ASN class, account country,
locale and timezone, stray API key, GCP project binding, and model choice. The
account additionally holds an active Google One AI Premium subscription.

What is left is the Antigravity service layer refusing this account for a reason
Google does not report accurately — the emitted message names a location, but no
location signal available to the client accounts for it.

One caveat worth recording rather than hiding: the non-datacenter exit
(`174.236.228.238`, Verizon) was tested only once, and its IP check and the agy
run were separate commands about a minute apart. Later attempts to reselect a
non-hosting exit failed — the proxy client kept returning the same WebNX address
regardless of node or mode changes — so that single sample could not be
reconfirmed with a tighter check-run-check sandwich. It is evidence against the
IP hypothesis, not a refutation of it.

### A misleading side-quest, recorded so it is not repeated

Calling `cloudcode-pa.googleapis.com/v1internal:generateContent` directly with
the same OAuth token returns a *different* error:

```text
403 PERMISSION_DENIED   reason: SUBSCRIPTION_REQUIRED
domain: cloudaicompanion.googleapis.com
"You do not have a valid license of this product." (#3501)
```

and `loadCodeAssist` reports `free-tier` as `UNSUPPORTED_CLIENT` with only a
GCP-managed `standard-tier` allowed. This looks like the answer and is not:
that surface is **Gemini Code Assist**, a GCP product with its own licensing,
which a consumer Google One AI Premium subscription does not grant and which agy
does not use for consumer auth. Do not treat those responses as evidence about
agy's own path.

### If this is picked up again

The untested variable is a genuinely different network egress — a different
provider entirely, or running agy from a host outside the restricted network —
not another node inside the same proxy client. Everything cheaper has been
tried.

## Distinguishing the two failure modes

A second, transient error appeared during the same investigation:

```text
RESOURCE_EXHAUSTED (code 429)   # on the userInfo / eligibility call
```

When this hits, the auth cache is invalidated and subsequent log lines read
`error getting token source: You are not logged into Antigravity.` — which looks
like a credential problem but is downstream of the 429. Check the first error in
the log, not the last:

```bash
L=$(ls -t ~/.gemini/antigravity-cli/log/cli-*.log | head -1)
grep -E "429|RESOURCE|FAILED_PRE|not logged|applyAuthResult" "$L" | head
```

Logs are one file per invocation under `~/.gemini/antigravity-cli/log/`, and
every line is prefixed `ERROR: logging before google.Init:` regardless of
severity — read the embedded `I`/`W`/`E` glog level instead of the prefix.

## Credential backup and rollback

Switching accounts means destroying the live credential, so back it up first.
`agy` stores it in the macOS login keychain:

```text
service = gemini
account = antigravity
```

There is no `agy login` / `agy logout` subcommand. Login is triggered by
starting `agy` interactively with no credential present, which opens a browser
OAuth flow.

Two helper scripts live in `~/.local/bin/` (host-local, not shipped with
cc-suite):

| Script | Behavior |
|---|---|
| `agy-auth-backup [label]` | Copies `gemini/antigravity` to `gemini/antigravity-backup-<label>` |
| `agy-auth-restore <account>` | Overwrites the live item from a backup; `--list` enumerates backups |

Both move the secret between keychain items via `security find-generic-password`
and `security add-generic-password`, so it is never written to disk in
plaintext. Note that `security` has no stdin option for the password, so the
value is briefly visible in `argv` — acceptable on a single-user host, not on a
shared one.

Verify a backup by hashing both items read back from the keychain, rather than
trusting the script's own exit code:

```bash
a=$(security find-generic-password -s gemini -a antigravity -w | shasum -a 256)
b=$(security find-generic-password -s gemini -a antigravity-backup-<label> -w | shasum -a 256)
[ "$a" = "$b" ] && echo MATCH
```

### Account switch procedure

1. Confirm no `agy` process is running — it caches the token in memory and will
   write the old credential back:
   ```bash
   ps -eo pid,command | grep -E "^ *[0-9]+ agy$" | grep -v grep
   ```
2. `agy-auth-backup pre-account-switch`, then verify the hash as above.
3. `security delete-generic-password -s gemini -a antigravity`
4. Start `agy` interactively and complete the browser OAuth with the new
   account. The browser must egress the same way `agy` does.
5. Check both planes separately — the control plane passing does not imply the
   serving plane passes:
   ```bash
   agy models
   agy --print --model gemini-3.5-flash-low --print-timeout 90s 'PONG'
   ```
6. To roll back: stop `agy`, then
   `agy-auth-restore antigravity-backup-pre-account-switch`.

The rollback path was exercised end to end before being relied on: restore
reproduced the original credential hash exactly, and `agy models` succeeded
afterward.

## Related

- `commands/agy-preflight.md` and `scripts/agy-preflight.sh` report backend
  availability, but a passing preflight does not detect this failure — preflight
  exercises model discovery, which is not region-gated.
- The `Claude → agy` delegation lane is separately `BLOCKED` for sandbox reasons
  (see `AGENTS.md`); the region gate described here is an independent problem and
  affects `agy` used directly.
