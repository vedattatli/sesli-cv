#!/bin/sh
# Builds site/ and adds site/dev.html with a fake speech recognizer (for local testing only).
cd "$(dirname "$0")/.." && python3 build.py >/dev/null && cp tests/fake-sr.js site/fake-sr.js && cp tests/sample-cv.json site/sample-cv.json && \
sed 's#<script src="parse.js"></script>#<script src="fake-sr.js"></script>\n<script src="parse.js"></script>#' site/index.html > site/dev.html && echo "site/dev.html hazır"
