#!/bin/sh
# pdfdoc.js testlerini Apple JavaScriptCore kabuğuyla (jsc) çalıştırır.
# Sıra: parse.js (gerçek CVParse) → pdfdoc.js → tests/pdfdoc.test.js, sonra aynı yükle tests/pdfdoc.v2.test.js.
# parse.js yoksa ya da pdfdoc.js'in kullandığı fonksiyonlardan biri eksikse test başlamadan başarısız olur.
# Herhangi bir başarısızlıkta çıkış kodu 1.
# Gerçek PDF üretip metin çıkaran QA testi ayrıdır: tests/run-pdf-qa.sh.

cd "$(dirname "$0")/.." || exit 1

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
if [ ! -x "$JSC" ]; then
  echo "pdfdoc: jsc bulunamadı: $JSC"
  exit 1
fi

if [ ! -f public/parse.js ]; then
  echo "pdfdoc: parse.js bulunamadı (pdfdoc.js, CVParse'a bağımlıdır)"
  exit 1
fi

# pdfdoc.js'in CVParse'tan kullandığı fonksiyonlar.
PROBE=$("$JSC" public/parse.js -e '
  var P = globalThis.CVParse;
  var need = ["splitList", "splitLines", "parseLanguages", "parseLanguageDetails", "languageDetailText", "levelLabel",
    "cefrLabel", "languageName", "formatRange", "formatDate", "fileName", "foldAscii", "trLower"];
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

fail=0
# run_suite <test file> <summary prefix>
run_suite() {
  out=$("$JSC" public/parse.js public/pdfdoc.js "$1" 2>&1)
  status=$?
  printf '%s\n' "$out"
  if [ "$status" -ne 0 ]; then
    fail=1
    return
  fi
  printf '%s\n' "$out" | grep -Eq "^$2: [0-9]+ passed, 0 failed\$" || fail=1
}

run_suite tests/pdfdoc.test.js pdfdoc
run_suite tests/pdfdoc.v2.test.js pdfdoc-v2

exit "$fail"
