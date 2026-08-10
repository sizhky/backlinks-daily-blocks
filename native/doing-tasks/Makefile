APP_NAME := Doing Tasks
BUNDLE := dist/$(APP_NAME).app
EXECUTABLE := .build/release/DoingTasks
INSTALL_DIR := $(HOME)/Applications

.PHONY: build test install clean

build:
	swift build -c release
	mkdir -p "$(BUNDLE)/Contents/MacOS" "$(BUNDLE)/Contents/Resources"
	cp Info.plist "$(BUNDLE)/Contents/Info.plist"
	cp "$(EXECUTABLE)" "$(BUNDLE)/Contents/MacOS/DoingTasks"
	codesign --force --deep --sign - "$(BUNDLE)"

test:
	swift test

install: build
	mkdir -p "$(INSTALL_DIR)"
	ditto "$(BUNDLE)" "$(INSTALL_DIR)/$(APP_NAME).app"

clean:
	swift package clean
	rm -rf "$(BUNDLE)"
