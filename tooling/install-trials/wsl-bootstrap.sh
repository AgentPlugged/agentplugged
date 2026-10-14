#!/bin/sh
# Runs INSIDE a Linux distribution of WSL (started by local.mjs): sh wsl-bootstrap.sh <node major> <archive>
# Node.js comes from nodejs.org into ~/.cache/agentplugged-trials (nothing is installed in the system,
# no rights are needed); the trial works in /tmp, on the distribution's own disk (the Windows disk
# mounted in WSL does not keep the execute bit of the stand-in programs).
set -eu

major="${1:?node major version}"
archive="${2:?package archive or agentplugged@version}"
here="$(cd "$(dirname "$0")" && pwd)"
cache="$HOME/.cache/agentplugged-trials"
mkdir -p "$cache"

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

for needed in curl xz; do
  if ! command -v "$needed" >/dev/null 2>&1; then
    echo "$needed is needed to download Node.js: sudo apt-get install -y curl xz-utils (Debian, Ubuntu)" >&2
    exit 2
  fi
done

index="https://nodejs.org/dist/latest-v${major}.x"
file="$(curl -fsSL "$index/SHASUMS256.txt" | grep "linux-${arch}.tar.xz" | awk '{print $2}' | head -n 1)"
if [ -z "$file" ]; then
  echo "no Node.js ${major} for linux-${arch} on nodejs.org" >&2
  exit 2
fi
folder="${file%.tar.xz}"
if [ ! -x "$cache/$folder/bin/node" ]; then
  echo "Downloading $file"
  curl -fsSL "$index/$file" -o "$cache/$file"
  tar -xJf "$cache/$file" -C "$cache"
  rm -f "$cache/$file"
fi
export PATH="$cache/$folder/bin:$PATH"
echo "Node.js $(node --version), $(git --version 2>/dev/null || echo 'Git not installed')"

work="$(mktemp -d /tmp/agentplugged-trial-XXXXXX)"
trap 'rm -rf "$work"' EXIT
code=0
node "$here/trial.mjs" --package "$archive" --shell all --work "$work/run" || code=$?
exit "$code"
