#!/bin/sh
# pdfdoc.js testlerini Apple JavaScriptCore kabuğuyla (jsc) çalıştırır.
# Sıra: parse.js (gerçek CVParse) → pdfdoc.js → tests/pdfdoc.test.js
# parse.js yoksa ya da pdfdoc.js'in kullandığı fonksiyonlardan biri eksikse test başlamadan başarısız olur.
# Herhangi bir başarısızlıkta çıkış kodu 1.

cd "$(dirname "$0")/.." || exit 1

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
if [ ! -x "$JSC" ]; then
  echo "pdfdoc: jsc bulunamadı: $JSC"
  exit 1
fi

if [ ! -f parse.js ]; then
  echo "pdfdoc: parse.js bulunamadı (pdfdoc.js, CVParse'a bağımlıdır)"
  exit 1
fi

# pdfdoc.js'in CVParse'tan kullandığı fonksiyonlar.
PROBE=$("$JSC" parse.js -e '
  var P = globalThis.CVParse;
  var need = ["splitList", "splitLines", "parseLanguages", "levelLabel", "languageName", "formatRange", "fileName"];
  var missing = P ? need.filter(function (f) { return typeof P[f] !== "function"; }) : need;
  print(missing.length ? "PARSE_MISSING " + missing.join(",") : "PARSE_OK");
' 2>&1)
case "$PROBE" in
  *PARSE_OK*) ;;
  *)
    echo "pdfdoc: parse.js eksik ya da yüklenemedi: $PROBE"
    exit 1
    ;;
esac

OUT=$("$JSC" parse.js pdfdoc.js tests/pdfdoc.test.js 2>&1)
STATUS=$?
printf '%s\n' "$OUT"

if [ "$STATUS" -ne 0 ]; then
  exit 1
fi
if printf '%s\n' "$OUT" | grep -Eq '^pdfdoc: [0-9]+ passed, 0 failed$'; then
  exit 0
fi
exit 1
