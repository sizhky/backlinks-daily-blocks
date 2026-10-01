#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_NAME="Hosts Menu Bar"
APP="$ROOT/dist/$APP_NAME.app"
BUILD="$ROOT/build/swiftpm"
REPLACE=0
if [ "${1:-}" = "--replace" ]; then REPLACE=1; fi

if [ -e "$APP" ] && [ "$REPLACE" -ne 1 ]; then
  echo "Refusing to replace existing app: $APP" >&2
  exit 1
fi

swift build -c release --package-path "$ROOT" --scratch-path "$BUILD"
mkdir -p "$APP/Contents/MacOS"
cp "$BUILD/release/HostsMenuBar" "$APP/Contents/MacOS/HostsMenuBar"
cp "$BUILD/release/HostsHelper" "$APP/Contents/MacOS/HostsHelper"
mkdir -p "$APP/Contents/Library/LaunchDaemons"
cp "$ROOT/Resources/com.yeshwanth.hosts-menu-bar-passwordless-lock.lock-helper.plist" \
  "$APP/Contents/Library/LaunchDaemons/com.yeshwanth.hosts-menu-bar-passwordless-lock.lock-helper.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>HostsMenuBar</string>
  <key>CFBundleIdentifier</key><string>com.yeshwanth.hosts-menu-bar</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP"
echo "$APP"
