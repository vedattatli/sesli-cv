# Sesli CV

Soruları sesli yanıtlayarak CV hazırlayan web uygulaması. Sorular tek tek ekranda yazar ve sesli okunur; kişi cevabını söyler, uygulama yazıya çevirir. Sonunda CV gerçek metinli (ATS uyumlu) bir PDF olarak indirilir ya da paylaşılır.

**Uygulama:** https://vedattatli.github.io/sesli-cv/

- Telefonda en iyi Android'de **Chrome**, iPhone'da **Safari** ile çalışır.
- Bilgiler yalnızca kullanıcının tarayıcısında saklanır; sunucuya gönderilmez. Ses tanıma tarayıcının konuşma hizmetiyle yapılır.

## Dosyalar

| Dosya | Görevi |
|---|---|
| `page.html` | Sayfa içeriği ve stiller |
| `app.js` | Adımlar, sesli asistan, fotoğraf, önizleme ve PDF |
| `speech.js` | Konuşma tanıma ve soruları sesli okuma |
| `parse.js` | Söylenenleri CV alanlarına çeviren Türkçe düzeltici |
| `pdfdoc.js` | Modern, Klasik ve Sade PDF şablonları (pdfmake) |
| `fonts.js` | PDF'e gömülen DM Serif Display yazı tipi (SIL OFL) |
| `build.py` | `site/` klasörünü üretir (yayınlanan sürüm) |

## Geliştirme

```bash
python3 build.py
python3 -m http.server 8765 --directory site
```

Testler (macOS'taki JavaScriptCore ile): `tests/run-parse.sh` ve `tests/run-pdfdoc.sh`.
