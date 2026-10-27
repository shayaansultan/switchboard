#!/bin/sh
# Signs an installed Switchboard.app. Nested code is signed before the app so
# the app's seal covers it. The fan helper and bridge get fixed identifiers,
# because each only trusts the other by identifier and signing team; an
# ad-hoc identity ("-", the default) has no team, so fan control stays off.
set -e
APP="$1"
IDENTITY="${SWITCHBOARD_SIGN_IDENTITY:--}"
codesign --force --deep --sign "$IDENTITY" "$APP"
for name in fan-helper fan-bridge; do
  if [ -f "$APP/Contents/MacOS/$name" ]; then
    codesign --force --options runtime --identifier "dev.shayaan.switchboard.$name" \
      --sign "$IDENTITY" "$APP/Contents/MacOS/$name"
  fi
done
codesign --force --sign "$IDENTITY" "$APP"
