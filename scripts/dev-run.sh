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
# macOS drops notifications from a program it can't read, and its notification
# service can't read Documents, Desktop or Downloads. From a checkout in one of
# those, run a copy from the user's caches instead (the signature goes with it).
if [ "$(uname)" = "Darwin" ]; then
  case "$bin" in
    "$HOME/Documents/"* | "$HOME/Desktop/"* | "$HOME/Downloads/"*)
      run="$HOME/Library/Caches/app.pewterdesk.desktop.dev"
      if mkdir -p "$run" && cp -f "$bin" "$run/"; then
        bin="$run/$(basename "$bin")"
      else
        echo "dev-run: couldn't copy the app out of a protected folder; desktop notifications won't show" >&2
      fi
      ;;
  esac
fi
exec "$bin" "$@"
