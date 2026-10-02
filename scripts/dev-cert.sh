#!/bin/sh
# Creates "PewterDesk Dev", a self-signed code-signing certificate in your
# login keychain, for `make dev` to sign the app with (scripts/dev-run.sh).
#
# Why: macOS remembers "Always Allow" for keychain items against the app's
# code signature. A plain dev build gets a new ad-hoc signature on every
# rebuild, so macOS asks again each time. Signed with this certificate, the
# signature's requirement names the certificate, not the build, so the
# permission survives rebuilds.
#
# Local only: the private key is generated here, imported into your login
# keychain (usable by codesign without a prompt), and the temporary files are
# deleted. Nothing is trusted system-wide - codesign doesn't need it to. Run
# once per machine; running it again does nothing. Remove it any time from
# Keychain Access ("PewterDesk Dev" under My Certificates).
set -eu

NAME="PewterDesk Dev"

if [ "$(uname)" != "Darwin" ]; then
  echo "dev-cert: only needed on macOS" >&2
  exit 0
fi
if security find-identity -p codesigning | grep -q "\"$NAME\""; then
  echo "dev-cert: \"$NAME\" is already in your keychain"
  exit 0
fi

tmp=$(mktemp -d)
cleanup() {
  rm -f "$tmp/key.pem" "$tmp/cert.pem" "$tmp/id.p12" "$tmp/cert.cnf"
  rmdir "$tmp"
}
trap cleanup EXIT

cat > "$tmp/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/cert.cnf" 2>/dev/null

# A one-off password for the transfer file; macOS's importer only reads the
# legacy PKCS#12 encryption (OpenSSL 3's default it can't).
pass=$(openssl rand -hex 16)
legacy=""
if openssl version | grep -q "^OpenSSL 3"; then legacy="-legacy"; fi
# shellcheck disable=SC2086
openssl pkcs12 -export $legacy -name "$NAME" -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
  -out "$tmp/id.p12" -passout "pass:$pass"

security import "$tmp/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P "$pass" -T /usr/bin/codesign >/dev/null

echo "dev-cert: created \"$NAME\"; \`make dev\` now signs the app with it"
