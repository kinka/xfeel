#!/bin/sh
set -eu

ollama_url="http://${OLLAMA_HOST:-127.0.0.1:11434}"
ollama_bin="${OLLAMA_BIN:-/usr/local/bin/ollama}"

# Ollama.app may already own the port. Monitor that instance and take over only
# if it disappears, so PM2 and the GUI never fight over 11434.
while curl --fail --silent --max-time 2 "$ollama_url/api/tags" >/dev/null; do
  sleep 2
done

exec "$ollama_bin" serve
