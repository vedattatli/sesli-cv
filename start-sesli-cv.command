#!/bin/bash
# Sesli CV'yi bu bilgisayardan yayınlar: yerel sunucu (dev_server.py, gerçek Claude) + Cloudflare
# tüneli (hesapsız, https). Çift tıklayınca Terminal'de açılır; pencere kapanınca her şey durur.
# Gerekenler: .env.local (ANTHROPIC_API_KEY, isteğe bağlı ACCESS_CODE), python3, cloudflared.

cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8787}"
LOGDIR="$PWD/.logs"
mkdir -p "$LOGDIR"

say() { printf '%s\n' "$*"; }
fail() { say ""; say "  ❌ $*"; say ""; read -r -p "  Kapatmak için Enter'a basın. " _; exit 1; }

printf '\033]0;Sesli CV\007'
clear
say ""
say "  Sesli CV başlatılıyor…"

# 1) API anahtarı (ekrana yazılmaz)
[ -f .env.local ] && grep -q '^ANTHROPIC_API_KEY=.' .env.local || fail ".env.local dosyasında ANTHROPIC_API_KEY yok."
set -a; . ./.env.local; set +a

# 2) Python ortamı (proje taşınırsa bir kez yeniden kurulur)
if ! ./.venv/bin/python -c 'import anthropic' >/dev/null 2>&1; then
  say "  Python ortamı hazırlanıyor (yalnızca ilk seferde, 1 dakika kadar)…"
  rm -rf .venv
  python3 -m venv .venv && ./.venv/bin/python -m pip install -q -r requirements.txt \
    || fail "Python ortamı kurulamadı. İnternet bağlantınızı kontrol edin."
fi

# 3) Tünel programı
CF="$(command -v cloudflared 2>/dev/null)"
[ -z "$CF" ] && [ -x /opt/homebrew/bin/cloudflared ] && CF=/opt/homebrew/bin/cloudflared
[ -x "$CF" ] || fail "cloudflared bulunamadı. Terminal'de şunu çalıştırın: brew install cloudflared"

# 4) Zaten açık mı?
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Sesli CV zaten açık görünüyor (port $PORT kullanımda). Diğer Sesli CV penceresini kapatıp tekrar deneyin."
fi

# Yalnızca yerel testte kullanılan sahte dosyalar internete açılmasın.
rm -f public/dev.html public/fake-sr.js public/fake-ai.js public/sample-cv.json

cleanup() {
  trap - EXIT INT TERM HUP
  kill $(jobs -p) 2>/dev/null
  wait 2>/dev/null
  say ""
  say "  Sesli CV kapatıldı. Link artık çalışmıyor."
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP

# 5) Sunucu
CV_TRUST_CF=1 PORT="$PORT" ./.venv/bin/python dev_server.py >"$LOGDIR/server.log" 2>&1 &
SRV=$!
for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  kill -0 "$SRV" 2>/dev/null || fail "Sunucu başlamadı. Ayrıntı: .logs/server.log"
  sleep 0.25
done

# 6) Cloudflare tüneli: her açılışta yeni bir https adresi
"$CF" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$LOGDIR/tunnel.log" 2>&1 &
TUN=$!
URL=""
for _ in $(seq 1 120); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGDIR/tunnel.log" | head -1)"
  [ -n "$URL" ] && break
  kill -0 "$TUN" 2>/dev/null || break
  sleep 0.5
done
[ -n "$URL" ] || fail "Tünel açılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin. Ayrıntı: .logs/tunnel.log"

# 7) Pencere açık kaldıkça Mac uyumasın
caffeinate -dimsu -w $$ &

LINK="$URL/"
[ -n "$ACCESS_CODE" ] && LINK="$URL/#k=$ACCESS_CODE"
printf '%s' "$LINK" | pbcopy

# Wait until the tunnel is registered at Cloudflare, then give the new hostname a few seconds to
# reach DNS. Deliberately no lookup from this Mac before that: an early "not found" is cached by
# macOS for about a minute, and the link would then fail here while it works everywhere else.
say "  Bağlantı hazırlanıyor…"
for _ in $(seq 1 60); do
  grep -q 'Registered tunnel connection' "$LOGDIR/tunnel.log" && break
  kill -0 "$TUN" 2>/dev/null || fail "Tünel kapandı. İnternet bağlantınızı kontrol edip tekrar deneyin. Ayrıntı: .logs/tunnel.log"
  sleep 0.5
done
# End-to-end check through a Cloudflare edge address (trycloudflare.com itself is in DNS), so the
# new hostname is never looked up from this Mac before it exists.
HOST="${URL#https://}"
EDGE="$(./.venv/bin/python -c 'import socket; print(socket.gethostbyname("trycloudflare.com"))' 2>/dev/null)"
READY=""
if [ -n "$EDGE" ]; then
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$HOST:443:$EDGE" "$URL/")" = "200" ] && READY=1 && break
    sleep 1
  done
