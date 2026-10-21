/*
 * tests/parse.adversarial.test.js — adversarial tests for parse.js (CVParse).
 *
 * Written against the spec, not against the implementation: the inputs imitate what Chrome's
 * tr-TR recognizer actually hands the app — lowercase text, digits mixed with number words, no
 * punctuation, the odd capitalised proper noun or English loanword (Excel, SQL, Python, LinkedIn),
 * and answers split over two pause-delimited segments that the app joins with
 * mergeSegment(..., {append: true}).
 *
 * Run from the project folder:  tests/run-parse.sh  (runs parse.test.js and this file)
 */
/* global load, print */
globalThis.console = { log: print, error: print };
load('parse.js');

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
// one-argument normalizers: f(input) === expected, and f(expected) === expected (fixed point)
function normTable(name, rows) {
  rows.forEach(function (r) {
    check(label(name, [r[0]]), call(name, [r[0]]), r[1]);
    check('idempotent ' + label(name, [r[1]]), call(name, [r[1]]), r[1]);
  });
}
// Simulates one listening session on a single-value field: the first final segment replaces the
// field, every later one is appended (opts.append === true), exactly as the app calls it.
function dictate(type, segments, start) {
  var cur = start == null ? '' : start;
  segments.forEach(function (seg, i) {
    cur = P.mergeSegment(type, cur, seg, { append: i > 0 });
  });
  return cur;
}
function dictateTable(rows) {
  rows.forEach(function (r) {
    var got;
    try { got = dictate(r[0], r[1]); } catch (e) { got = 'THREW ' + e; }
    check('dictate(' + show(r[0]) + ', ' + show(r[1]) + ')', got, r[2]);
  });
}

// ---------------------------------------------------------------------------------------------
// Dates as dictated
// ---------------------------------------------------------------------------------------------
normTable('normalizeDate', [
  ['2018 eylül', 'Eylül 2018'],
  ["eylül 2018'de", 'Eylül 2018'],
  ['18 eylül 2018', 'Eylül 2018'],                   // a day is dropped: CVs show month + year
  ['1 mart 2019', 'Mart 2019'],
  ['on sekiz eylül iki bin on sekiz', 'Eylül 2018'],
  ['18/09/2018', 'Eylül 2018'],
  ['iki bin yirmi', '2020'],
  ['İki bin yirmi', '2020'],                         // Chrome capitalises the segment start
  ['şu anda devam ediyor', 'Devam ediyor'],
  ['hala devam ediyor', 'Devam ediyor'],
  ['Halen çalışıyorum', 'Devam ediyor'],
  ['günümüze kadar', 'Devam ediyor'],
  ['2018 yılı eylül ayında', 'Eylül 2018'],
  ["2018'in eylül ayında", 'Eylül 2018'],
  ['2020 haziranından beri', 'Haziran 2020'],
  ['ekimde başladım iki bin yirmi bir', 'Ekim 2021'],
  ['AĞUSTOS 2021', 'Ağustos 2021'],
  ['september 2018', 'Eylül 2018'],
  ['Sept 2018', 'Eylül 2018'],
  ['marketing 2019', '2019'],                        // "marketing" is not "mart"/"mar"
  ['ekonomi', 'Ekonomi'],                            // nor is "ekonomi" "ekim"
  // a spoken year whose last number word carries the case suffix ("…dokuzda", "…yirmide"):
  // wordsToNumbers stops at the suffixed word, so these used to come out as 2010 / 2000 / 1990
  ['iki bin on dokuzda', '2019'],
  ['iki bin yirmide', '2020'],
  ['iki bin onda', '2010'],
  ['bin dokuz yüz doksan sekizde', '1998'],
  ['haziran iki bin yirmi birde', 'Haziran 2021'],
  ['iki bin on sekizin eylül ayında', 'Eylül 2018'],
  ['iki bin on sekizden beri', '2018'],
  ['iki bin on dörtte başladım', '2014'],
  // a year completed by the next segment after the first part was already stored as digits
  ['2000 18', '2018'],
  ['2010 8', '2018'],
  ['1900 98', '1998'],
  ['Mart 2000 19', 'Mart 2019'],
  ['2010 12', '2010'],                               // tens slot already used: no merge
  ['2019 12', '2019'],
  ['onuncu yıl', 'Onuncu yıl']                       // ordinals are not number words
]);

