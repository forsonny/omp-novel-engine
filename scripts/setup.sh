#!/usr/bin/env sh
set -eu

printf '%s\n' 'OMP Novel Engine setup'

missing=''
required_bun_version='1.3.14'

version_ge() {
  actual="$1"
  minimum="$2"
  old_ifs="$IFS"
  IFS=.
  set -- $actual
  actual_major=${1:-0}
  actual_minor=${2:-0}
  actual_patch=${3:-0}
  set -- $minimum
  minimum_major=${1:-0}
  minimum_minor=${2:-0}
  minimum_patch=${3:-0}
  IFS="$old_ifs"

  [ "$actual_major" -gt "$minimum_major" ] && return 0
  [ "$actual_major" -lt "$minimum_major" ] && return 1
  [ "$actual_minor" -gt "$minimum_minor" ] && return 0
  [ "$actual_minor" -lt "$minimum_minor" ] && return 1
  [ "$actual_patch" -ge "$minimum_patch" ]
}


require_command() {
  name="$1"
  url="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf '%s\n' "WARN $name was not found on PATH. Install it: $url"
    missing="$missing $name"
    return
  fi
  if ! version_output=$("$name" --version); then
    printf '%s\n' "WARN $name was found but failed to report a version."
    missing="$missing $name"
    return
  fi
  printf '%s\n' "$version_output"
  if [ "$name" = 'bun' ] && ! version_ge "$version_output" "$required_bun_version"; then
    printf '%s\n' "WARN Bun $version_output is installed, but Bun $required_bun_version or newer is required."
    missing="$missing bun>=$required_bun_version"
  fi
}

require_command bun 'https://bun.sh/docs/installation'
require_command docker 'https://docs.docker.com/desktop/'
require_command omp 'https://github.com/can1357/oh-my-pi'

if command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1; then
    printf '%s\n' 'WARN Docker is installed but the daemon is not responding. Start Docker Desktop or the Docker daemon and rerun setup.'
    missing="$missing docker-daemon"
  fi
fi

mkdir -p stories/demo/canon/graph
mkdir -p stories/demo/chapters
mkdir -p stories/demo/diagrams
mkdir -p docker/story-os-mcp/stories

if [ -n "$missing" ]; then
  printf '%s\n' "FAILED setup prerequisites are missing or unavailable:$missing"
  exit 1
fi

printf '%s\n' 'OK setup checks passed.'
printf '%s\n' 'Next: ./scripts/docker-up.sh'
