#!/bin/sh
# usage: p11-agy-run.sh <name> <mode> <hook-timeout-s> <prompt> [extra agy args...]; env PROBE_RULES passes through
P="$(cd "$(dirname "$0")" && pwd)/agy-hook-probe.mjs"
name=$1; mode=$2; to=$3; prompt=$4; shift 4
d=${PROBE_ROOT:-/private/tmp}/p11-agy-$name; mkdir -p $d/.agents; cd $d; git init -q . 2>/dev/null
cat > .agents/hooks.json <<J
{"gate":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"node $P","timeout":$to}]}]}}
J
export PROBE_MODE=$mode PROBE_LOG=$d/hook.jsonl PROBE_TAG=$name
s=$(date +%s)
agy -p "$prompt" --output-format stream-json --print-timeout 300s "$@" > out.jsonl 2> err.txt
echo "exit=$? elapsed=$(( $(date +%s)-s ))s" >> err.txt