table('mergeSegment', [
  ['date', 'Eylül', '2018', { append: true }, 'Eylül 2018'],
  ['date', '2018', 'eylül', { append: true }, 'Eylül 2018'],
  ['date', 'eylül', "2018'de", { append: true }, 'Eylül 2018'],
  ['date', '18', 'eylül 2018', { append: true }, 'Eylül 2018'],
  ['date', 'Şu', 'anda devam ediyor', { append: true }, 'Devam ediyor'],
  ['date', '', 'şu anda', { append: true }, 'Devam ediyor'],
  ['date', '2000', 'on sekiz', { append: true }, '2018'],
  ['date', '2010', 'sekiz', { append: true }, '2018'],
  ['date', 'Eylül 2000', 'yirmi', { append: true }, 'Eylül 2020'],
  ['date', 'Mart 2019', 'nisan 2020', { append: false }, 'Nisan 2020']
]);

dictateTable([
  ['date', ['iki bin', 'on sekiz'], '2018'],
  ['date', ['eylül', 'iki bin on sekiz'], 'Eylül 2018'],
  ['date', ['eylül', 'iki bin', 'on sekiz'], 'Eylül 2018'],
  ['date', ['bin dokuz yüz', 'doksan sekiz'], '1998'],
  ['date', ['şu anda', 'devam ediyor'], 'Devam ediyor']
]);

table('formatRange', [
  [P.normalizeDate('2018 eylül'), P.normalizeDate('şu anda devam ediyor'), 'tr', 'Eylül 2018 – Günümüz'],
  [P.normalizeDate('2018 eylül'), P.normalizeDate('şu anda devam ediyor'), 'en', 'Sep 2018 – Present'],
  [P.normalizeDate('iki bin on dörtte'), P.normalizeDate('iki bin on sekizde'), 'tr', '2014 – 2018']
]);
table('formatDate', [
  ['18 Eylül 2018', 'tr', '18 Eylül 2018'],          // typed with a day: printed as typed
  ['Eylül 2018', 'en-US', 'Sep 2018'],
  ['Hâlâ', 'en', 'Present']
]);

// ---------------------------------------------------------------------------------------------
// Phones as dictated
// ---------------------------------------------------------------------------------------------
normTable('normalizePhone', [
  ['0 532 123 45 67', '0532 123 45 67'],
  ['beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', '0532 123 45 67'],
  ['+90 532 123 45 67', '+90 532 123 45 67'],
  ['+90532 1234567', '+90 532 123 45 67'],
  ['+ 90 532 123 45 67', '+90 532 123 45 67'],
  ['90 532 123 45 67', '+90 532 123 45 67'],
  // "+90" in words: the slot rules alone read "doksan beş | yüz otuz iki" as 95 132
  ['artı doksan beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', '+90 532 123 45 67'],
  ['doksan beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', '+90 532 123 45 67'],
  ['telefonum artı doksan beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', '+90 532 123 45 67'],
  ['Artı Doksan Beş Yüz Otuz İki Yüz Yirmi Üç Kırk Beş Altmış Yedi', '+90 532 123 45 67'],
  ['sıfır beş yüz elli beş beş yüz elli beş elli beş elli beş', '0555 555 55 55'],
  ['sıfır beş yüz otuz iki yüz yirmi üç kırk beş sıfır yedi', '0532 123 45 07'],
  ['sıfır iki yüz on iki üç yüz kırk beş altmış yedi seksen dokuz', '0212 345 67 89'],
  ['0 850 123 45 67', '0850 123 45 67'],
  ['0532.123.45.67', '0532 123 45 67'],
  ['beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi nokta', '0532 123 45 67'],
  ['Sıfır Beş Yüz Otuz İki', '0 532'],              // incomplete: digits, not reformatted
  // foreign numbers are left alone, also when "doksan" is a real country code prefix
  ['+1 415 555 0100', '+1 415 555 0100'],
  ['artı doksan sekiz', '+98'],
  ['artı doksan bir dokuz sekiz yedi', '+91 9 8 7'],
  ['444 1 234', '444 1 234']
]);

