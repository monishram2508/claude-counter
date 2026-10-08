#!/bin/bash
# Build Claude Counter, replace any previous install, and re-register the
# Safari extension.
#
#   ./scripts/build.sh                 clean reinstall (what you usually want)
#   ./scripts/build.sh --keep-safari   same, but never quit or reopen Safari
#   ./scripts/build.sh --build-only    just compile; change nothing else
#   ./scripts/build.sh --deep          also rebuild the LaunchServices database
#
# Safari registers a web extension by the path of the .app that contains it, so
# where the app lives matters more than it looks. Building into DerivedData and
# launching it from there leaves Safari pointing into a directory the next build
# deletes — the extension then goes stale, disappears, or shows up twice after a
# restart. This installs the app to a fixed location instead ($HOME/Applications,
# override with CC_INSTALL_DIR) and tears the old registration down first.
#
# Works from any checkout location. Requires full Xcode, not just the Command
# Line Tools.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_DIR/build"
APP_NAME="Claude Counter.app"
APPEX_NAME="Claude Counter Extension.appex"
EXT_BUNDLE_ID="com.monish.claudecounter.Extension"
# Bundle ids this project has shipped under. The first is current; the rest are
# older ids that may still be registered from a previous install.
LEGACY_EXT_BUNDLE_IDS=("com.yourCompany.Claude-Counter.Extension")
INSTALL_DIR="${CC_INSTALL_DIR:-$HOME/Applications}"
INSTALLED_APP="$INSTALL_DIR/$APP_NAME"
BUILT_APP="$BUILD_DIR/Build/Products/Debug/$APP_NAME"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

restart_safari=1
build_only=0
deep=0
for arg in "$@"; do
	case "$arg" in
		--keep-safari) restart_safari=0 ;;
		--build-only)  build_only=1 ;;
		--deep)        deep=1 ;;
		--open)        ;; # accepted for compatibility: a reinstall always opens the app
		-h|--help)     sed -n '2,18p' "$0" | cut -c3-; exit 0 ;;
		*) printf 'unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
	esac
done

bold=$'\033[1m'; dim=$'\033[2m'; reset=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
note() { printf '    %s%s%s\n' "$dim" "$1" "$reset"; }

# ---------------------------------------------------------------------------
# Build only: no teardown, no install, no Safari.
# ---------------------------------------------------------------------------
build() {
	step "Building"
	xcodebuild \
		-project "$REPO_DIR/Claude Counter.xcodeproj" \
		-scheme "Claude Counter" \
		-configuration Debug \
		-derivedDataPath "$BUILD_DIR" \
		build
	[ -d "$BUILT_APP" ] || { printf '\nBuild reported success but %s is missing.\n' "$BUILT_APP" >&2; exit 1; }
}

if (( build_only )); then
	build
	# xcodebuild registers what it builds with LaunchServices. Left alone, that
	# copy becomes a second "Claude Counter" extension alongside the installed
	# one. A build is not an install, so take the registration back out.
	"$LSREGISTER" -u "$BUILT_APP" >/dev/null 2>&1 || true
	printf '\nBuilt: %s\n' "$BUILT_APP"
	printf 'Not installed. Run without --build-only to install it.\n'
	exit 0
fi

# ---------------------------------------------------------------------------
# 1. Quit Safari. An extension's appex cannot be cleanly swapped underneath a
#    running Safari, and registration changes only settle on the next launch.
# ---------------------------------------------------------------------------
safari_was_running=0
pgrep -xq Safari && safari_was_running=1

if (( restart_safari && safari_was_running )); then
	step "Quitting Safari"
	note "tabs come back when it reopens"
	osascript -e 'tell application "Safari" to quit' >/dev/null 2>&1 || true
	for _ in $(seq 1 50); do
		pgrep -xq Safari || break
		sleep 0.2
	done
	if pgrep -xq Safari; then
		printf '\nSafari is still running — it may be asking you to confirm closing tabs.\n' >&2
		printf 'Quit it and re-run, or pass --keep-safari.\n' >&2
		exit 1
	fi
fi

# ---------------------------------------------------------------------------
# 2. Remove the previous install: unregister the extension, unregister the app,
#    then delete it. Order matters — both tools need the path to still exist.
# ---------------------------------------------------------------------------
step "Removing the previous install"

unregister_appex() {
	local appex="$1"
	[ -d "$appex" ] || return 0
	note "unregister $appex"
	pluginkit -r "$appex" >/dev/null 2>&1 || true
}

# Every appex we might have registered before, wherever it was launched from.
unregister_appex "$INSTALLED_APP/Contents/PlugIns/$APPEX_NAME"
unregister_appex "$BUILT_APP/Contents/PlugIns/$APPEX_NAME"
for stale in "$HOME/Library/Developer/Xcode/DerivedData/Claude_Counter-"*; do
	[ -d "$stale" ] || continue
	unregister_appex "$stale/Build/Products/Debug/$APP_NAME/Contents/PlugIns/$APPEX_NAME"
	unregister_appex "$stale/Build/Products/Debug/$APPEX_NAME"
done

