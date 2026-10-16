#!/bin/bash
# Personal lab backup for Bash and GNU tools. No automatic retention/deletion.
set -u
set -o pipefail
umask 077

if (( $# != 2 )); then
  printf 'usage: %s SOURCE_DIRECTORY DESTINATION_DIRECTORY\n' "$0" >&2
  exit 2
fi
if [[ ! -d "$1" ]]; then
  printf 'not a source directory: %s\n' "$1" >&2
  exit 1
fi
source_dir=$(realpath -e -- "$1") || exit 1
destination=$(realpath -m -- "$2") || exit 1
if [[ "$source_dir" == / || "$destination" == "$source_dir" || "$destination" == "$source_dir/"* ]]; then
  printf 'refusing root source or destination inside source\n' >&2
  exit 1
fi
mkdir -p -- "$destination" || exit 1
temporary=$(mktemp -- "$destination/.partial-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX.tar.gz") || exit 1
trap 'rm -f -- "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! tar -czf "$temporary" -C "$source_dir" .; then
  printf 'archive creation failed\n' >&2
  exit 1
fi
if ! gzip -t -- "$temporary" || ! tar -tzf "$temporary" >/dev/null; then
  printf 'archive validation failed\n' >&2
  exit 1
fi
base=${temporary##*/}
final="$destination/backup-${base#.partial-}"
mv -T -- "$temporary" "$final" || exit 1
trap - EXIT INT TERM
printf '%s\n' "$final"
