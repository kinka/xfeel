#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-39107}"
DB_PATH="${XFEEL_UI_DB_PATH:-/tmp/xfeel-ui-${PORT}.db}"
SERVER_LOG="${XFEEL_UI_SERVER_LOG:-/tmp/xfeel-ui-${PORT}.log}"
JS_FILE="$(mktemp /tmp/xfeel-ui-test.XXXXXX.js)"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$DB_PATH" "$DB_PATH-shm" "$DB_PATH-wal" "$JS_FILE"
}
trap cleanup EXIT

rm -f "$DB_PATH" "$DB_PATH-shm" "$DB_PATH-wal" "$SERVER_LOG"

XFEEL_DB_PATH="$DB_PATH" PORT="$PORT" XFEEL_AUTH_DISABLED="1" LLM_BASE_URL="http://127.0.0.1:9" LLM_TIMEOUT_MS="250" bun run api >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in {1..80}; do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null

PLAYGROUND_URL="http://127.0.0.1:${PORT}/conversation/playground"

cat >"$JS_FILE" <<'JS'
(async () => {
  window.__xfeelUiTestResult = null;
  try {
    const q = (s) => document.querySelector(s);
    const localDate = () => {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const waitFor = async (predicate, timeout = 12000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const value = predicate();
        if (value) return value;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('timeout waiting for UI state');
    };

    q('[data-testid="owner-select"]').value = 'demo-mom-owner';
    const expectedDate = localDate();
    const actualDate = q('[data-testid="date-input"]').value;
    if (actualDate !== expectedDate) {
      throw new Error(`default date mismatch: expected ${expectedDate}, got ${actualDate}`);
    }

    q('[data-testid="message-input"]').value = 'UI_TEST_STEP_ONE baby milestone happy';
    q('[data-testid="send-message"]').click();
    await waitFor(() => q('[data-testid="chat-log"]').textContent.includes('UI_TEST_STEP_ONE') && !q('[data-testid="send-message"]').disabled);

    q('[data-testid="message-input"]').value = 'UI_TEST_STEP_TWO night waking tired';
    q('[data-testid="send-message"]').click();
    await waitFor(() => q('[data-testid="chat-log"]').textContent.includes('UI_TEST_STEP_TWO') && !q('[data-testid="send-message"]').disabled);

    q('[data-testid="run-archive"]').click();
    await waitFor(() => q('[data-testid="status"]').textContent === 'archived', 20000);

    const chat = q('[data-testid="chat-log"]').textContent;
    const turns = q('[data-testid="turn-list"]').textContent;
    const archives = q('[data-testid="archive-list"]').textContent;

    if (!chat.includes('UI_TEST_STEP_ONE') || !chat.includes('UI_TEST_STEP_TWO') || !turns.includes('UI_TEST_STEP_ONE') || !turns.includes('UI_TEST_STEP_TWO')) {
      throw new Error('UI did not render submitted messages in chat and turn list: ' + JSON.stringify({ chat, turns }));
    }
    if (!document.querySelector('[data-testid="turn-list"] [data-archived="true"]')) {
      throw new Error('turn list did not show archived turns: ' + turns);
    }
    if (!document.querySelector('[data-testid="archive-list"] [data-event-count]')) {
      throw new Error('archive result did not show event count');
    }
    if (!archives.includes(expectedDate)) {
      throw new Error(`archive result did not use default local date ${expectedDate}: ` + archives);
    }

    window.__xfeelUiTestResult = { ok: true, status: 'archived', chat, turns, archives };
  } catch (error) {
    window.__xfeelUiTestResult = { ok: false, error: String(error && error.message ? error.message : error) };
  }
})();
JS

RESULT="$(osascript <<APPLESCRIPT
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  set URL of active tab of front window to "$PLAYGROUND_URL"
  delay 1
  set jsCode to read POSIX file "$JS_FILE"
  execute active tab of front window javascript jsCode
  repeat 80 times
    delay 0.5
    set resultText to execute active tab of front window javascript "window.__xfeelUiTestResult ? JSON.stringify(window.__xfeelUiTestResult) : ''"
    if resultText is not "" then return resultText
  end repeat
  error "timeout waiting for UI test result"
end tell
APPLESCRIPT
)"

echo "$RESULT"
if [[ "$RESULT" != *'"ok":true'* ]]; then
  echo "UI test failed" >&2
  exit 1
fi