fi
sleep 10  # time for the new name to appear in DNS before the link is shared

clear
say ""
say "  ✅ Sesli CV açık. Bu linki arkadaşınıza gönderin (panoya kopyalandı, yapıştırmanız yeterli):"
say ""
say "     $LINK"
say ""
# QR code for opening the link on a phone (black on white, whatever the Terminal theme).
if ./.venv/bin/python -c 'import qrcode' >/dev/null 2>&1 || ./.venv/bin/python -m pip install -q qrcode >/dev/null 2>&1; then
  say "  Kendi telefonunuzda denemek için kamerayla okutun:"
  say ""
  ./.venv/bin/python - "$LINK" <<'PY' 2>/dev/null
import sys, qrcode
q = qrcode.QRCode(border=2, error_correction=qrcode.constants.ERROR_CORRECT_L)
q.add_data(sys.argv[1]); q.make(fit=True)
m = q.get_matrix()
if len(m) % 2:
    m.append([False] * len(m[0]))
BLACK, WHITE = 16, 231
for y in range(0, len(m), 2):
    row = "".join("\033[38;5;%dm\033[48;5;%dm▀" % (BLACK if top else WHITE, BLACK if bottom else WHITE)
                  for top, bottom in zip(m[y], m[y + 1]))
    print("     " + row + "\033[0m")
PY
  say ""
fi
say "  • Bu pencere açık ve bilgisayar internete bağlı kaldıkça çalışır."
say "    Dizüstüyse kapağı kapatmayın; ekran kararabilir ama uyku moduna geçmez."
say "  • Link her açılışta değişir; yeniden açtığınızda yeni linki gönderin."
say "  • Link bu bilgisayarda hemen açılmazsa bir dakika sonra yeniden deneyin; telefonda bu sorun olmaz."
[ -n "$READY" ] || say "  • Uyarı: bağlantı henüz doğrulanamadı; bir sorun olursa pencereyi kapatıp yeniden başlatın."
say "  • Kapatmak için bu pencereyi kapatın ya da Ctrl+C'ye basın."
say ""
say "  Gelen istekler:"

# 8) Etkinlik: yalnızca işlem adı, sonuç ve süre (cevapların içeriği hiçbir yere yazılmaz)
tail -n 0 -F "$LOGDIR/server.log" 2>/dev/null | ./.venv/bin/python -u -c '
import json, sys, time
NAMES = {"extract": "cevap işlendi", "review": "eksik bilgiler soruldu", "finalize": "CV son hâline getirildi",
         "edit": "değişiklik uygulandı", "translate": "İngilizceye çevrildi", "tailor": "ilana uyarlandı",
         "cover": "ön yazı yazıldı", "ping": "biri uygulamayı açtı"}
for line in sys.stdin:
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if not isinstance(d, dict) or "op" not in d:
        continue
    st = d.get("status")
    mark = "✓" if st == 200 else "✗ (" + str(st) + (" davet kodu yanlış" if st == 401 else "") + ")"
    print("   ", time.strftime("%H:%M"), mark, NAMES.get(d["op"], d["op"]), "· %.1f sn" % (d.get("ms", 0) / 1000), flush=True)
' &

while kill -0 "$SRV" 2>/dev/null && kill -0 "$TUN" 2>/dev/null; do sleep 2; done
fail "Sunucu ya da tünel durdu. Pencereyi kapatıp Sesli CV'yi yeniden başlatın. Ayrıntı: .logs/"
