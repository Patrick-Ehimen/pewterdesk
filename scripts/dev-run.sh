#!/bin/sh
# Cargo's runner for `make dev`: signs the freshly built app with the local
# "PewterDesk Dev" certificate (see scripts/dev-cert.sh), then runs it. A
# stable signature keeps macOS's keychain "Always Allow" across rebuilds.
# Without the certificate, or off macOS, it just runs the app.
bin="$1"
shift
if [ "$(uname)" = "Darwin" ] && security find-identity -p codesigning 2>/dev/null | grep -q '"PewterDesk Dev"'; then
  codesign --force --sign "PewterDesk Dev" --identifier app.pewterdesk.desktop "$bin" 2>/dev/null ||
    echo "dev-run: couldn't sign the app; keychain prompts will come back" >&2
fi
exec "$bin" "$@"
