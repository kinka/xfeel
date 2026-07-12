#!/bin/sh
set -eu

ollama_url="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
attempt=0

until curl --fail --silent --show-error --max-time 2 "$ollama_url/api/tags" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Ollama did not become ready at $ollama_url within 60 seconds" >&2
    exit 1
  fi
  sleep 1
done

exec "${BUN_BIN:-/Users/kinka/.bun/bin/bun}" run api
