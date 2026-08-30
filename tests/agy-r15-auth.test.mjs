import assert from "node:assert/strict";
import test from "node:test";

import {
  AGY_R15_AUTH_HOSTS,
  AGY_R15_AUTH_PROFILE_HASH,
  AGY_R15_OAUTH_SCOPES,
  buildAgyR15AuthPolicy,
  buildAgyR15ClientCreateArgs,
  buildAgyR15ProxyRunArgs,
} from "../scripts/lib/agy-r15-auth.mjs";

const CLIENT_NAME = "cc-suite-agy-r15-auth-0123456789ab";
const PROXY_NAME = "cc-suite-agy-r15-proxy-0123456789ab";
const NETWORK_NAME = "default";
const VOLUME_NAME = "cc-suite-agy-oauth-0123456789abcdef";
const NONCE = "0123456789abcdef0123456789abcdef";
const RUN_ID = "abcdef0123456789abcdef0123456789";
const PROFILE_HASH = AGY_R15_AUTH_PROFILE_HASH;

test("R15 declares the observed OAuth scopes, including broad cloud-platform consent", () => {
  assert.deepEqual(AGY_R15_OAUTH_SCOPES, [
    "aicode",
    "cclog",
    "experimentsandconfigs",
    "https://www.googleapis.com/auth/cloud-platform",
    "openid",
    "userinfo.email",
    "userinfo.profile",
  ]);
  assert.equal(
    AGY_R15_OAUTH_SCOPES.includes("https://www.googleapis.com/auth/cloud-platform"),
    true
  );
  assert.match(AGY_R15_AUTH_PROFILE_HASH, /^sha256:[a-f0-9]{64}$/);
});

test("R15 limits auth egress to an exact canonical host set and one exact client", () => {
  assert.deepEqual(AGY_R15_AUTH_HOSTS, [...AGY_R15_AUTH_HOSTS].sort());
  assert.equal(AGY_R15_AUTH_HOSTS.some((host) => host.includes("*")), false);
  assert.ok(AGY_R15_AUTH_HOSTS.includes("lh3.googleusercontent.com"));

  const result = buildAgyR15AuthPolicy({
    clientIPv4: "172.30.251.2",
    listenPort: 18443,
    upstreamProxyUrl: "http://203.0.113.113:49152",
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.policy.allowedHosts, AGY_R15_AUTH_HOSTS);
  assert.equal(result.policy.allowedClientIPv4, "172.30.251.2");
  assert.deepEqual(result.policy.upstream, { url: "http://203.0.113.113:49152" });
  assert.match(result.policyHash, /^sha256:[a-f0-9]{64}$/);
});

test("R15 auth client uses only a named OAuth volume and loopback bootstrap ingress", () => {
  const args = buildAgyR15ClientCreateArgs({
    bootstrapHostPort: 28083,
    bootstrapNonce: NONCE,
    clientName: CLIENT_NAME,
    networkName: NETWORK_NAME,
    networkPrefix: "172.30.251",
    oauthVolumeName: VOLUME_NAME,
    profileHash: PROFILE_HASH,
    proxyPort: 18443,
    runId: RUN_ID,
  });
  const flattened = args.join(" ");

  assert.equal(args[0], "create");
  assert.ok(args.includes("--interactive"));
  assert.ok(args.includes("--tty"));
  assert.ok(args.includes("--no-dns"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-add"));
  assert.ok(args.includes("NET_ADMIN"));
  assert.ok(args.includes("KILL"));
  assert.ok(args.includes(
    `type=volume,source=${VOLUME_NAME},target=/home/agy`
  ));
  assert.ok(args.includes("127.0.0.1:28083:18083"));
  assert.ok(args.includes("SSH_CONNECTION=127.0.0.1 1 127.0.0.1 22"));
  assert.equal(flattened.includes("/Users/"), false);
  assert.equal(flattened.includes("--ssh"), false);
  assert.equal(flattened.includes("--publish-socket"), false);
  assert.equal(flattened.includes("GOOGLE_APPLICATION_CREDENTIALS"), false);
  assert.deepEqual(args.slice(-2), [
    "cc-suite/agy-r14-capsule:1.1.11",
    "/usr/local/bin/agy",
  ]);
});

test("R15 proxy is detached, read-only, exact-networked, and policy-only", () => {
  const policy = buildAgyR15AuthPolicy({
    clientIPv4: "172.30.251.2",
    listenPort: 18443,
    upstreamProxyUrl: "http://203.0.113.113:49152",
  });
  const args = buildAgyR15ProxyRunArgs({
    networkName: NETWORK_NAME,
    policy: policy.policy,
    proxyName: PROXY_NAME,
  });
  const flattened = args.join(" ");

  assert.equal(args[0], "run");
  assert.ok(args.includes("--detach"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("ALL"));
  assert.deepEqual(
    args.flatMap((value, index) => value === "--network" ? [args[index + 1]] : []),
    [NETWORK_NAME]
  );
  assert.ok(args.includes(`AGY_PROXY_POLICY=${JSON.stringify(policy.policy)}`));
  assert.equal(flattened.includes("--publish"), false);
  assert.equal(flattened.includes("/Users/"), false);
  assert.equal(flattened.includes("TOKEN"), false);
  assert.ok(args.includes("cc-suite/agy-r15-egress:probe"));
  assert.deepEqual(args.slice(-6), [
    "--policy-env",
    "AGY_PROXY_POLICY",
    "--expected-listen-host",
    "0.0.0.0",
    "--expected-client-ipv4",
    "172.30.251.2",
  ]);
});

test("R15 rejects loose resources, public client addresses, and non-audited policies", () => {
  assert.throws(
    () => buildAgyR15ClientCreateArgs({
      bootstrapHostPort: 28083,
      bootstrapNonce: NONCE,
      clientName: "agy",
      networkName: NETWORK_NAME,
      networkPrefix: "172.30.251",
      oauthVolumeName: VOLUME_NAME,
      profileHash: PROFILE_HASH,
      proxyPort: 18443,
      runId: RUN_ID,
    }),
    (error) => error.code === "AGY_R15_AUTH_SCOPE_INVALID"
  );

  assert.throws(
    () => buildAgyR15ClientCreateArgs({
      bootstrapHostPort: 28083,
      bootstrapNonce: NONCE,
      clientName: CLIENT_NAME,
      networkName: NETWORK_NAME,
      networkPrefix: "172.30.251",
      oauthVolumeName: VOLUME_NAME,
      profileHash: `sha256:${"a".repeat(64)}`,
      proxyPort: 18443,
      runId: RUN_ID,
    }),
    (error) => error.code === "AGY_R15_AUTH_SCOPE_INVALID"
  );

  assert.throws(
    () => buildAgyR15AuthPolicy({
      clientIPv4: "8.8.8.8",
      listenPort: 18443,
      upstreamProxyUrl: "http://203.0.113.113:49152",
    }),
    (error) => error.code === "AGY_R15_AUTH_POLICY_INVALID"
  );

  assert.throws(
    () => buildAgyR15ProxyRunArgs({
      networkName: NETWORK_NAME,
      policy: { allowedHosts: ["*.googleapis.com"] },
      proxyName: PROXY_NAME,
    }),
    (error) => error.code === "AGY_R15_AUTH_POLICY_INVALID"
  );
});