dictateTable([
  ['phone', ['sıfır beş yüz otuz iki', 'yüz yirmi üç', 'kırk beş altmış yedi'], '0532 123 45 67'],
  ['phone', ['0 532', '123 45 67'], '0532 123 45 67'],
  ['phone', ['artı doksan', 'beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi'], '+90 532 123 45 67'],
  ['phone', ['artı doksan beş yüz otuz iki', 'yüz yirmi üç kırk beş altmış yedi'], '+90 532 123 45 67'],
  ['phone', ['+90 532', '123 45 67'], '+90 532 123 45 67'],
  ['phone', ['0532 123', 'kırk beş altmış yedi'], '0532 123 45 67']
]);

// ---------------------------------------------------------------------------------------------
// E-mail and web addresses spoken in fragments
// ---------------------------------------------------------------------------------------------
normTable('normalizeEmail', [
  ['Ahmet et Gmail nokta com', 'ahmet@gmail.com'],
  ['mehmet ahmet et gmail nokta com', 'mehmetahmet@gmail.com'],   // "et" inside names survives
  ['mehmet at hotmail nokta com', 'mehmet@hotmail.com'],
  ['mehmet et outlook nokta com nokta tr', 'mehmet@outlook.com.tr'],
  ['ayşe alt çizgi yılmaz et gmail nokta com', 'ayse_yilmaz@gmail.com'],
  ['ece eksi kaya at yahoo dot com', 'ece-kaya@yahoo.com'],
  ['ayşe et işareti gmail nokta com', 'ayse@gmail.com'],
  ['Ayşe Kaya 4 @ gmail.com', 'aysekaya4@gmail.com'],
  ['ahmet.at@gmail.com', 'ahmet.at@gmail.com'],
  ['İsmail et gmail nokta com', 'ismail@gmail.com'],
  ['ISMAIL@GMAIL.COM', 'ismail@gmail.com'],
  ['IŞIL@GMAIL.COM', 'isil@gmail.com'],
  ['ayşe et gmail nokta com nokta', 'ayse@gmail.com'],
  ['ayşe et g mail nokta com', 'ayse@gmail.com']
]);

// The pause falls right after "nokta": the field holds the normalised "ayse." / "…@gmail." until
// the next segment arrives, so that dot must survive (it used to be stripped as a sentence dot,
// giving "ayseyilmaz@…" and "…@gmailcom"). A complete address still loses its trailing dot.
normTable('normalizeEmail', [
  ['ayşe nokta', 'ayse.'],
  ['aysekaya4 et gmail nokta', 'aysekaya4@gmail.'],
  ['ayse@gmail.com.', 'ayse@gmail.com']
]);
normTable('normalizeUrl', [
  ['linkedin nokta', 'linkedin.'],
  ['linkedin.com/in/ayse.', 'linkedin.com/in/ayse']
]);
dictateTable([
  ['email', ['aysekaya4 et gmail nokta', 'com'], 'aysekaya4@gmail.com'],
  ['url', ['linkedin nokta', 'com slash in slash ayşe'], 'linkedin.com/in/ayse'],
  ['url', ['www nokta', 'ayşe nokta dev'], 'ayse.dev'],
  ['email', ['ayşe kaya 4', 'et gmail nokta com'], 'aysekaya4@gmail.com'],
  ['email', ['aysekaya4 et gmail', 'nokta com'], 'aysekaya4@gmail.com'],
  ['email', ['ahmet', 'et gmail nokta com'], 'ahmet@gmail.com'],
  ['email', ['Ahmet Yılmaz', 'et Gmail nokta com'], 'ahmetyilmaz@gmail.com'],
  ['email', ['ayşe nokta', 'yılmaz et şirket nokta com nokta tr'], 'ayse.yilmaz@sirket.com.tr'],
  ['email', ['ayşe', 'Nokta kaya et Gmail nokta com'], 'ayse.kaya@gmail.com'],
  ['email', ['ahmet et gmail nokta com', 'nokta tr'], 'ahmet@gmail.com.tr']
]);
table('mergeSegment', [
  ['email', 'aysekaya4@gmail.', 'com', { append: true }, 'aysekaya4@gmail.com'],
  ['email', 'eski@mail.com', 'yeni et gmail nokta com', { append: false }, 'yeni@gmail.com']
]);

