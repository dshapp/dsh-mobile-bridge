#!/usr/bin/env bash
# The Android client against a local proxy and a real bridge.
#
# Runs on the JVM, not a device, but the code under test is the shipped
# transport: Ws does RFC 6455 by hand and Noise does the IK handshake.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
PORT=${1:-8787}
PROXY_BIN=${PROXY_BIN:-/Users/user/dshapp/dsh-proxy-unified/target/release/dsh-proxy}
ANDROID=${ANDROID:-/Users/user/dshapp/dsh-android-wss}
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
export PATH="$JAVA_HOME/bin:$PATH"

pkill -f 'release/dsh-proxy --listen 127.0.0.1' 2>/dev/null
pkill -f 'e2e-bridge.js' 2>/dev/null
sleep 0.3

echo '--- proxy ---'
"$PROXY_BIN" --listen 127.0.0.1:"$PORT" --tls-self-signed > /tmp/local-proxy.log 2>&1 &
PROXY_PID=$!
sleep 0.8
head -2 /tmp/local-proxy.log

echo '--- bridge ---'
cd "$HERE"
PROXY_PORT=$PORT node test/dist/e2e-bridge.js > /tmp/local-bridge.log 2>&1 &
BRIDGE_PID=$!
sleep 3
HELLO=$(grep -m1 '"ready"' /tmp/local-bridge.log)
echo "$HELLO"
read_field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).$1))"; }
BRIDGE_KEY=$(echo "$HELLO" | read_field bridgeKey)
TOKEN=$(echo "$HELLO" | read_field pairingToken)

echo '--- android client (JVM unit test) ---'
cd "$ANDROID"
DSH_TEST_PROXY_HOST=localhost DSH_TEST_PROXY_PORT=$PORT \
DSH_TEST_BRIDGE_KEY=$BRIDGE_KEY DSH_TEST_PAIRING_TOKEN=$TOKEN \
  ./gradlew :app:testDebugUnitTest --offline --tests '*WsTunnelLiveTest*' 2>&1 \
  | grep -E 'BUILD|FAILED|error:' | head -10
STATUS=${PIPESTATUS[0]}

echo '--- bridge stderr ---'
grep -v '"ready"' /tmp/local-bridge.log
kill $BRIDGE_PID $PROXY_PID 2>/dev/null
wait 2>/dev/null
exit $STATUS
