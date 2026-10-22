/*
 * tests/parse.test.js — table-driven tests for parse.js (CVParse).
 * Run from the project folder with Apple's JavaScriptCore shell:  tests/run-parse.sh
 * Every normalizer table also asserts idempotence: f(expected) === expected.
 */
/* global load, print */
globalThis.console = { log: print, error: print };
load('public/parse.js');

var P = globalThis.CVParse;
var passed = 0, failed = 0;

function show(v) { return v === undefined ? 'undefined' : JSON.stringify(v); }
function check(label, actual, expected) {
  if (show(actual) === show(expected)) { passed++; return; }
  failed++;
  print('FAIL ' + label + '\n     expected: ' + show(expected) + '\n     actual:   ' + show(actual));
}
function call(name, args) {
  try { return P[name].apply(null, args); } catch (e) { return 'THREW ' + e; }
}
function label(name, args) { return name + '(' + args.map(show).join(', ') + ')'; }

// rows: [arg1, ..., expected]
function table(name, rows) {
  rows.forEach(function (r) {
    var args = r.slice(0, -1);
    check(label(name, args), call(name, args), r[r.length - 1]);
  });
}
// Same as table() for one-argument functions, plus the fixed-point check f(expected) === expected.
function normTable(name, rows) {
  rows.forEach(function (r) {
    check(label(name, [r[0]]), call(name, [r[0]]), r[1]);
    check('idempotent ' + label(name, [r[1]]), call(name, [r[1]]), r[1]);
  });
}

// ---------------------------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------------------------
['trLower', 'trUpper', 'capFirst', 'titleCase', 'cleanSpaces', 'foldAscii', 'fileName',
  'wordsToNumbers', 'normalizeName', 'normalizeTitle', 'normalizeCity', 'normalizeEmail',
  'normalizeUrl', 'normalizePhone', 'normalizeDate', 'formatDate', 'formatRange',
  'applySpokenPunctuation', 'normalizeSegment', 'mergeSegment', 'detectCommand', 'splitList',
  'splitLines', 'parseLanguages', 'levelLabel', 'languageName'
].forEach(function (fn) { check('typeof CVParse.' + fn, typeof P[fn], 'function'); });

// ---------------------------------------------------------------------------------------------
// Casing / text
// ---------------------------------------------------------------------------------------------
normTable('trLower', [
  ['İSTANBUL', 'istanbul'],
  ['IŞIK', 'ışık'],
  ['IĞDIR', 'ığdır'],
  ['İzmir', 'izmir'],
  ['ÇĞÖŞÜ', 'çğöşü'],
  ['LinkedIn', 'linkedın'],          // only the capital I becomes dotless
  ['i̇stanbul', 'istanbul'],
  ['abc 123', 'abc 123'],
  ['', '']
]);
table('trLower', [[null, ''], [undefined, '']]);

normTable('trUpper', [
  ['istanbul', 'İSTANBUL'],
  ['ışık', 'IŞIK'],
  ['iğdır', 'İĞDIR'],
  ['çğöşü', 'ÇĞÖŞÜ'],
  ['', '']
]);

normTable('capFirst', [
  ['istanbul', 'İstanbul'],
  ['ışık var', 'Işık var'],
  ['çalıştım', 'Çalıştım'],
  ['  ali veli', '  Ali veli'],
  ['"merhaba" dedi', '"Merhaba" dedi'],
  ["'ali'", "'Ali'"],
  ['2019 yılında', '2019 yılında'],
  ['Ali', 'Ali'],
  ['', '']
]);
table('capFirst', [[null, '']]);

normTable('titleCase', [
  ['ayşe yılmaz', 'Ayşe Yılmaz'],
  ['kıdemli muhasebe uzmanı', 'Kıdemli Muhasebe Uzmanı'],
  ['ODTÜ bilgisayar mühendisliği', 'ODTÜ Bilgisayar Mühendisliği'],
  ['İTÜ', 'İTÜ'],
  ['SAP danışmanı', 'SAP Danışmanı'],
  ['IT uzmanı', 'IT Uzmanı'],
  ['iPhone geliştirici', 'iPhone Geliştirici'],
  ['LinkedIn profili', 'LinkedIn Profili'],
  ['McKinsey danışmanı', 'McKinsey Danışmanı'],
  ["ODTÜ'de okudum", "ODTÜ'de Okudum"],
  ['ar-ge ve inovasyon müdürü', 'Ar-Ge ve İnovasyon Müdürü'],
  ['ayşe-nur', 'Ayşe-Nur'],
  ["ali'nin", "Ali'nin"],
  ["İSTANBUL'DA", "İstanbul'da"],
  ['satış ve pazarlama', 'Satış ve Pazarlama'],
  ['ve ile başlayan', 'Ve ile Başlayan'],
  ['ya da veya', 'Ya da veya'],
  ['insan kaynakları için uzman', 'İnsan Kaynakları için Uzman'],
  ['bank of america', 'Bank of America'],
  ['head of sales and marketing', 'Head of Sales and Marketing'],
  ['research & development', 'Research & Development'],
  ['ışıl ilgaz', 'Işıl İlgaz'],
  ['istanbul', 'İstanbul'],
  ['İSTANBUL', 'İstanbul'],
  ['AYŞE YILMAZ', 'AYŞE Yılmaz'], // spec: all-caps ≤5 letters is kept (normalizeName handles this)
  ['abc yazılım a.ş.', 'Abc Yazılım A.Ş.'],
  ['u.s.a. satış müdürü', 'U.S.A. Satış Müdürü'],
  ['ltd. şti.', 'Ltd. Şti.'],
  ['', '']
]);

