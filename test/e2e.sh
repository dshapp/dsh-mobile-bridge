#!/usr/bin/env bash
# Full-chain end-to-end run: real proxy binary, real bridge code, real client
# tunnel code, over a real TLS WebSocket on loopback.
set -u
PORT=${1:-27101}
PROXY=/Users/user/dshapp/dsh-proxy-unified/target/release/dsh-proxy
BRIDGE_DIR=/Users/user/dshapp/dsh-bridge-rpc

pkill -f 'target/release/dsh-proxy' 2>/dev/null
pkill -f 'e2e-bridge.js' 2>/dev/null
sleep 0.3

echo '--- 1. proxy ---'
$PROXY --listen 127.0.0.1:$PORT --tls-self-signed > /tmp/e2e-proxy.log 2>&1 &
PROXY_PID=$!
sleep 0.8
head -2 /tmp/e2e-proxy.log

echo '--- 2. bridge (real bridge code) ---'
cd $BRIDGE_DIR
PROXY_PORT=$PORT node test/dist/e2e-bridge.js > /tmp/e2e-bridge.log 2>&1 &
BRIDGE_PID=$!
sleep 3
HELLO=$(grep -m1 '"ready"' /tmp/e2e-bridge.log)
echo "$HELLO"
BRIDGE_KEY=$(echo "$HELLO" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).bridgeKey))")
TOKEN=$(echo "$HELLO" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).pairingToken))")

echo '--- 3. client (real mini-program tunnel code) ---'
PROXY_PORT=$PORT BRIDGE_KEY=$BRIDGE_KEY PAIRING_TOKEN=$TOKEN node test/dist/e2e-client.js
STATUS=$?

echo '--- proxy log ---'
cat /tmp/e2e-proxy.log
echo '--- bridge stderr (should be empty) ---'
grep -v '"ready"' /tmp/e2e-bridge.log

kill $BRIDGE_PID $PROXY_PID 2>/dev/null
wait 2>/dev/null
exit $STATUS