normTable('normalizeUrl', [
  ['LinkedIn nokta com slash in slash Ayşe Yılmaz', 'linkedin.com/in/ayseyilmaz'],
  ['HTTPS://WWW.LinkedIn.com/in/Ayse', 'linkedin.com/in/ayse'],
  ['github nokta com eğik çizgi ayşe', 'github.com/ayse'],
  ['https iki nokta slash slash linkedin nokta com', 'linkedin.com'],
  ['www nokta ayşe nokta com nokta tr', 'ayse.com.tr'],
  ['python nokta org', 'python.org']
]);
dictateTable([
  ['url', ['linkedin nokta com', 'slash in slash ayşe yılmaz'], 'linkedin.com/in/ayseyilmaz'],
  ['url', ['linkedin nokta com slash in slash', 'ayşe yılmaz'], 'linkedin.com/in/ayseyilmaz'],
  ['url', ['www', 'nokta github nokta com'], 'github.com'],
  ['url', ['github nokta com slash ayşe', 'tire yılmaz'], 'github.com/ayse-yilmaz']
]);

// ---------------------------------------------------------------------------------------------
// Names, titles, cities: Turkish casing and loanwords
// ---------------------------------------------------------------------------------------------
normTable('normalizeName', [
  ['ayşe kaya', 'Ayşe Kaya'],
  ['AYŞE KAYA', 'Ayşe Kaya'],
  ['İsmail ışık', 'İsmail Işık'],
  ['ayşe nur yılmaz.', 'Ayşe Nur Yılmaz']
]);
dictateTable([
  ['name', ['ayşe', 'kaya'], 'Ayşe Kaya']
]);
normTable('normalizeTitle', [
  ['kıdemli Python geliştirici', 'Kıdemli Python Geliştirici'],
  ['SQL ve Excel uzmanı', 'SQL ve Excel Uzmanı'],
  ['LinkedIn içerik yöneticisi', 'LinkedIn İçerik Yöneticisi'],
  ['iOS geliştirici', 'iOS Geliştirici'],
  ['IT müdürü', 'IT Müdürü'],
  ['UX/UI tasarımcı', 'UX/UI Tasarımcı'],
  // slash-joined words are capitalised like hyphen parts ("Ar-Ge"); typed lowercase used to
  // give "Satış/pazarlama Müdürü"
  ['satış/pazarlama müdürü', 'Satış/Pazarlama Müdürü'],
  ['insan kaynakları ve idari işler müdürü', 'İnsan Kaynakları ve İdari İşler Müdürü']
]);
normTable('normalizeCity', [
  ['ığdır', 'Iğdır'],
  ['şanlıurfa', 'Şanlıurfa'],
  ['kadıköy istanbul', 'Kadıköy İstanbul'],
  // "i" + U+0307 (what a non-Turkish toLowerCase makes of "İ"): used to render a doubled dot
  ['i̇stanbul', 'İstanbul']
]);
table('capFirst', [['i̇zmir', 'İzmir']]);
table('titleCase', [['i̇stanbul üni̇versi̇tesi̇', 'İstanbul Üniversitesi']]);