normTable('cleanSpaces', [
  ['  ayşe   yılmaz  ', 'ayşe yılmaz'],
  ['a\t\tb', 'a b'],
  ['a  b', 'a b'],
  ['satır 1  \n   satır 2', 'satır 1\nsatır 2'],
  ['a\r\nb', 'a\nb'],
  ['\n\nmetin\n', 'metin'],
  ['', '']
]);

normTable('foldAscii', [
  ['çğıöşü ÇĞİÖŞÜ', 'cgiosu CGIOSU'],
  ['hâlâ', 'hala'],
  ['Âşık', 'Asik'],
  ['îmân ûmumi', 'iman umumi'],
  ['abc-123', 'abc-123'],
  ['', '']
]);

table('fileName', [
  ['Ayşe Yılmaz', 'Ayse_Yilmaz_CV.pdf'],
  ['', 'CV.pdf'],
  [undefined, 'CV.pdf'],
  ['  Çağrı   Öztürk  ', 'Cagri_Ozturk_CV.pdf'],
  ['Ayşe-Nur Şahin', 'Ayse-Nur_Sahin_CV.pdf'],
  ['İsmail Işık', 'Ismail_Isik_CV.pdf'],
  ['José Müller', 'Jose_Muller_CV.pdf'],
  ['Ali / Veli?', 'Ali_Veli_CV.pdf'],
  ['Ayşe Yılmaz', 'Özgeçmiş', 'Ayse_Yilmaz_Ozgecmis.pdf'],
  ['Ayşe Yılmaz', 'Ozgecmis', 'docx', 'Ayse_Yilmaz_Ozgecmis.docx'],
  ['Ayşe Yılmaz', '', 'pdf', 'Ayse_Yilmaz.pdf']
]);

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------
normTable('wordsToNumbers', [
  // spec examples
  ['iki bin on dokuz', '2019'],
  ['bin dokuz yüz doksan sekiz', '1998'],
  ['sıfır beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', '0 532 123 45 67'],
  ['beş yıl', '5 yıl'],
  ['on iki', '12'],
  ['yüz', '100'],
  // whole words only
  ['onur', 'onur'],
  ['bina', 'bina'],
  ['yedinci', 'yedinci'],
  ['birlikte', 'birlikte'],
  ['onur ile birlikte bina yedinci katta', 'onur ile birlikte bina yedinci katta'],
  ['altında', 'altında'],
  ['4bir', '4bir'],
  // case-insensitive
  ['Bin', '1000'],
  ['İKİ BİN YİRMİ', '2020'],
  ['Yirmi Beş', '25'],
  // slot rules
  ['sıfır', '0'],
  ['sıfır sıfır', '0 0'],
  ['yüz bir', '101'],
  ['bir yüz', '1 100'],
  ['beş yüz', '500'],
  ['iki yüz yirmi üç', '223'],
  ['altı yüz', '600'],
  ['on bin', '10000'],
  ['yüz bin', '100000'],
  ['iki yüz elli bin', '250000'],
  ['dokuz yüz doksan dokuz bin dokuz yüz doksan dokuz', '999999'],
  ['bin dokuz yüz', '1900'],
  ['bin bin', '1000 1000'],
  ['iki on', '2 10'],
  ['kırk beş altmış yedi', '45 67'],
  ['beş üç iki', '5 3 2'],
  // context preserved
  ["dokuz'da", "9'da"],
  ["iki bin on dokuz'da", "2019'da"],
  ['beş yıl iki ay', '5 yıl 2 ay'],
  ['on, iki', '10, 2'],
  ['iki bin yirmi üç ocak', '2023 ocak'],
  ['2019', '2019'],
  ['', '']
]);

// ---------------------------------------------------------------------------------------------
// Field normalizers
// ---------------------------------------------------------------------------------------------
normTable('normalizeName', [
  ['ayşe yılmaz', 'Ayşe Yılmaz'],
  ['  ayşe   yılmaz. ', 'Ayşe Yılmaz'],
  ['ali veli!', 'Ali Veli'],
  ['AYŞE YILMAZ', 'Ayşe Yılmaz'],
  ['İSMAİL IŞIK', 'İsmail Işık'],
  ['ışıl ilgaz', 'Işıl İlgaz'],
  ['ayşe-nur öztürk', 'Ayşe-Nur Öztürk'],
  ['ayşe\nyılmaz', 'Ayşe Yılmaz'],
  ['AYŞE NUR YILMAZ', 'Ayşe Nur Yılmaz'],
  ['ali KAYA', 'Ali KAYA'],              // mixed input: ≤5-letter capitals kept as typed
  ['A.Ş. i', 'A.Ş. İ'],                  // fuzz regression: must be a fixed point
  ['ahmet can', 'Ahmet Can'],
  ['Ayşe Yılmaz', 'Ayşe Yılmaz'],
  ['', '']
]);

normTable('normalizeTitle', [
  ['kıdemli muhasebe uzmanı', 'Kıdemli Muhasebe Uzmanı'],
  ['insan kaynakları ve idari işler müdürü', 'İnsan Kaynakları ve İdari İşler Müdürü'],
  ['IT destek uzmanı', 'IT Destek Uzmanı'],
  ['SAP FI danışmanı', 'SAP FI Danışmanı'],
  ['head of product', 'Head of Product'],
  ['satış ve pazarlama sorumlusu.', 'Satış ve Pazarlama Sorumlusu'],
  ['Kıdemli Muhasebe Uzmanı', 'Kıdemli Muhasebe Uzmanı'],
  ['', '']
]);

