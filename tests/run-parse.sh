#!/bin/sh
# Runs tests/parse.test.js and tests/parse.adversarial.test.js with Apple's JavaScriptCore shell.
# Exits 1 on any failure.
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc

cd "$(dirname "$0")/.." || exit 1

if [ ! -x "$JSC" ]; then
  echo "parse: jsc not found at $JSC"
  exit 1
fi

fail=0
# run_suite <file> <summary prefix>
run_suite() {
  out=$("$JSC" "$1" 2>&1)
  status=$?
  printf '%s\n' "$out"
  if [ "$status" -ne 0 ]; then
    fail=1
    return
  fi
  # Belt and braces: require the summary line with zero failures.
  printf '%s\n' "$out" | grep -Eq "^$2: [0-9]+ passed, 0 failed\$" || fail=1
}

run_suite tests/parse.test.js parse
run_suite tests/parse.adversarial.test.js parse-adversarial

exit "$fail"
