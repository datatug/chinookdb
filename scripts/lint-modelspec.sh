#!/usr/bin/env bash
# Validates model/chinook.modelspec.hcl with the SpecScore CLI, the ModelSpec
# validator that exists today (https://github.com/specscore/specscore-cli).
# `specscore graph lint` reads ModelSpec sources from a graph module's models/
# directory, so this script builds a throwaway tree with module "chinook" (the
# module short name that modelspec:///chinook.<Entity> references use), copies
# the model in, and lints it. It checks HCL syntax with the real HCL parser,
# reference resolution, reserved names, duplicate concepts and enum values.
#
# The CLI release is pinned by version and SHA-256. Set SPECSCORE to an
# installed binary to use that instead.
set -euo pipefail

# git sets GIT_DIR, GIT_INDEX_FILE and more for a hook it runs from a linked worktree. Every git call here
# (and every one the specscore CLI makes) must act on the throwaway tree, never on the repository of the hook,
# so no inherited GIT_* variable is kept.
while IFS= read -r name; do unset "$name"; done < <(compgen -e | grep '^GIT_' || true)

version=0.54.2
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ -n "${SPECSCORE:-}" ]]; then
  specscore="$SPECSCORE"
else
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) asset=linux_amd64 sha=e13ddf1543768bbe1f4573bc99202f6e5729b3d2b140c37bad972bdfdf8af12a ;;
    Darwin/arm64) asset=darwin_arm64 sha=ddc0861c589961b8392607473cd767f07746dad733bdd0af713aa13c69f133f8 ;;
    *) echo "lint-modelspec: no pinned specscore build for $(uname -s)/$(uname -m); set SPECSCORE to an installed binary" >&2; exit 2 ;;
  esac
  archive="specscore_${version}_${asset}.tar.gz"
  curl -fsSL -o "$work/$archive" "https://github.com/specscore/specscore-cli/releases/download/v${version}/${archive}"
  actual="$(shasum -a 256 "$work/$archive" | cut -d' ' -f1)"
  if [[ "$actual" != "$sha" ]]; then
    echo "lint-modelspec: $archive SHA-256 is $actual, expected $sha" >&2
    exit 1
  fi
  mkdir "$work/bin"
  tar -xzf "$work/$archive" -C "$work/bin" specscore
  specscore="$work/bin/specscore"
fi

tree="$work/tree"
mkdir -p "$tree"
git -C "$tree" init -q
(cd "$tree" && "$specscore" init --host github.com --org datatug --repo chinookdb --title chinookdb --no-telemetry > /dev/null)
(cd "$tree" && "$specscore" graph new module --id chinook --name Chinook --summary "Chinook sample database" --bare --no-telemetry > /dev/null)
mkdir -p "$tree/spec/graph/modules/chinook/models"
cp "$root/model/chinook.modelspec.hcl" "$tree/spec/graph/modules/chinook/models/"
(cd "$tree" && "$specscore" graph lint --severity info --no-telemetry)
echo "ModelSpec lint passed: model/chinook.modelspec.hcl (specscore $("$specscore" --version))"
