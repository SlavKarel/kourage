#!/usr/bin/env bash
# This script is run by GitHub Actions, from the repository root.
# Existing PHP data is never copied or removed by this deployment.
set -euo pipefail

: "${TIMEWEB_HOST:?Set the TIMEWEB_HOST repository variable}"
: "${TIMEWEB_USER:?Set the TIMEWEB_USER repository variable}"
: "${TIMEWEB_SSH_KEY:?Set the TIMEWEB_SSH_KEY repository secret}"
: "${TIMEWEB_KNOWN_HOSTS:?Set the verified TIMEWEB_KNOWN_HOSTS repository secret}"
: "${RUNNER_TEMP:?Run this script through GitHub Actions}"
: "${GITHUB_RUN_ID:?Missing run ID}"
: "${GITHUB_RUN_ATTEMPT:?Missing run attempt}"

[[ "$TIMEWEB_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo 'Invalid server address'; exit 1; }
[[ "$TIMEWEB_USER" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_-]*$ ]] || { echo 'Invalid SSH username'; exit 1; }
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]] || exit 1
command -v rsync >/dev/null
php -l public_html/api.php
node --check public_html/assets/app.js
node --check public_html/assets/bank.js
node --check public_html/assets/builder.js
node --check public_html/assets/classwork.js
node --check public_html/assets/homework.js

# An explicit list prevents unrelated uploaded files or live data being sent.
expected=$'api.php\nassets/app.js\nassets/bank.js\nassets/builder.js\nassets/classwork.js\nassets/favicon.svg\nassets/homework.js\nassets/style.css\nbank.html\nbuilder.html\nclasswork.html\nhomework.html\nindex.html'
[[ "$(cat deploy/public-files.txt)" == "$expected" ]] || { echo 'Unexpected deployment file list'; exit 1; }
[[ -d public_html && ! -L public_html && -d public_html/assets && ! -L public_html/assets ]] || exit 1
while IFS= read -r item; do
  [[ -f "public_html/$item" && ! -L "public_html/$item" ]] || { echo "Missing file: $item"; exit 1; }
done < deploy/public-files.txt

umask 077
key_file=$(mktemp "$RUNNER_TEMP/kourage-deploy-key.XXXXXX")
hosts_file=$(mktemp "$RUNNER_TEMP/kourage-deploy-hosts.XXXXXX")
trap 'rm -f -- "$key_file" "$hosts_file"' EXIT
printf '%s\n' "$TIMEWEB_SSH_KEY" > "$key_file"
printf '%s\n' "$TIMEWEB_KNOWN_HOSTS" > "$hosts_file"
unset TIMEWEB_SSH_KEY TIMEWEB_KNOWN_HOSTS

ssh_options=(-i "$key_file" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$hosts_file" -o ConnectTimeout=20)
destination="$TIMEWEB_USER@$TIMEWEB_HOST"
release="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"

# Fixed path for this existing site. No mkdir of public_html: a wrong account
# or a missing site must fail instead of silently creating another website.
ssh "${ssh_options[@]}" "$destination" "sh -s -- $release" <<'REMOTE'
set -eu
test -d courage/public_html
test ! -L courage
test ! -L courage/public_html
test -d courage/public_html/assets
test ! -L courage/public_html/assets
test -f courage/private/kourage.sqlite
command -v rsync >/dev/null
for file in api.php index.html bank.html builder.html classwork.html homework.html assets/app.js assets/bank.js assets/builder.js assets/classwork.js assets/homework.js assets/style.css assets/favicon.svg; do
  test ! -L "courage/public_html/$file"
done
test ! -L courage/.code-backups
mkdir -p "courage/.code-backups/$1"
chmod 700 courage/.code-backups "courage/.code-backups/$1"
REMOTE

printf -v transport '%q ' ssh "${ssh_options[@]}"
rsync --recursive --times --checksum --omit-dir-times --delay-updates \
  --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  --backup --backup-dir="../.code-backups/$release" \
  --files-from=deploy/public-files.txt \
  --rsh="$transport" \
  public_html/ "$destination:courage/public_html/"

echo 'Transfer completed. Previous code versions were saved on the host.'
