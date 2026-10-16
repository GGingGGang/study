#!/bin/bash
set -u
set -o pipefail

if (( $# != 1 )); then
  printf 'usage: %s DIRECTORY\n' "$0" >&2
  exit 2
fi
if [[ ! -d "$1" ]]; then
  printf 'not a directory: %s\n' "$1" >&2
  exit 1
fi
target=$(realpath -e -- "$1") || exit 1
printf 'time=%s\npath=%s\n' "$(date --iso-8601=seconds)" "$target"
df -h -- "$target" || exit 1
du -sh -- "$target" || exit 1
if ! find "$target" -type f -printf '.\n' | wc -l; then
  printf 'file count failed\n' >&2
  exit 1
fi
