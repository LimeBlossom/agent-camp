#!/usr/bin/env bash
# build: package into dist-next. swap: publish a verified Camp package when
# MD_CAMP_INSTALL_DIR is set, or rotate the legacy dist directories.
set -euo pipefail

# Without MD_CAMP_BRANCH (an older app passes no branch) the tip check is skipped.
tip_is_current() {
  [ -z "${MD_CAMP_BRANCH:-}" ] ||
    [ "$(git -C "$MD_CAMP_EXPECT_REPO" rev-parse --verify "refs/heads/$MD_CAMP_BRANCH")" = "$MD_BUILD_SHA" ]
}

managed_swap() (
  local sha=${MD_BUILD_SHA:-} install image name current previous keep file
  [[ $sha =~ ^[a-f0-9]{40}$ ]] || { echo "local-build: expected a full build SHA" >&2; return 2; }
  install=$(realpath -m -- "$MD_CAMP_INSTALL_DIR")
  mkdir -p -- "$install/builds"
  # The automated job already holds this lock across checkout, build and swap.
  if [ "${MD_CAMP_LOCK_HELD:-}" != 1 ]; then
    exec 9>"$install/.build.lock"
    flock 9
  fi

  local images=()
  shopt -s nullglob
  images=(dist-next/*.AppImage)
  [ "${#images[@]}" -eq 1 ] || { echo "local-build: expected one staged AppImage" >&2; return 2; }
  swap_work=$(mktemp -d "$install/.swap.XXXXXXXX")
  trap 'rm -rf -- "$swap_work"' EXIT
  cp -- "${images[0]}" "$swap_work/image.AppImage"
  chmod +x "$swap_work/image.AppImage"
  (
    cd "$swap_work"
    ./image.AppImage --appimage-extract resources/app.asar
  ) >&2
  node - "$swap_work/squashfs-root/resources/app.asar" "$sha" <<'JS'
const asar = require('@electron/asar');
const [archive, sha] = process.argv.slice(2);
if (asar.extractFile(archive, 'out/camp-build-sha').toString().trim() !== sha) {
  throw new Error('AppImage SHA does not match the requested commit');
}
JS

  image="$install/builds/Camp-$sha.AppImage"
  current="$install/current.AppImage"
  previous=$(realpath -e -- "$current" 2>/dev/null || true)
  if [ -e "$current" ] && [ ! -L "$current" ]; then
    echo "local-build: launcher is not a symlink: $current" >&2
    return 2
  fi
  ln -s -- "$image" "$swap_work/current.AppImage"
  if [ -n "${MD_CAMP_EXPECT_REPO:-}" ] && ! tip_is_current; then
    return 75
  fi
  mv -Tf -- "$swap_work/image.AppImage" "$image"
  mv -Tf -- "$swap_work/current.AppImage" "$current"

  keep=1
  if [ "$previous" != "$image" ] && [[ $previous == "$install/builds/"* ]]; then
    keep=2
  fi
  # Protect the previous launcher target even when it is older than other builds.
  while IFS= read -r -d '' file; do
    name=${file##*/}
    [[ $name =~ ^Camp-[a-f0-9]{40}\.AppImage$ ]] || continue
    [ "$file" != "$image" ] && [ "$file" != "$previous" ] || continue
    if [ "$keep" -lt 3 ]; then
      keep=$((keep + 1))
    else
      rm -f -- "$file" || echo "local-build: could not prune $file" >&2
    fi
  done < <(find "$install/builds" -maxdepth 1 -type f -printf '%T@ %p\0' |
    sort -znr | cut -z -d ' ' -f 2-)
)

autobuild() {
  [ "$#" -eq 3 ] || [ "$#" -eq 4 ] || { echo "usage: local-build.sh autobuild REPO SHA INSTALL_DIR [BRANCH]" >&2; exit 2; }
  export MD_CAMP_EXPECT_REPO=$1 MD_BUILD_SHA=$2 MD_CAMP_INSTALL_DIR=$3 MD_CAMP_BRANCH=${4:-}
  [[ $MD_BUILD_SHA =~ ^[a-f0-9]{40}$ ]] || exit 2
  mkdir -p -- "$MD_CAMP_INSTALL_DIR"
  export MD_CAMP_INSTALL_DIR
  MD_CAMP_INSTALL_DIR=$(realpath -- "$MD_CAMP_INSTALL_DIR")
  MD_CAMP_EXPECT_REPO=$(realpath -- "$MD_CAMP_EXPECT_REPO")
  exec 9>"$MD_CAMP_INSTALL_DIR/.build.lock"
  flock 9
  tip_is_current || exit 75
  local current
  current=$(realpath -e -- "$MD_CAMP_INSTALL_DIR/current.AppImage" 2>/dev/null || true)
  [ "$current" != "$MD_CAMP_INSTALL_DIR/builds/Camp-$MD_BUILD_SHA.AppImage" ] || exit 75

  MD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/camp-build.XXXXXXXX")
  export MD_ROOT MD_CAMP_LOCK_HELD=1
  trap 'rm -rf -- "$MD_ROOT"' EXIT
  git -C "$MD_CAMP_EXPECT_REPO" archive "$MD_BUILD_SHA" | tar -x -C "$MD_ROOT"
  cd "$MD_ROOT"
  npm ci --no-audit --no-fund
  bash ./local-build.sh build
  bash ./local-build.sh swap
}

running() {
  [ -n "${MD_RUNNING:-}" ] && return $((1 - MD_RUNNING))
  pgrep -f '[.]mount_[^/]*/(munder-difflin|camp)' >/dev/null
}

if [ "${1:-}" = autobuild ]; then
  shift
  autobuild "$@"
  exit
fi

ROOT=${MD_ROOT:-$HOME/src/munder-difflin}
cd "$ROOT"
case ${1:-} in
  install-launcher)
    install -D -m 755 tools/munder-difflin "$HOME/.local/bin/munder-difflin" ;;
  launch)
    shift
    export CAMP_REPO_PATH="$PWD"
    exec "$HOME/.local/bin/munder-difflin" "$@" ;;
  build)
    run() { if [ -n "${MD_DRY:-}" ]; then echo "$*"; else "$@"; fi; }
    config=(--config electron-builder.local.yml)
    if [ -n "${MD_BUILD_SHA:-}" ]; then
      [[ $MD_BUILD_SHA =~ ^[a-f0-9]{40}$ ]] || exit 2
      config=(--config electron-builder.camp.yml)
    fi
    run npm run typecheck
    run env -u POSTHOG_KEY -u POSTHOG_HOST npm run build
    if [ -n "${MD_BUILD_SHA:-}" ] && [ -z "${MD_DRY:-}" ]; then
      printf '%s\n' "$MD_BUILD_SHA" > out/camp-build-sha
    fi
    run npx electron-builder --linux AppImage --publish never "${config[@]}" --config.directories.output=dist-next ;;
  swap)
    [ -d dist-next ] || { echo "no dist-next to swap in" >&2; exit 2; }
    if [ -n "${MD_CAMP_INSTALL_DIR:-}" ]; then
      managed_swap
      exit
    fi
    if running; then echo "local-build: the app is running from dist; close it first." >&2; exit 3; fi
    rm -rf dist-prev; [ -d dist ] && mv dist dist-prev; mv dist-next dist ;;
  *) echo "usage: local-build.sh build|swap|autobuild|install-launcher|launch [args...]" >&2; exit 2 ;;
esac