normTable('normalizeCity', [
  ['istanbul', 'İstanbul'],
  ['izmir', 'İzmir'],
  ['ığdır', 'Iğdır'],
  ['şanlıurfa', 'Şanlıurfa'],
  ['kadıköy istanbul', 'Kadıköy İstanbul'],
  ['ANKARA', 'Ankara'],
  ['ABD', 'ABD'],
  ['berlin almanya', 'Berlin Almanya'],
  ['İstanbul', 'İstanbul'],
  ['', '']
]);

normTable('normalizeEmail', [
  ['ayşe kaya 4 et gmail nokta com', 'aysekaya4@gmail.com'],
  ['ahmet yılmaz et hotmail nokta com', 'ahmetyilmaz@hotmail.com'],   // "Ahmet" keeps its "et"
  ['Ahmet Et Gmail Nokta Com', 'ahmet@gmail.com'],
  ['ahmet at gmail nokta com', 'ahmet@gmail.com'],
  ['mehmet et işareti outlook nokta com nokta tr', 'mehmet@outlook.com.tr'],
  ['ayşe alt çizgi yılmaz at işareti gmail dot com', 'ayse_yilmaz@gmail.com'],
  ['ali alt tire veli et x nokta com', 'ali_veli@x.com'],
  ['ali underscore veli at x dot com', 'ali_veli@x.com'],
  ['ali tire veli et firma nokta com', 'ali-veli@firma.com'],
  ['ali kısa çizgi veli et firma nokta com', 'ali-veli@firma.com'],
  ['ali eksi veli et firma nokta com', 'ali-veli@firma.com'],
  ['ayşe nokta nokta yılmaz et gmail nokta com nokta', 'ayse.yilmaz@gmail.com'],
  ['ayse et gmail.com', 'ayse@gmail.com'],
  ['ayse @ gmail.com', 'ayse@gmail.com'],
  // typed
  ['ayse.yilmaz@gmail.com', 'ayse.yilmaz@gmail.com'],
  ['  Ayse.Yilmaz@Gmail.COM  ', 'ayse.yilmaz@gmail.com'],
  ['AYSE.KAYA@GMAIL.COM', 'ayse.kaya@gmail.com'],
  ['ahmet.at@gmail.com', 'ahmet.at@gmail.com'],
  ['ayşe@gmail.com', 'ayse@gmail.com'],
  ['ayse@gmail.com.', 'ayse@gmail.com'],
  ['', '']
]);

normTable('normalizeUrl', [
  ['linkedin nokta com slash in slash ayşe yılmaz', 'linkedin.com/in/ayseyilmaz'],
  ['github nokta com eğik çizgi ayşe tire yılmaz', 'github.com/ayse-yilmaz'],
  ['behance nokta net bölü ayşe alt çizgi y', 'behance.net/ayse_y'],
  ['site nokta com taksim portfolyo', 'site.com/portfolyo'],
  ['www nokta ayşe nokta dev', 'ayse.dev'],
  ['https iki nokta slash slash ayşe nokta com', 'ayse.com'],
  ['https://www.linkedin.com/in/ayse', 'linkedin.com/in/ayse'],
  ['http://ayseyilmaz.com', 'ayseyilmaz.com'],
  ['HTTPS://WWW.LINKEDIN.COM/IN/AYSE', 'linkedin.com/in/ayse'],
  ['linkedin.com/in/ayseyilmaz', 'linkedin.com/in/ayseyilmaz'],
  ['linkedin.com/in/ayse/', 'linkedin.com/in/ayse/'],
  ['', '']
]);

normTable('normalizePhone', [
  ['sıfır beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', '0532 123 45 67'],
  ['sıfır 532 123 45 67', '0532 123 45 67'],
  ['0532 123 45 67', '0532 123 45 67'],
  ['05321234567', '0532 123 45 67'],
  ['0532-123-45-67', '0532 123 45 67'],
  ['5321234567', '0532 123 45 67'],
  ['532 123 45 67', '0532 123 45 67'],
  ['2123456789', '0212 345 67 89'],
  ['0 (212) 345 67 89', '0212 345 67 89'],
  ['905321234567', '+90 532 123 45 67'],
  ['+90 532 123 45 67', '+90 532 123 45 67'],
  ['+90 (532) 123-45-67', '+90 532 123 45 67'],
  ['artı 90 beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', '+90 532 123 45 67'],
  ['telefonum 0532 123 45 67', '0532 123 45 67'],
  ['(532) 123 45 67', '0532 123 45 67'],
  ['0 532 123 4567', '0532 123 45 67'],
  ['sıfır beş üç iki bir iki üç dört beş altı yedi', '0532 123 45 67'],  // digit by digit
  ['0532 123 45 67 / 0212 345 67 89', '0532 123 45 67 / 0212 345 67 89'],
  // not Turkish / not complete → cleaned original
  ['+49 151 2345 6789', '+49 151 2345 6789'],
  ['  +49   151 2345 6789 ', '+49 151 2345 6789'],
  ['+4930123456', '+4930123456'],
  ['1234567890', '1234567890'],
  ['0532 123 45 67 8', '0532 123 45 67 8'],
  ['0 532', '0 532'],
  ['123', '123'],
  ['', '']
]);