if [ -d "$INSTALLED_APP" ]; then
	note "unregister $INSTALLED_APP"
	"$LSREGISTER" -u "$INSTALLED_APP" >/dev/null 2>&1 || true
	note "delete $INSTALLED_APP"
	rm -rf "$INSTALLED_APP"
else
	note "nothing installed at $INSTALLED_APP"
fi

# Any other copy LaunchServices still knows about — an old build, a copy in the
# Trash — carries the same extension, and Safari lists each copy separately.
# That is what makes the extension appear twice.
while IFS= read -r other; do
	[ -n "$other" ] || continue
	[ "$other" = "$INSTALLED_APP" ] && continue
	note "unregister stray copy $other"
	"$LSREGISTER" -u "$other" >/dev/null 2>&1 || true
	# Only delete copies we own: build output. Anything else is the user's.
	case "$other" in
		"$BUILD_DIR"/*|"$HOME"/Library/Developer/Xcode/DerivedData/*) rm -rf "$other" ;;
		"$HOME"/.Trash/*) printf '    Still in your Trash: %s\n' "$other"
		                  printf '    Empty the Trash so Safari stops counting it.\n' ;;
	esac
done < <("$LSREGISTER" -dump 2>/dev/null \
	| sed -n 's/^path:[[:space:]]*\(.*\/'"$APP_NAME"'\)[[:space:]]*(.*$/\1/p' \
	| sort -u)

# Stale DerivedData holds appex copies Safari may still be pointing at.
for stale in "$HOME/Library/Developer/Xcode/DerivedData/Claude_Counter-"*; do
	[ -d "$stale" ] || continue
	note "delete stale $stale"
	rm -rf "$stale"
done
rm -rf "$BUILD_DIR"

if (( deep )); then
	note "rebuilding the LaunchServices database (this takes a moment)"
	"$LSREGISTER" -kill -r -domain local -domain user >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# 3. Build, then install to a path that survives the next rebuild.
# ---------------------------------------------------------------------------
build

step "Installing"
mkdir -p "$INSTALL_DIR"
ditto "$BUILT_APP" "$INSTALLED_APP"
note "$INSTALLED_APP"

# xcodebuild registers the app it just built with LaunchServices all by itself.
# Leaving that copy on disk means two apps carry the same extension and Safari
# lists "Claude Counter" twice, with both widgets drawing on the page. Drop it;
# the intermediates stay, so the next build is still incremental.
"$LSREGISTER" -u "$BUILT_APP" >/dev/null 2>&1 || true
rm -rf "$BUILT_APP"

"$LSREGISTER" -f "$INSTALLED_APP" >/dev/null 2>&1 || true
# Launching the app once is what hands the extension to Safari.
open -g "$INSTALLED_APP"

# ---------------------------------------------------------------------------
# 4. Confirm the extension actually registered, rather than assuming it did.
# ---------------------------------------------------------------------------
step "Verifying"
registered=""
for _ in $(seq 1 25); do
	registered="$(pluginkit -m -i "$EXT_BUNDLE_ID" 2>/dev/null || true)"
	[ -n "$registered" ] && break
	sleep 0.2
done

copies="$("$LSREGISTER" -dump 2>/dev/null \
	| sed -n 's/^path:[[:space:]]*\(.*\/'"$APP_NAME"'\)[[:space:]]*(.*$/\1/p' \
	| sort -u | grep -c . || true)"

if [ -n "$registered" ]; then
	note "$EXT_BUNDLE_ID is registered with Safari"
	if [ "${copies:-1}" -gt 1 ]; then
		printf '    Warning: %s copies of %s are still known to macOS, so\n' "$copies" "$APP_NAME"
		printf '    Safari may list the extension more than once. Run with --deep.\n'
	else
		note "one copy installed — no duplicate extension entries"
	fi
else
	printf '    Extension not registered yet. It usually appears once Safari\n'
	printf '    reopens; if it does not, run with --deep.\n'
fi

for id in "${LEGACY_EXT_BUNDLE_IDS[@]}"; do
	if [ -n "$(pluginkit -m -i "$id" 2>/dev/null || true)" ]; then
		printf '    Heads up: an older build is still registered as %s.\n' "$id"
		printf '    Delete whatever app it belongs to, then run with --deep.\n'
	fi
done

# ---------------------------------------------------------------------------
# 5. Reopen Safari and print the parts macOS will not let a script do.
# ---------------------------------------------------------------------------
if (( restart_safari && safari_was_running )); then
	step "Reopening Safari"
	open -a Safari
fi

if (( restart_safari && safari_was_running )); then
	quit_note="Safari clears this every time it fully quits, including just now."
else
	quit_note="Safari clears this every time it fully quits."
fi

cat <<EOF

${bold}Installed.${reset} Two things Safari only accepts from a human:

  1. Settings -> Developer -> ${bold}Allow unsigned extensions${reset}
     (Settings -> Advanced -> "Show features for web developers" reveals that tab.)
     $quit_note
  2. Settings -> Extensions -> enable ${bold}Claude Counter${reset}, then allow claude.ai.

Your widget settings are untouched by a reinstall.
EOF
