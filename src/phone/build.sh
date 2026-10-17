#!/bin/sh
# Builds the phone app into out/phone: the React bundle, the Tailwind
# stylesheet (with Switchboard's tokens from src/design inlined), and the
# static files a PWA needs. Run by `bun run build`.
set -e
out=out/phone
mkdir -p "$out"
bun build src/phone/main.tsx --outdir "$out" --target browser --minify --define 'process.env.NODE_ENV="production"' > /dev/null
./node_modules/.bin/tailwindcss -i src/phone/app.css -o "$out/style.css" --minify 2> /dev/null
cp src/phone/index.html src/phone/sw.js src/phone/manifest.webmanifest "$out/"
cp -R src/phone/icons "$out/icons"
cp -R src/design/fonts "$out/fonts"
echo "phone: built $out"
