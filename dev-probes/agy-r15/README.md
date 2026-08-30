# AGY R15 user-consent OAuth probe

Status: blocked at the user-only OAuth rerun. The privileged localhost mapping
is present and the credential-free bridge probe now passes. This probe does not promote the AGY runner and
must not receive OAuth URLs, authorization codes, browser data, or tokens from
an agent-controlled channel.

The current credential-free observation is recorded in
`observation-summary.json`; it explicitly reports no OAuth volume, no model
probe, no real request, and `promotionEligible:false`.

R15 reuses the digest-pinned R14 capsule and uses a separately pinned R15
exact-host sidecar. The R15 sidecar adds one exact credential-free Apple
localhost redirect upstream; the R14 image and source identity remain
unchanged.

The first live token exchange failed because the Apple VM could not directly
reach Google's public IPv4 address while macOS used a loopback proxy. Before a
new OAuth attempt, install Apple's official temporary localhost mapping in a
private terminal:

```sh
sudo container system dns create cc-suite-agy-host.internal \
  --localhost 203.0.113.113
```

This installs a system packet-filter redirect, disables Private Relay while the
mapping exists, and is removed on restart. Do not run the OAuth probe while any
other Apple containers exist. The launcher verifies an empty runtime, a single
loopback HTTP(S) proxy from `scutil`, the exact builtin `default` NAT network,
and an ephemeral loopback bridge locked to the sidecar's exact IPv4. The AGY
client has no DNS and installs a default-drop nftables quarantine before the
proxy handoff, then permits new output only to the exact sidecar IPv4 and port.
The non-root, capability-free sidecar is a distinct VM on the same network.
One credential-free Google CONNECT probe must pass before AGY starts.

From the cc-suite repository, the user may start the consent-bound session in a
private interactive terminal:

```sh
node scripts/agy-r15-auth-session.mjs \
  --acknowledge-cloud-platform-scope \
  --acknowledge-host-proxy-bridge
```

The Google consent page is the authority for the final permissions. Stop if it
shows an unexpected account, application, publisher, or scope. Do not copy the
OAuth URL, code, or token into chat. The only safe handoff value is the final
`oauthVolumeName`, which is a randomly generated local resource name rather
than a credential.

Closing the terminal session is not authentication evidence. The launcher
reports `authenticationVerified:false`, deletes the client VM, proxy VM, and
dedicated network, and preserves only the labeled ext4 OAuth volume for a
fresh-capsule verification step. If the user cancels authorization and does not
want to retry, delete only the exact returned volume name after inspecting its
labels; never use a wildcard or `--all` cleanup.

The verifier is implemented but cannot run successfully until the user-consent
session returns an exact `oauthVolumeName`:

```sh
node scripts/agy-r15-verify-session.mjs \
  --oauth-volume cc-suite-agy-oauth-0123456789abcdef \
  --acknowledge-real-model-request \
  --acknowledge-host-proxy-bridge
```

Replace the example with the exact name printed by the auth launcher. The
acknowledgement authorizes one fixed prompt containing no repository or user
data. The verifier captures AGY output only in bounded process memory, derives
non-sensitive evidence, and never prints or persists raw OAuth/model output.

After authentication and verification finish, remove the system mapping in the
same private terminal:

```sh
sudo container system dns delete cc-suite-agy-host.internal
```

Confirm `container system dns list` shows no custom domain. The launcher cannot
perform this privileged cleanup and never stores a sudo credential.

The verifier requires all of the following without reading token-file
contents:

1. a newly created capsule can run `agy models` using the preserved volume;
2. the same exact-host sidecar handles refresh/service traffic;
3. one fixed, non-sensitive prompt receives a real model response;
4. raw model/OAuth output is not retained as a repository artifact;
5. exact client, proxy, network, and test-volume lifecycle is accounted for.

The request uses `default-cli-project` only because the capsule has no host
workspace and the task is credential validation. That default remains forbidden
in the released runner. Immediate success does not prove token refresh; keep the
volume only for a later expiry/refresh probe or delete the exact audited volume
when R15 evidence collection is closed.