normTable('normalizeDate', [
  ['mart iki bin on dokuz', 'Mart 2019'],
  ['Mart 2019', 'Mart 2019'],
  ['2019', '2019'],
  ["2019'dan", '2019'],
  ['2019da', '2019'],
  ["2019'da başladım", '2019'],
  ['iki bin yirmi', '2020'],
  ['mayısta', 'Mayıs'],
  ['eylülde', 'Eylül'],
  ["Mart'ta", 'Mart'],
  ['2019 eylülde', 'Eylül 2019'],
  ["eylül 2019'da", 'Eylül 2019'],
  ['aralıkta iki bin yirmi bir', 'Aralık 2021'],
  ['bin dokuz yüz doksan sekiz haziran', 'Haziran 1998'],
  ['  temmuz   2021  ', 'Temmuz 2021'],
  ['subat 2020', 'Şubat 2020'],
  ['agustos 2018', 'Ağustos 2018'],
  ['eylul 2017', 'Eylül 2017'],
  ['kasim 2016', 'Kasım 2016'],
  ['aralik 2015', 'Aralık 2015'],
  ['mayis 2014', 'Mayıs 2014'],
  ['ocak', 'Ocak'],
  // numeric forms
  ['03/2019', 'Mart 2019'],
  ['3.2019', 'Mart 2019'],
  ['2019-03', 'Mart 2019'],
  ['03-2019', 'Mart 2019'],
  ['15.03.2019', 'Mart 2019'],
  ['2019-03-15', 'Mart 2019'],
  ['13/2019', '2019'],
  // English
  ['march 2019', 'Mart 2019'],
  ['Sep 2020', 'Eylül 2020'],
  ['May 2018', 'Mayıs 2018'],
  ['may', 'May'],         // "may" is a month only together with a year
  ['dec', 'Aralık'],
  // present
  ['devam ediyor', 'Devam ediyor'],
  ['devam', 'Devam ediyor'],
  ['hala', 'Devam ediyor'],
  ['hâlâ çalışıyorum', 'Devam ediyor'],
  ['halen', 'Devam ediyor'],
  ['şu an', 'Devam ediyor'],
  ['şu anda çalışıyorum', 'Devam ediyor'],
  ['şuan', 'Devam ediyor'],
  ['şimdi', 'Devam ediyor'],
  ['günümüz', 'Devam ediyor'],
  ['günümüze kadar', 'Devam ediyor'],
  ['present', 'Devam ediyor'],
  ['Current', 'Devam ediyor'],
  ['now', 'Devam ediyor'],
  ['still', 'Devam ediyor'],
  ['Devam ediyor', 'Devam ediyor'],
  // other
  ['ekim 2010 mart 2012', 'Ekim 2010'],
  ['2019 yılının mart ayında', 'Mart 2019'],
  ['iki bin yirmi bir yılının eylül ayı', 'Eylül 2021'],
  ['15 Mart 2019', 'Mart 2019'],
  ['10.2019', 'Ekim 2019'],
  ['ekip lideri', 'Ekip lideri'],          // "ekip" is not "ekim"
  ['presentation', 'Presentation'],        // not the keyword "present"
  ['2015-2019', '2015'],
  ['beş yıl önce', '5 yıl önce'],
  ['bilmiyorum', 'Bilmiyorum'],
  ['', '']
]);

table('formatDate', [
  ['Mart 2019', 'Mart 2019'],
  ['Mart 2019', 'tr', 'Mart 2019'],
  ['Mart 2019', 'en', 'Mar 2019'],
  ['Ağustos 2020', 'en', 'Aug 2020'],
  ['Şubat 2020', 'en', 'Feb 2020'],
  ['Aralık 2021', 'en', 'Dec 2021'],
  ['Mayıs', 'en', 'May'],
  ['March 2019', 'tr', 'Mart 2019'],
  ['Sep 2018', 'tr', 'Eylül 2018'],
  ['03/2019', 'en', 'Mar 2019'],
  ['2019', 'tr', '2019'],
  ['2019', 'en', '2019'],
  ["2019'da", 'tr', '2019'],
  ['Sept. 2019', 'tr', 'Eylül 2019'],
  ['iki bin on dokuz', 'en', '2019'],
  // extra words → printed as written (nothing the person typed disappears)
  ["2019'dan beri", 'tr', "2019'dan beri"],
  ['Yaz 2019', 'en', 'Yaz 2019'],
  ['15.03.2019', 'en', '15.03.2019'],
  ['presentation', 'en', 'presentation'],
  ['Devam ediyor', 'tr', 'Günümüz'],
  ['Devam ediyor', 'en', 'Present'],
  ['Present', 'tr', 'Günümüz'],
  ['Present', 'en', 'Present'],
  ['Günümüz', 'en', 'Present'],
  ['Günümüz', 'tr', 'Günümüz'],
  ['yaz dönemi', 'tr', 'yaz dönemi'],
  ['  yaz dönemi ', 'en', 'yaz dönemi'],
  ['', 'tr', ''],
  [null, 'en', '']
]);
// formatDate output is stable when fed back
['Mart 2019', 'Mayıs 2019', 'Devam ediyor', '2019', 'Sep 2018', 'May', 'yaz dönemi'].forEach(function (x) {
  ['tr', 'en'].forEach(function (lang) {
    var once = P.formatDate(x, lang);
    check('idempotent formatDate(' + show(once) + ', ' + lang + ')', P.formatDate(once, lang), once);
  });
});

table('formatRange', [
  ['Mart 2019', 'Devam ediyor', 'Mart 2019 – Günümüz'],
  ['Mart 2019', 'Devam ediyor', 'tr', 'Mart 2019 – Günümüz'],
  ['Mart 2019', 'Devam ediyor', 'en', 'Mar 2019 – Present'],
  ['Eylül 2018', 'Haziran 2020', 'en', 'Sep 2018 – Jun 2020'],
  ['2015', '2019', '2015 – 2019'],
  ['2015', '', '2015'],
  ['', '2019', '2019'],
  ['', '', ''],
  [' ', null, ''],
  [undefined, undefined, '']
]);

