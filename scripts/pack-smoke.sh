#!/usr/bin/env bash
# Packaging smoke test.
#
# Node refuses to strip TypeScript types for files inside node_modules, so a
# published tarball must run from compiled JavaScript. Nothing in the unit tests
# catches that: they run against the sources. This script packs the tarball,
# installs it into a scratch directory and drives a real message end to end.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
srv=""
listener=""
cleanup() {
  [ -n "$listener" ] && kill "$listener" 2>/dev/null || true
  [ -n "$srv" ] && kill "$srv" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

port=${PORT:-18911}
echo "→ packing"
tgz=$(cd "$root" && npm pack --pack-destination "$tmp" | tail -1)
echo "→ installing $tgz"
cd "$tmp"
npm init -y >/dev/null 2>&1
npm install --silent "./$tgz"

export AGENTLINK_CONFIG_DIR="$tmp/cfg"
bin="$tmp/node_modules/.bin"
export PORT="$port" AGENTLINK_SIGNUP=open AGENTLINK_DATA_DIR="$tmp/data"
"$bin/agentlink-server" >"$tmp/server.log" 2>&1 &
srv=$!

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null || { echo "server never became healthy"; cat "$tmp/server.log"; exit 1; }

echo "→ signup"
"$bin/agentlink" signup "http://127.0.0.1:$port" --account pack-smoke --device smoke >/dev/null

echo "→ listen"
"$bin/agentlink" listen --name bot --exec 'sh -c "echo REPLY-FROM-PACKAGE"' >"$tmp/listen.log" 2>&1 &
listener=$!
sleep 3

echo "→ send"
out=$("$bin/agentlink" send bot "packaging smoke test" --name cli --wait 25)
echo "$out"
echo "$out" | grep -q "delivered" || { echo "message was not delivered"; cat "$tmp/listen.log"; exit 1; }
echo "$out" | grep -q "REPLY-FROM-PACKAGE" || { echo "handler reply never came back"; exit 1; }

echo "✓ the packed tarball installs and passes a message end to end"
