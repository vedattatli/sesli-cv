#!/bin/sh
# PDF metin çıkarma QA'sı (brief §4.1 "QA"): her şablon × profil örneği + tests/sample-cv.json + ön yazılar için
# GERÇEK PDF üretir (pdfmake 0.2.10, jsc), metni iki ayrıştırıcıyla çıkarır (pdfminer.six: düzen sırası,
# pypdf: akış sırası) ve tests/pdf-qa/check.py'deki 6 maddeyi denetler. Çıkış kodu 1 = başarısız.
#
# Bir kez hazırlık (geliştirici makinesi; uygulamaya ve requirements.txt'ye girmez):
#   mkdir -p tests/pdf-qa/.cache
#   curl -o tests/pdf-qa/.cache/pdfmake.js   https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js
#   curl -o tests/pdf-qa/.cache/vfs_fonts.js https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.min.js
#   python3 -m venv tests/pdf-qa/.venv && tests/pdf-qa/.venv/bin/pip install -r tests/requirements-dev.txt
# Çalıştırma:
#   sh tests/run-pdf-qa.sh            # PDF'ler ve çıktı: tests/pdf-qa/out/
#   sh tests/run-pdf-qa.sh --png      # ayrıca 1. (ve 2.) sayfaların PNG'si: tests/pdf-qa/out/png/ (macOS qlmanage)
# Ortam değişkenleri (isteğe bağlı): PDFMAKE_JS, ROBOTO_VFS_JS (vfs_fonts.js ya da ROBO_SUB tanımlayan bir dosya),
#   QA_PHOTO_JS (QA_PHOTO_34 / QA_PHOTO_SQ JPEG data URL'lerini tanımlayan dosya: fotoğraflı varyantlar),
#   PYTHON (pdfminer.six + pypdf kurulu yorumlayıcı), QA_OUT (çıktı klasörü).

cd "$(dirname "$0")/.." || exit 1
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
PDFMAKE_JS="${PDFMAKE_JS:-tests/pdf-qa/.cache/pdfmake.js}"
ROBOTO_VFS_JS="${ROBOTO_VFS_JS:-tests/pdf-qa/.cache/vfs_fonts.js}"
QA_OUT="${QA_OUT:-tests/pdf-qa/out}"
if [ -z "$PYTHON" ]; then
  if [ -x tests/pdf-qa/.venv/bin/python ]; then PYTHON=tests/pdf-qa/.venv/bin/python; else PYTHON=python3; fi
fi

[ -x "$JSC" ] || { echo "pdf-qa: jsc bulunamadı: $JSC"; exit 1; }
[ -f "$PDFMAKE_JS" ] || { echo "pdf-qa: pdfmake 0.2.10 yok: $PDFMAKE_JS (bkz. dosyanın başı)"; exit 1; }
[ -f "$ROBOTO_VFS_JS" ] || { echo "pdf-qa: Roboto vfs yok: $ROBOTO_VFS_JS (bkz. dosyanın başı)"; exit 1; }
"$PYTHON" -c 'import pdfminer, pypdf' 2>/dev/null || { echo "pdf-qa: $PYTHON için pdfminer.six ve pypdf gerekli (tests/requirements-dev.txt)"; exit 1; }

rm -rf "$QA_OUT" && mkdir -p "$QA_OUT" || exit 1
PHOTO=""
[ -n "$QA_PHOTO_JS" ] && PHOTO="$QA_PHOTO_JS"
if [ -n "$PHOTO" ]; then
  "$JSC" tests/pdf-qa/shim.js "$PDFMAKE_JS" "$ROBOTO_VFS_JS" public/fonts.js public/parse.js public/pdfdoc.js "$PHOTO" tests/pdf-qa/gen.js > "$QA_OUT/dump.txt" 2>&1
else
  "$JSC" tests/pdf-qa/shim.js "$PDFMAKE_JS" "$ROBOTO_VFS_JS" public/fonts.js public/parse.js public/pdfdoc.js tests/pdf-qa/gen.js > "$QA_OUT/dump.txt" 2>&1
fi
grep -q '^END ' "$QA_OUT/dump.txt" || { echo "pdf-qa: PDF üretimi bitmedi:"; grep -v '^PDF \|^DOC ' "$QA_OUT/dump.txt" | head -20; exit 1; }
"$PYTHON" tests/pdf-qa/check.py "$QA_OUT/dump.txt" "$QA_OUT" "$@"