// ---------------------------------------------------------------------------------------------
// Speech segments
// ---------------------------------------------------------------------------------------------
normTable('applySpokenPunctuation', [
  ['merhaba virgül nasılsın soru işareti', 'merhaba, nasılsın?'],
  ['merhaba virgül nasılsın soru işareti iyiyim nokta', 'merhaba, nasılsın? iyiyim.'],
  ['harika ünlem', 'harika!'],
  ['dikkat ünlem işareti', 'dikkat!'],
  ['şunlar iki nokta excel virgül word', 'şunlar: excel, word'],
  ['a noktalı virgül b', 'a; b'],
  ['web sitesi nokta com', 'web sitesi nokta com'],   // "nokta" only as the last word
  ['bitti nokta', 'bitti.'],
  ['birinci madde yeni satır ikinci madde', 'birinci madde\nikinci madde'],
  ['bir alt satır iki', 'bir\niki'],
  ['birinci madde nokta yeni satır ikinci', 'birinci madde.\nikinci'],
  ['ankara Virgül istanbul', 'ankara, istanbul'],
  ['virgüller ve noktalar', 'virgüller ve noktalar'],
  ['merhaba , dünya', 'merhaba, dünya'],
  ['merhaba,dünya', 'merhaba, dünya'],
  ['neden?çünkü', 'neden? çünkü'],
  ['3,5 yıl, saat 10:30', '3,5 yıl, saat 10:30'],
  ['evet virgül hayır virgül belki', 'evet, hayır, belki'],
  ['a yeni satır yeni satır b', 'a\n\nb'],
  ['üç nokta', '...'],
  ['Ayşe, merhaba.', 'Ayşe, merhaba.'],
  ['gmail.com adresim', 'gmail.com adresim'],
  ['nokta', '.'],
  ['', '']
]);

// normalizeSegment rows: [type, seg, expected]; also normalizeSegment(type, expected) === expected
var segRows = [
  ['name', 'ayşe yılmaz', 'Ayşe Yılmaz'],
  ['title', 'kıdemli muhasebe uzmanı', 'Kıdemli Muhasebe Uzmanı'],
  ['city', 'izmir', 'İzmir'],
  ['email', 'ayse et gmail nokta com', 'ayse@gmail.com'],
  ['email', 'ayse.yilmaz@gmail.com', 'ayse.yilmaz@gmail.com'],
  ['url', 'linkedin nokta com slash in slash ayşe', 'linkedin.com/in/ayse'],
  ['phone', 'sıfır beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', '0532 123 45 67'],
  ['phone', '+49 151 2345 6789', '+49 151 2345 6789'],
  ['date', 'mart 2019', 'Mart 2019'],
  ['date', '03/2019', 'Mart 2019'],
  ['sentences', 'beş yıldır muhasebe alanında çalışıyorum', 'Beş yıldır muhasebe alanında çalışıyorum.'],
  ['sentences', 'neden soru işareti', 'Neden?'],
  ['sentences', 'harika ünlem', 'Harika!'],
  ['sentences', 'ikinci cümle nokta', 'İkinci cümle.'],
  ['sentences', 'iyi bir ekip oyuncusuyum virgül', 'İyi bir ekip oyuncusuyum.'],
  ['sentences', 'Merhaba.', 'Merhaba.'],
  ['sentences', '', ''],
  ['sentences', '   ', ''],
  ['lines', '- faturaları takip ettim', 'Faturaları takip ettim'],
  ['lines', '• raporlama', 'Raporlama'],
  ['lines', '1. bütçe hazırladım', 'Bütçe hazırladım'],
  ['lines', '2) ekip yönettim', 'Ekip yönettim'],
  ['lines', '— ihracat', 'İhracat'],
  ['lines', '* sap kullanımı', 'Sap kullanımı'],
  ['lines', '3.5 yıl deneyim', '3.5 yıl deneyim'],
  ['lines', 'fatura kontrolü yeni satır raporlama', 'Fatura kontrolü\nRaporlama'],
  ['list', 'excel ve word virgül sap', 'Excel, Word, Sap'],
  ['list', 'iPhone ve android', 'iPhone, Android'],
  ['list', 'takım çalışması noktalı virgül liderlik', 'Takım çalışması, Liderlik'],
  ['list', 'İngilizce ileri ve almanca başlangıç', 'İngilizce ileri, Almanca başlangıç'],
  ['list', 'veri analizi ve raporlama', 'Veri analizi, Raporlama'],
  ['list', 'birlikte çalışma', 'Birlikte çalışma'],
  ['list', 've excel', 'Excel'],
  ['list', 'Excel, SAP, Takım çalışması', 'Excel, SAP, Takım çalışması'],
  ['list', 'excel virgül word nokta', 'Excel, Word'],
  ['list', 'Excel, Word.', 'Excel, Word'],
  ['list', 've ,', ''],
  ['list', 'iPhone ünlem nokta nokta', 'iPhone!'],
  ['lines', ';nokta', ';.'],
  ['text', '  bir   şey  ', 'Bir şey'],
  ['text', '', ''],
  ['bilinmeyen', 'x', 'X']
];
segRows.forEach(function (r) {
  check(label('normalizeSegment', [r[0], r[1]]), call('normalizeSegment', [r[0], r[1]]), r[2]);
  check('idempotent ' + label('normalizeSegment', [r[0], r[2]]), call('normalizeSegment', [r[0], r[2]]), r[2]);
});