// ---------------------------------------------------------------------------------------------
// Free-text segments
// ---------------------------------------------------------------------------------------------
table('normalizeSegment', [
  ['sentences', 'Excel ve SQL biliyorum', 'Excel ve SQL biliyorum.'],
  ['sentences', 'satış hedeflerini yüzde 20 aştım nokta', 'Satış hedeflerini yüzde 20 aştım.'],
  ['sentences', 'harika ünlem', 'Harika!'],
  ['sentences', 'neden mi soru işareti', 'Neden mi?'],
  ['lines', 'müşteri ilişkilerini yönettim yeni satır raporlama yaptım',
    'Müşteri ilişkilerini yönettim\nRaporlama yaptım'],
  ['lines', '3 kişilik ekibi yönettim', '3 kişilik ekibi yönettim'],
  ['list', 'Excel virgül SQL virgül Python', 'Excel, SQL, Python'],
  ['list', 'takım çalışması ve iletişim', 'Takım çalışması, İletişim'],
  ['list', 'LinkedIn ve iPhone', 'LinkedIn, iPhone'],
  ['list', 'ingilizce ileri seviye almanca başlangıç', 'İngilizce ileri seviye almanca başlangıç']
]);
table('mergeSegment', [
  ['list', 'Excel, SQL', 'Python ve LinkedIn', { append: true }, 'Excel, SQL, Python, LinkedIn'],
  ['sentences', 'Ben Ayşe.', 'beş yıllık deneyimim var', { append: true },
    'Ben Ayşe. Beş yıllık deneyimim var.'],
  ['lines', 'Müşteri ilişkileri', 'raporlama', { append: true }, 'Müşteri ilişkileri\nRaporlama']
]);

// ---------------------------------------------------------------------------------------------
// Voice commands vs. real answers
// ---------------------------------------------------------------------------------------------
table('detectCommand', [
  ['Tamam.', 'next'], ['Devam et lütfen.', 'next'], ['geç lütfen', 'skip'], ['ILERI', 'next'],
  ['hayır, teşekkürler', 'no'], ['evet, ekle', 'yes'], ['Anlamadım?', 'repeat'],
  ['tamamdir', 'next'],
  // answers that merely contain a command word must not be swallowed
  ['devam ediyor', null], ['şu anda devam ediyor', null], ['ileri seviye', null],
  ['ingilizce ileri', null], ['tamam tamam', null], ['var mı', null], ['geri dönüş yaptım', null]
]);

