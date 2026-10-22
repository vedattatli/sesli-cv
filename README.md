# Sesli CV

Konuşarak CV hazırlayan web uygulaması. Kişi birkaç geniş soruyu kendi cümleleriyle, tek seferde anlatır (ör. "En son Kuzey Lojistik'te depo sorumlusuydum, 2021'den beri…"). Yapay zekâ bu anlatımdan alanları çıkarır ve profesyonel bir CV yazar. Sonunda gerçek metinli, ATS uyumlu bir PDF indirilir.

- Telefonda en iyi Android'de **Chrome**, iPhone'da **Safari** ile çalışır. Bilgisayarda Chrome ya da Edge önerilir.
- Profil seçimi (öğrenci, deneyimli, saha/usta, yazılım) soruları, bölüm sırasını ve varsayılan şablonu belirler.
- Yazılımcılar GitHub kullanıcı adını yazarak projelerini otomatik getirebilir.
- **İlana uyarla:** yapıştırılan iş ilanıyla eşleşen ve eksik olan noktaları gösterir. CV'de olmayan bir beceriyi kendiliğinden eklemez; önce kişiye sorar.
- **Ön yazı:** ilana göre tek sayfalık başvuru mektubu yazar (PDF ya da kopyalanabilir metin).
- **CV Kontrolü:** tarih çakışması, eksik ay, takma adlı e-posta gibi sorunları listeler. Puan vermez.
- PDF şablonları: Klasik, Sade (ATS için en güvenli) ve Modern.

## Gizlilik

- CV taslağı yalnızca kişinin kendi tarayıcısında saklanır. "Verilerimi sil" hepsini temizler.
- Yapay zekâ kullanılırken, kişinin onayından sonra cevap metinleri CV'yi yazmak için Anthropic'in Claude API'sine (ABD) gönderilir. Bu uygulamanın sunucusu metinleri saklamaz; kayıtlara yalnızca işlem türü, süre ve token sayısı yazılır.
- **Gönderilmeyenler:** telefon, e-posta, referanslar, doğum yılı, askerlik ve medeni durum ile fotoğraf.
- TC kimlik numarası (sağlama kontrolüyle), telefon, e-posta ve IBAN, metin gönderilmeden önce cihazda silinir.
- Ses tanıma tarayıcının kendi konuşma hizmetiyle yapılır (Chrome'da Google).
- **KVKK notu:** Verinin yurt dışına aktarılması KVKK md. 9'a tabidir. Herkese açık bir yayından önce hukuki inceleme yapılmalıdır. O zamana kadar yapay zekâ modunu davet koduyla (`ACCESS_CODE`) kapalı test olarak çalıştırın.

## Yapı

| Yol | Görevi |
|---|---|
| `public/index.html` | Sayfa, stiller ve simgeler |
| `public/app.js` | Görüşme akışı, elle doldurma adımları, fotoğraf, önizleme, PDF, ilana uyarla, ön yazı, CV kontrolü |
| `public/ai.js` | `/api/cv` istemcisi, gönderim öncesi kişisel veri temizleyici, CV veri dönüşümleri |
| `public/speech.js` | Konuşma tanıma ve soruları sesli okuma |
| `public/parse.js` | Türkçe metin düzeltici (tarih, telefon, e-posta, dil seviyeleri…) |
| `public/pdfdoc.js` | Klasik, Sade, Modern PDF şablonları ve ön yazı PDF'i (pdfmake 0.2.10) |
| `public/github.js` | Herkese açık GitHub depolarını ve README'leri getirir |
| `api/cv.py` | Vercel Python fonksiyonu: Claude Opus 5.5 ile `extract`, `review`, `finalize`, `edit`, `translate`, `tailor`, `cover`, `ping` |
| `api/_prompts.py`, `api/_schema.py` | Yazım kuralları (sistem istemi) ve yapılandırılmış çıktı şemaları |
| `dev_server.py` | Yerel geliştirme sunucusu (`CV_MOCK=1` ile yapay zekâsız deneme modu) |

## Bu bilgisayardan yayın (Vercel'siz)

`start-sesli-cv.command` dosyasına çift tıklayın. Başlatıcı şunları yapar:

- yerel sunucuyu (`dev_server.py`, gerçek Claude) ve hesapsız bir Cloudflare tünelini açar;
- Mac'i uyanık tutar;
- `https://…trycloudflare.com/#k=DAVETKODU` biçimindeki linki gösterir ve panoya kopyalar;
- gelen istekleri içeriklerini yazmadan listeler.

Pencere kapanınca her şey durur.

Gerekenler:
- `brew install cloudflared`
- `.env.local` dosyasında `ANTHROPIC_API_KEY` ve isteğe bağlı `ACCESS_CODE` satırları

Python ortamı (`.venv`) yoksa başlatıcı ilk açılışta kendisi kurar. Link her açılışta değişir ve yalnızca bilgisayar açıkken çalışır.

## Vercel'e kurulum

1. https://vercel.com/new adresinde bu depoyu içe aktarın. Framework olarak "Other" seçin; ayarlar `vercel.json`'dan okunur.
2. **Settings → Environment Variables** bölümüne şunları ekleyin:
   - `ANTHROPIC_API_KEY`: Anthropic Console'dan alınan anahtar.
   - `ACCESS_CODE` (önerilir): davet kodu. Davet linki `https://<adres>/#k=KOD` biçimindedir; kod bir kez okunur ve tarayıcıda saklanır.
3. Deploy edin.
4. Anthropic Console'da aylık harcama limiti koyun. Bir CV yaklaşık 0,3–0,5 $ tutar.

## Geliştirme

```bash
CV_MOCK=1 ./.venv/bin/python dev_server.py       # yapay zekâsız deneme modu, http://127.0.0.1:8787
set -a; . ./.env.local; set +a; ./.venv/bin/python dev_server.py   # gerçek Claude çağrılarıyla
```

Testler:

```bash
./.venv/bin/python -m unittest     # sunucu (Claude çağrısı yapmaz)
sh tests/run-parse.sh              # Türkçe düzeltici (macOS JavaScriptCore)
sh tests/run-pdfdoc.sh             # PDF şablonları
sh tests/run-ai.sh                 # istemci ve kişisel veri temizleyici
```

`tests/live_api_check.py` gerçek API'ye istek atar (kredi harcar); yalnızca istem değişikliklerinden sonra çalıştırın.