table('mergeSegment', [
  // single-value types: append within the same listening session
  ['email', 'ayse', 'et gmail nokta com', { append: true }, 'ayse@gmail.com'],
  ['email', 'aysekaya', '4 et gmail nokta com', { append: true }, 'aysekaya4@gmail.com'],
  ['email', 'ayse', 'et gmail nokta com', { append: false }, '@gmail.com'],
  ['date', 'Mart', '2019', { append: true }, 'Mart 2019'],
  ['date', 'Mart 2019', 'nisan 2020', { append: false }, 'Nisan 2020'],
  ['phone', '0532', '123 45 67', { append: true }, '0532 123 45 67'],
  ['phone', '', 'sıfır beş yüz otuz iki', { append: true }, '0 532'],
  ['phone', '0 532', 'yüz yirmi üç kırk beş altmış yedi', { append: true }, '0532 123 45 67'],
  ['phone', '', 'artı doksan', { append: false }, '+90'],
  ['phone', '+90', 'beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', { append: true }, '+90 532 123 45 67'],
  ['name', 'Ayşe', 'yılmaz', { append: true }, 'Ayşe Yılmaz'],
  ['name', 'Ayşe Yılmaz', 'mehmet öz', { append: false }, 'Mehmet Öz'],
  ['name', 'Ayşe', 'yılmaz', undefined, 'Yılmaz'],
  ['city', 'Kadıköy', 'istanbul', { append: true }, 'Kadıköy İstanbul'],
  ['url', 'linkedin.com', 'slash in slash ayşe', { append: true }, 'linkedin.com/in/ayse'],
  ['text', 'Bir', 'şey', { append: true }, 'Bir şey'],
  // multi-value types always append
  ['sentences', 'İlk cümle.', 'ikinci cümle', { append: false }, 'İlk cümle. İkinci cümle.'],
  ['sentences', '', 'ilk cümle', {}, 'İlk cümle.'],
  ['sentences', 'Cümle.', 'nokta', {}, 'Cümle.'],
  ['lines', 'Birinci', 'ikinci', { append: false }, 'Birinci\nİkinci'],
  ['lines', '', '- birinci', {}, 'Birinci'],
  ['list', 'Excel, Word', 'sap ve jira', {}, 'Excel, Word, Sap, Jira'],
  ['list', '', 'excel', {}, 'Excel'],
  ['list', 'Excel, ', 'word', {}, 'Excel, Word'],
  // empty segment → current unchanged
  ['name', 'Ayşe Yılmaz', '   ', { append: true }, 'Ayşe Yılmaz'],
  ['sentences', 'Cümle.', '', {}, 'Cümle.'],
  ['list', 'Excel', null, {}, 'Excel']
]);

var commandRows = [
  ['tamam', 'next'], ['Tamam.', 'next'], ['TAMAM', 'next'], ['devam', 'next'], ['Devam et!', 'next'],
  ['sonraki', 'next'], ['sonraki soru', 'next'], ['İleri', 'next'], ['geçelim', 'next'],
  ['bitti', 'next'], ['bu kadar', 'next'], ['tamamdır', 'next'], ['devam lütfen', 'next'],
  ['atla', 'skip'], ['geç', 'skip'], ['gec', 'skip'], ['boş bırak', 'skip'], ['pas', 'skip'], ['pas geç', 'skip'],
  ['geri', 'back'], ['GERİ', 'back'], ['geri dön', 'back'], ['önceki', 'back'], ['önceki soru', 'back'],
  ['sil', 'clear'], ['temizle', 'clear'], ['hepsini sil', 'clear'],
  ['geri al', 'undo'], ['son kısmı sil', 'undo'], ['sonuncuyu sil', 'undo'],
  ['dur', 'stop'], ['durdur', 'stop'], ['mikrofonu kapat', 'stop'], ['dinlemeyi durdur', 'stop'],
  ['evet', 'yes'], ['olur', 'yes'], ['ekle', 'yes'], ['evet ekle', 'yes'], ['var', 'yes'],
  ['tabii', 'yes'], ['tabi', 'yes'], ['isterim', 'yes'], ['evet var', 'yes'],
  ['hayır', 'no'], ['hayir', 'no'], ['yok', 'no'], ['istemiyorum', 'no'], ['gerek yok', 'no'],
  ['hayır teşekkürler', 'no'], ['yok teşekkürler', 'no'],
  ['tekrar oku', 'repeat'], ['soruyu tekrarla', 'repeat'], ['tekrar et', 'repeat'],
  ['anlamadım', 'repeat'], ['tekrar', 'repeat'], ['tekrar lütfen', 'repeat'], ['lütfen tekrar et', 'repeat'],
  // not commands: only an exact whole-segment match counts
  ['tamam ama', null], ['devam ediyorum', null], ['ayşe yılmaz', null], ['geri dönüş', null],
  ['evet hayır', null], ['lütfen', null], ['', null], [null, null]
];
table('detectCommand', commandRows);