// ---------------------------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------------------------
function lang(name, level, raw) { return { name: name, level: level, raw: raw }; }
table('parseLanguages', [
  // dictated without commas: a known language name starts a new item
  ['ingilizce ileri seviye almanca başlangıç',
    [lang('İngilizce', 4, 'ingilizce ileri seviye'), lang('Almanca', 1, 'almanca başlangıç')]],
  ['türkçe ana dil ingilizce ileri almanca orta',
    [lang('Türkçe', 5, 'türkçe ana dil'), lang('İngilizce', 4, 'ingilizce ileri'), lang('Almanca', 2, 'almanca orta')]],
  ['ingilizce c1 almanca a2', [lang('İngilizce', 4, 'ingilizce c1'), lang('Almanca', 1, 'almanca a2')]],
  ['english fluent german basic', [lang('English', 4, 'english fluent'), lang('German', 1, 'german basic')]],
  ['ingilizce almanca', [lang('İngilizce', 0, 'ingilizce'), lang('Almanca', 0, 'almanca')]],
  ['İngilizce ileri seviyede Almanca başlangıç seviyesinde',
    [lang('İngilizce', 4, 'İngilizce ileri seviyede'), lang('Almanca', 1, 'Almanca başlangıç seviyesinde')]],
  ['işaret dili orta ingilizce ileri',
    [lang('İşaret Dili', 2, 'işaret dili orta'), lang('İngilizce', 4, 'ingilizce ileri')]],
  ['İngilizce (ileri) Almanca (başlangıç)',
    [lang('İngilizce', 4, 'İngilizce (ileri)'), lang('Almanca', 1, 'Almanca (başlangıç)')]],
  ['arapça orta seviye farsça başlangıç kürtçe anadil',
    [lang('Arapça', 2, 'arapça orta seviye'), lang('Farsça', 1, 'farsça başlangıç'), lang('Kürtçe', 5, 'kürtçe anadil')]],
  ['Türkçe anadil İngilizce B2', [lang('Türkçe', 5, 'Türkçe anadil'), lang('İngilizce', 3, 'İngilizce B2')]],
  // level said before the name ("ileri seviye İngilizce"): each level goes with the name after it
  ['ileri seviye ingilizce başlangıç seviyesinde almanca',
    [lang('İngilizce', 4, 'ileri seviye ingilizce'), lang('Almanca', 1, 'başlangıç seviyesinde almanca')]],
  ['ingilizce ileri ingilizce ileri', [lang('İngilizce', 4, 'ingilizce ileri')]],
  // a language named twice is listed once
  ['İngilizce ileri, ingilizce', [lang('İngilizce', 4, 'İngilizce ileri')]],
  ['ingilizce, İngilizce B2', [lang('İngilizce', 3, 'ingilizce, İngilizce B2')]],
  // an unknown language with a level in front of a known one is still cut off
  ['klingonca ileri almanca orta', [lang('Klingonca', 4, 'klingonca ileri'), lang('Almanca', 2, 'almanca orta')]],
  ['kazakça ana dil rusça ileri', [lang('Kazakça', 5, 'kazakça ana dil'), lang('Rusça', 4, 'rusça ileri')]],
  // separators at a cut belong to neither piece
  ['English (C1) - German (A2)', [lang('English', 4, 'English (C1)'), lang('German', 1, 'German (A2)')]],
  // the usual typed forms keep working
  ['İngilizce B2, Almanca A1', [lang('İngilizce', 3, 'İngilizce B2'), lang('Almanca', 1, 'Almanca A1')]],
  ['Türkçe anadil', [lang('Türkçe', 5, 'Türkçe anadil')]],
  ['İngilizce: C1, Almanca: A2', [lang('İngilizce', 4, 'İngilizce: C1'), lang('Almanca', 1, 'Almanca: A2')]],
  ['ingilizce ileri, almanca', [lang('İngilizce', 4, 'ingilizce ileri'), lang('Almanca', 0, 'almanca')]],
  ['İngilizce, ileri', [lang('İngilizce', 4, 'İngilizce, ileri')]],
  // "orta-ileri" is spoken without the hyphen; plain "ileri" would win as the longer keyword
  ['ingilizce orta ileri', [lang('İngilizce', 3, 'ingilizce orta ileri')]],
  // typed on an English keyboard / with caps lock: known names get their proper spelling
  ['INGILIZCE ILERI', [lang('İngilizce', 4, 'INGILIZCE ILERI')]],
  ['Ingilizce ileri', [lang('İngilizce', 4, 'Ingilizce ileri')]]
]);
// The whole voice path: two pauses in the language answer → list field → PDF items.
(function () {
  var field = '';
  ['ingilizce ileri seviye almanca başlangıç', 'fransızca orta'].forEach(function (seg) {
    field = P.mergeSegment('list', field, seg, { append: true });
  });
  check('langs field after dictation', field, 'İngilizce ileri seviye almanca başlangıç, Fransızca orta');
  var items = P.parseLanguages(field).map(function (l) {
    return P.languageName(l.name, 'en') + ' ' + P.levelLabel(l.level, 'en');
  });
  check('langs for the PDF (en)', items, ['English Advanced', 'German Beginner', 'French Intermediate']);
})();

// ---------------------------------------------------------------------------------------------
// wordsToNumbers on dictation
// ---------------------------------------------------------------------------------------------
table('wordsToNumbers', [
  ['Excel bir yıl SQL iki yıl', 'Excel 1 yıl SQL 2 yıl'],
  ['on yıl boyunca', '10 yıl boyunca'],
  ['BİN DOKUZ YÜZ DOKSAN SEKİZ', '1998'],
  ['iki bin yirmi bir yılında', '2021 yılında'],
  ['yirmi on', '20 10'],
  ['sıfır sıfır', '0 0'],
  ['dokuz yüz doksan dokuz bin', '999000'],
  ['beşinci onuncu binası', 'beşinci onuncu binası'],
  ['yüzde on', 'yüzde 10']
]);

// ---------------------------------------------------------------------------------------------
print('parse-adversarial: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) throw new Error(failed + ' adversarial parse test(s) failed');
