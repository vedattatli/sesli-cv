#!/bin/sh
# Adds public/dev.html: the app with a fake speech recognizer, a fake /api/cv and sample data (local testing only; gitignored).
cd "$(dirname "$0")/.." && cp tests/fake-sr.js tests/fake-ai.js tests/sample-cv.json public/ && \
sed 's#<script src="parse.js"></script>#<script src="fake-sr.js"></script>\n<script src="fake-ai.js"></script>\n<script src="parse.js"></script>#' public/index.html > public/dev.html && echo "public/dev.html hazır"