// ---------------------------------------------------------------------------------------------
// Lists for the PDF
// ---------------------------------------------------------------------------------------------
table('splitList', [
  ['Excel, SAP, Takım çalışması', ['Excel', 'SAP', 'Takım çalışması']],
  ['excel; word\npowerpoint • sap · jira | trello', ['excel', 'word', 'powerpoint', 'sap', 'jira', 'trello']],
  ['Excel ve Word ve SAP', ['Excel', 'Word', 'SAP']],
  ['Excel, excel, EXCEL', ['Excel']],
  ['İngilizce, ingilizce', ['İngilizce']],
  ['Işık, ışık, IŞIK', ['Işık']],
  ['veri analizi, raporlama', ['veri analizi', 'raporlama']],
  ['Birlikte çalışma, Onur', ['Birlikte çalışma', 'Onur']],
  ['Takım çalışması.', ['Takım çalışması']],
  ['Muhasebe, vb.', ['Muhasebe', 'vb.']],
  ['- Excel\n- Word', ['Excel', 'Word']],
  ['C++, C#, .NET', ['C++', 'C#', '.NET']],
  ['Excel, SAP; Takım çalışması | İletişim • Liderlik · Ar-Ge',
    ['Excel', 'SAP', 'Takım çalışması', 'İletişim', 'Liderlik', 'Ar-Ge']],
  ['A.Ş., Ltd. Şti.', ['A.Ş.', 'Ltd. Şti.']],
  ['Excel..., Word.', ['Excel', 'Word']],
  [' , ,, ', []],
  ['', []],
  [null, []]
]);

table('splitLines', [
  ['- birinci\n• ikinci\n\n3. üçüncü\n4) dördüncü', ['birinci', 'ikinci', 'üçüncü', 'dördüncü']],
  ['  satır  bir  \r\nsatır iki', ['satır bir', 'satır iki']],
  ['1- madde', ['madde']],
  ['— madde\n* yıldız\n· nokta', ['madde', 'yıldız', 'nokta']],
  ['3.5 yıl deneyim', ['3.5 yıl deneyim']],
  ['2019-2021 arası', ['2019-2021 arası']],
  ['\n\n', []],
  ['', []]
]);

function lang(name, level, raw) { return { name: name, level: level, raw: raw }; }
table('parseLanguages', [
  ['İngilizce (C1)', [lang('İngilizce', 4, 'İngilizce (C1)')]],
  ['Türkçe ana dil', [lang('Türkçe', 5, 'Türkçe ana dil')]],
  ['ingilizce', [lang('İngilizce', 0, 'ingilizce')]],
  ['İngilizce ileri, Almanca başlangıç',
    [lang('İngilizce', 4, 'İngilizce ileri'), lang('Almanca', 1, 'Almanca başlangıç')]],
  ['İngilizce ileri ve almanca başlangıç',
    [lang('İngilizce', 4, 'İngilizce ileri'), lang('Almanca', 1, 'almanca başlangıç')]],
  ['Almanca orta seviye', [lang('Almanca', 2, 'Almanca orta seviye')]],
  ['Fransızca orta üstü', [lang('Fransızca', 3, 'Fransızca orta üstü')]],
  ['İspanyolca orta-ileri', [lang('İspanyolca', 3, 'İspanyolca orta-ileri')]],
  ['Japonca upper-intermediate', [lang('Japonca', 3, 'Japonca upper-intermediate')]],
  ['Rusça upper intermediate', [lang('Rusça', 3, 'Rusça upper intermediate')]],
  ['Arapça intermediate', [lang('Arapça', 2, 'Arapça intermediate')]],
  ['İtalyanca çok iyi', [lang('İtalyanca', 4, 'İtalyanca çok iyi')]],
  ['İngilizce iyi derecede', [lang('İngilizce', 3, 'İngilizce iyi derecede')]],
  ['Almanca B2 seviyesinde', [lang('Almanca', 3, 'Almanca B2 seviyesinde')]],
  ['Azerice temel', [lang('Azerice', 1, 'Azerice temel')]],
  ['Azerice', [lang('Azerice', 0, 'Azerice')]],
  ['Korece biraz', [lang('Korece', 1, 'Korece biraz')]],
  ['Çince az', [lang('Çince', 1, 'Çince az')]],
  ['Türkçe anadilim', [lang('Türkçe', 5, 'Türkçe anadilim')]],
  ['Türkçe (ana dili)', [lang('Türkçe', 5, 'Türkçe (ana dili)')]],
  ['English fluent', [lang('English', 4, 'English fluent')]],
  ['German native', [lang('German', 5, 'German native')]],
  ['Spanish - beginner', [lang('Spanish', 1, 'Spanish - beginner')]],
  ['İngilizce: akıcı', [lang('İngilizce', 4, 'İngilizce: akıcı')]],
  ['İngilizce ileri düzeyde', [lang('İngilizce', 4, 'İngilizce ileri düzeyde')]],
  ['İngilizce ileri düzey', [lang('İngilizce', 4, 'İngilizce ileri düzey')]],
  ['ingilizce profesyonel olarak', [lang('İngilizce', 4, 'ingilizce profesyonel olarak')]],
  ['Fransızca A2', [lang('Fransızca', 1, 'Fransızca A2')]],
  ['Felemenkçe B1', [lang('Felemenkçe', 2, 'Felemenkçe B1')]],
  ['İNGİLİZCE İLERİ', [lang('İngilizce', 4, 'İNGİLİZCE İLERİ')]],
  ['işaret dili', [lang('İşaret Dili', 0, 'işaret dili')]],
  ['İngilizce (C1), Almanca (A2)',
    [lang('İngilizce', 4, 'İngilizce (C1)'), lang('Almanca', 1, 'Almanca (A2)')]],
  ['İngilizce, ileri', [lang('İngilizce', 4, 'İngilizce, ileri')]],
  ['İngilizce - İleri; Almanca - Orta',
    [lang('İngilizce', 4, 'İngilizce - İleri'), lang('Almanca', 2, 'Almanca - Orta')]],
  ['Türkçe (Anadil), İngilizce (B2), Almanca (A1)',
    [lang('Türkçe', 5, 'Türkçe (Anadil)'), lang('İngilizce', 3, 'İngilizce (B2)'), lang('Almanca', 1, 'Almanca (A1)')]],
  ['Almanca level B1', [lang('Almanca', 2, 'Almanca level B1')]],
  ['', []]
]);

