/* Minimal browser globals so the pdfmake 0.2.10 browser bundle runs in Apple's jsc shell (tests only). */
var self = globalThis; var window = globalThis;
var navigator = { userAgent: 'jsc' };
var document = { createElement: function () { return {}; } };
if (typeof clearTimeout !== 'function') globalThis.clearTimeout = function () {};
if (!globalThis.console) globalThis.console = { log: print, warn: print, error: print, info: print };
