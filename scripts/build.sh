#!/bin/bash
# Build Claude Counter, replace any previous install, and re-register the
# Safari extension.
#
#   ./scripts/build.sh                     clean reinstall, leaving Safari up
#   ./scripts/build.sh --restart-safari    also quit and reopen Safari
#   ./scripts/build.sh --build-only        just compile; change nothing else
#   ./scripts/build.sh --deep              also rebuild the LaunchServices database
#
# Safari is left running by default, because quitting it costs you two things:
# your tabs, and the "Allow unsigned extensions" grant, which Safari clears on
# every full quit and will not let a script set. Reloading the claude.ai tab is
# enough to pick up changed content scripts.
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

restart_safari=0
build_only=0
deep=0
for arg in "$@"; do
	case "$arg" in
		--restart-safari) restart_safari=1 ;;
		--keep-safari) restart_safari=0 ;; # now the default; kept so old muscle memory still works
		--build-only)  build_only=1 ;;
		--deep)        deep=1 ;;
		--open)        ;; # accepted for compatibility: a reinstall always opens the app
		-h|--help)     sed -n '2,23p' "$0" | cut -c3-; exit 0 ;;
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

SAVED_TABS="$(mktemp -t cc-tabs)"
trap 'rm -f "$SAVED_TABS"' EXIT

# Every http(s) tab Safari currently has open, one URL per line.
capture_tabs() {
	osascript <<'APPLESCRIPT' 2>/dev/null || true
tell application "Safari"
	set urlList to {}
	repeat with w in windows
		repeat with t in tabs of w
			try
				set u to URL of t
				if u is not missing value and u starts with "http" then set end of urlList to u
			end try
		end repeat
	end repeat
	set AppleScript's text item delimiters to linefeed
	return urlList as text
end tell
APPLESCRIPT
}

if (( restart_safari && safari_was_running )); then
	step "Quitting Safari"
	capture_tabs > "$SAVED_TABS"
	note "saved $(grep -c . "$SAVED_TABS" || echo 0) tabs to reopen"
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
	# Wait for it to be scriptable before asking what it restored.
	for _ in $(seq 1 50); do
		osascript -e 'tell application "Safari" to count windows' >/dev/null 2>&1 && break
		sleep 0.2
	done

	# Safari restores the last session only when its own settings say to, so
	# reopen whatever did not come back. Checking first avoids doubling tabs.
	if [ -s "$SAVED_TABS" ]; then
		already="$(capture_tabs)"
		reopened=0
		while IFS= read -r url; do
			[ -n "$url" ] || continue
			case "$already" in *"$url"*) continue ;; esac
			open -a Safari "$url"
			reopened=$((reopened + 1))
		done < "$SAVED_TABS"
		if (( reopened )); then
			note "reopened $reopened tabs Safari did not restore"
		else
			note "Safari restored your tabs itself"
		fi
	fi
fi

if (( restart_safari && safari_was_running )); then
	cat <<EOF

${bold}Installed.${reset} Safari was restarted, so it has cleared
${bold}Allow unsigned extensions${reset} and you need to set it again:

  Settings -> Developer -> ${bold}Allow unsigned extensions${reset}
  (Settings -> Advanced -> "Show features for web developers" reveals that tab.)

Then check ${bold}Claude Counter${reset} under Settings -> Extensions if it is off.
EOF
else
	cat <<EOF

${bold}Installed.${reset} Reload your claude.ai tab to pick up the change.

Safari was left running, so your tabs and your ${bold}Allow unsigned extensions${reset}
grant are both still in place. If the tab reload is not enough, re-run with
${bold}--restart-safari${reset} — that does clear the grant and you will have to set it again.
EOF
fi

printf '\nYour widget settings are untouched by a reinstall.\n'