table('levelLabel', [
  [5, 'Ana dil'], [4, 'İleri'], [3, 'İyi'], [2, 'Orta'], [1, 'Başlangıç'], [0, ''],
  [5, 'tr', 'Ana dil'],
  [5, 'en', 'Native'], [4, 'en', 'Advanced'], [3, 'en', 'Upper-intermediate'],
  [2, 'en', 'Intermediate'], [1, 'en', 'Beginner'], [0, 'en', ''],
  ['4', 'en', 'Advanced'], [7, 'tr', ''], [-1, 'tr', ''], [null, 'tr', ''], [undefined, 'en', '']
]);

// Every pair from the spec, both directions.
[
  ['İngilizce', 'English'], ['Almanca', 'German'], ['Fransızca', 'French'], ['İspanyolca', 'Spanish'],
  ['İtalyanca', 'Italian'], ['Rusça', 'Russian'], ['Arapça', 'Arabic'], ['Türkçe', 'Turkish'],
  ['Kürtçe', 'Kurdish'], ['Farsça', 'Persian'], ['Azerice', 'Azerbaijani'], ['Çince', 'Chinese'],
  ['Japonca', 'Japanese'], ['Korece', 'Korean'], ['Portekizce', 'Portuguese'], ['Felemenkçe', 'Dutch'],
  ['Yunanca', 'Greek'], ['Lehçe', 'Polish'], ['Ukraynaca', 'Ukrainian'], ['Bulgarca', 'Bulgarian'],
  ['Gürcüce', 'Georgian'], ['Ermenice', 'Armenian'], ['Boşnakça', 'Bosnian'], ['Arnavutça', 'Albanian'],
  ['İşaret Dili', 'Sign Language']
].forEach(function (p) {
  check(label('languageName', [p[0], 'en']), P.languageName(p[0], 'en'), p[1]);
  check(label('languageName', [p[1], 'tr']), P.languageName(p[1], 'tr'), p[0]);
});
table('languageName', [
  ['Hollandaca', 'en', 'Dutch'],
  ['ingilizce', 'en', 'English'],
  ['INGILIZCE', 'en', 'English'],
  ['sign language', 'tr', 'İşaret Dili'],
  ['İngilizce', 'tr', 'İngilizce'],
  ['English', 'en', 'English'],
  ['Klingonca', 'en', 'Klingonca'],
  ['Esperanto', 'tr', 'Esperanto'],
  ['', 'en', '']
]);

// ---------------------------------------------------------------------------------------------
// Seeded idempotence sweep: random phrases built from tricky tokens; every normalizer (and every
// normalizeSegment type, and formatDate) must return its own output unchanged. One assertion per
// function; the first few counter-examples are printed.
// ---------------------------------------------------------------------------------------------
(function () {
  var vocab = ['ayşe', 'yılmaz', 'İSTANBUL', 've', 'de', 'iki', 'bin', 'on', 'dokuz', 'yüz', 'sıfır',
    'nokta', 'et', 'at', 'slash', 'virgül', 'soru', 'işareti', 'yeni', 'satır', 'mart', '2019',
    '03/2019', "2019'da", 'devam', '-', '•', '1.', 'LinkedIn', 'ODTÜ', 'iPhone', '@', 'gmail', 'com',
    '+90', '532', 'ahmet', 'onur', 'bina', 'birlikte', 'ileri', 'C1', '(', ')', ',', ';', '.', 'ünlem',
    'alt', 'çizgi', 'Işık', 'ı', 'i', 'I', 'İ', '  ', '\n', 'A.Ş.', 'vb.', 'may', '2020'];
  var seed = 20261021;
  function rnd(n) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }
  var one = ['normalizeName', 'normalizeTitle', 'normalizeCity', 'normalizeEmail', 'normalizeUrl',
    'normalizePhone', 'normalizeDate', 'wordsToNumbers', 'titleCase', 'capFirst', 'cleanSpaces',
    'foldAscii', 'applySpokenPunctuation'];
  var types = ['sentences', 'lines', 'list', 'text'];
  var bad = {}, shown = 0;
  function note(key, x, a, b) {
    bad[key] = (bad[key] || 0) + 1;
    if (shown++ < 5) print('  sweep ' + key + '(' + show(x) + ') → ' + show(a) + ' → ' + show(b));
  }
  for (var it = 0; it < 1500; it++) {
    var n = 1 + rnd(7), words = [];
    for (var k = 0; k < n; k++) words.push(vocab[rnd(vocab.length)]);
    var x = words.join(rnd(3) ? ' ' : '');
    one.forEach(function (f) { var a = P[f](x), b = P[f](a); if (a !== b) note(f, x, a, b); });
    types.forEach(function (t) {
      var a = P.normalizeSegment(t, x), b = P.normalizeSegment(t, a);
      if (a !== b) note('normalizeSegment:' + t, x, a, b);
    });
    ['tr', 'en'].forEach(function (l) {
      var a = P.formatDate(x, l), b = P.formatDate(a, l);
      if (a !== b) note('formatDate:' + l, x, a, b);
    });
  }
  one.concat(types.map(function (t) { return 'normalizeSegment:' + t; }), ['formatDate:tr', 'formatDate:en'])
    .forEach(function (key) { check('idempotence sweep ' + key, bad[key] || 0, 0); });
})();

// ---------------------------------------------------------------------------------------------
print('parse: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) throw new Error(failed + ' parse test(s) failed'); // jsc exits non-zero on throw
