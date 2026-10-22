#!/bin/sh
# Runs the AI-side suites with Apple's JavaScriptCore shell (jsc):
#   tests/ai.test.js   public/ai.js (scrubber, toAI/fromAI, call()) and the fake API tests/fake-ai.js.
#                      It stubs window, localStorage, location, history, fetch and Response, then loads
#                      tests/fake-ai.js, public/parse.js and public/ai.js in that order.
#   tests/app.test.js  public/app.js behaviour on the small browser in tests/app-env.js, once per
#                      scenario (desktop, android, v1); pdfdoc.js is stubbed there.
# Exits 1 on any failure.
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc

cd "$(dirname "$0")/.." || exit 1

if [ ! -x "$JSC" ]; then
  echo "ai: jsc not found at $JSC"
  exit 1
fi
for f in public/parse.js public/ai.js public/speech.js public/github.js public/app.js tests/fake-ai.js tests/ai.test.js tests/app-env.js tests/app.test.js; do
  if [ ! -f "$f" ]; then
    echo "ai: missing $f"
    exit 1
  fi
done

fail=0
# run_suite <summary prefix> <jsc args…>
run_suite() {
  prefix="$1"
  shift
  out=$("$JSC" "$@" 2>&1)
  status=$?
  printf '%s\n' "$out"
  if [ "$status" -ne 0 ]; then
    fail=1
    return
  fi
  # Belt and braces: require the summary line with zero failures.
  printf '%s\n' "$out" | grep -Eq "^$prefix: [0-9]+ passed, 0 failed\$" || fail=1
}

run_suite ai tests/ai.test.js
for scenario in desktop android v1; do
  run_suite "app-$scenario" tests/app-env.js tests/app.test.js -- "$scenario"
done

exit "$fail"
