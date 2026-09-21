#!/usr/bin/env bash
# The whole chain on one machine: the real proxy binary, the real bridge, and
# the real client code from both ends.
#
# The proxy runs with a self-signed certificate, which is what the WeChat
# devtools' "skip TLS checking" switch exists for; a real build talks to a
# real certificate and needs no such thing.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
PORT=${1:-8787}
PROXY_BIN=${PROXY_BIN:-/Users/user/dshapp/dsh-proxy-unified/target/release/dsh-proxy}

pkill -f 'release/dsh-proxy --listen 127.0.0.1' 2>/dev/null
pkill -f 'e2e-bridge.js' 2>/dev/null
sleep 0.3

echo '--- 1. proxy (the shipped binary) ---'
"$PROXY_BIN" --listen 127.0.0.1:"$PORT" --tls-self-signed > /tmp/local-proxy.log 2>&1 &
PROXY_PID=$!
sleep 0.8
head -2 /tmp/local-proxy.log

echo '--- 2. bridge (the real bridge code) ---'
cd "$HERE"
PROXY_PORT=$PORT node test/dist/e2e-bridge.js > /tmp/local-bridge.log 2>&1 &
BRIDGE_PID=$!
sleep 3
HELLO=$(grep -m1 '"ready"' /tmp/local-bridge.log)
echo "$HELLO"
read_field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).$1))"; }
BRIDGE_KEY=$(echo "$HELLO" | read_field bridgeKey)
TOKEN=$(echo "$HELLO" | read_field pairingToken)

echo '--- 3. mini-program client (wsSocket.ts through a wx shim) ---'
PROXY_PORT=$PORT BRIDGE_KEY=$BRIDGE_KEY PAIRING_TOKEN=$TOKEN \
  node test/dist/e2e-miniapp.js
STATUS=$?

echo '--- proxy log ---'
cat /tmp/local-proxy.log
echo '--- bridge stderr (should be empty) ---'
grep -v '"ready"' /tmp/local-bridge.log

kill $BRIDGE_PID $PROXY_PID 2>/dev/null
wait 2>/dev/null
exit $STATUS
