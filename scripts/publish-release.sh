#!/usr/bin/env bash
# Upload a published GitHub Release to the public Foundry R2 bucket.
#
# Versioned installers, archives and blockmaps are uploaded first with immutable
# cache headers. The latest*.yml feed files are uploaded last and are never
# cached, so an updater can never observe a manifest before its payload exists.
#
# Required environment:
#   CLOUDFLARE_ACCOUNT_ID
#   AWS_ACCESS_KEY_ID       bucket-scoped R2 Object Read & Write token id
#   AWS_SECRET_ACCESS_KEY   bucket-scoped R2 token secret
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"

command -v aws >/dev/null 2>&1 || {
  echo "aws CLI is required to publish release artifacts" >&2
  exit 1
}

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/publish-release.sh <release files...>" >&2
  exit 1
fi

R2_BUCKET="douchat"
R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
CDN_BASE="https://cdn.douchat.ai"
FILES=("$@")
ARTIFACTS=()
MANIFESTS=()

content_type() {
  case "$1" in
    *.yml) echo "text/yaml; charset=utf-8" ;;
    *.dmg) echo "application/x-apple-diskimage" ;;
    *.zip) echo "application/zip" ;;
    *.exe) echo "application/vnd.microsoft.portable-executable" ;;
    *.AppImage) echo "application/vnd.appimage" ;;
    *.deb) echo "application/vnd.debian.binary-package" ;;
    *) echo "application/octet-stream" ;;
  esac
}

for file in "${FILES[@]}"; do
  [ -f "$file" ] || {
    echo "release input is not a file: $file" >&2
    exit 1
  }
  case "$(basename "$file")" in
    latest.yml|latest-mac.yml|latest-linux.yml) MANIFESTS+=("$file") ;;
    *) ARTIFACTS+=("$file") ;;
  esac
done

if [ "${#ARTIFACTS[@]}" -eq 0 ] || [ "${#MANIFESTS[@]}" -eq 0 ]; then
  echo "a release must contain at least one artifact and one latest*.yml manifest" >&2
  exit 1
fi

upload() {
  local file="$1"
  local cache_control="$2"
  local name
  name="$(basename "$file")"
  echo "==> Uploading $name"
  AWS_EC2_METADATA_DISABLED=true aws s3 cp "$file" "s3://${R2_BUCKET}/${name}" \
    --endpoint-url "$R2_ENDPOINT" \
    --region auto \
    --content-type "$(content_type "$name")" \
    --cache-control "$cache_control" \
    --no-progress \
    --only-show-errors
}

for file in "${ARTIFACTS[@]}"; do
  upload "$file" "public, max-age=31536000, immutable"
done

for file in "${MANIFESTS[@]}"; do
  upload "$file" "no-store, max-age=0"
done

echo "Published ${#ARTIFACTS[@]} artifact(s) and ${#MANIFESTS[@]} update manifest(s)"
echo "Update feed: $CDN_BASE/$(basename "${MANIFESTS[0]}")"
