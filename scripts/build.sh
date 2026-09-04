#!/bin/bash
# Build Claude Counter and (optionally) launch the freshly built app.
#
#   ./scripts/build.sh          build only
#   ./scripts/build.sh --open   build, then open the app so Safari picks up
#                               the new extension
#
# Works from any checkout location — no hardcoded paths. Requires full Xcode
# (xcodebuild is not part of the Command Line Tools).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_DIR/build"

xcodebuild \
	-project "$REPO_DIR/Claude Counter.xcodeproj" \
	-scheme "Claude Counter" \
	-configuration Debug \
	-derivedDataPath "$BUILD_DIR" \
	build

APP="$BUILD_DIR/Build/Products/Debug/Claude Counter.app"
echo
echo "Built: $APP"

if [[ "${1:-}" == "--open" ]]; then
	open "$APP"
	echo "Opened. Enable the extension in Safari → Settings → Extensions"
	echo "(requires Develop → Allow Unsigned Extensions for ad-hoc builds)."
fi
