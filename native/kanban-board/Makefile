APP_NAME := Kanban Board
BUNDLE := dist/$(APP_NAME).app
EXECUTABLE := .build/release/KanbanBoard
INSTALL_DIR := $(HOME)/Applications

.PHONY: build test install run watch clean

build:
	swift build -c release
	mkdir -p "$(BUNDLE)/Contents/MacOS"
	cp Info.plist "$(BUNDLE)/Contents/Info.plist"
	mkdir -p "$(BUNDLE)/Contents/Resources"
	cp AppIcon.icns "$(BUNDLE)/Contents/Resources/AppIcon.icns"
	cp "$(EXECUTABLE)" "$(BUNDLE)/Contents/MacOS/KanbanBoard"
	codesign --force --deep --sign - -r='designated => identifier "com.yeshwanth.kanban-board"' "$(BUNDLE)"

test:
	swift test

install: build
	mkdir -p "$(INSTALL_DIR)"
	-pkill -x KanbanBoard
	rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	ditto "$(BUNDLE)" "$(INSTALL_DIR)/$(APP_NAME).app"

run: install
	sleep 1
	open "$(INSTALL_DIR)/$(APP_NAME).app"

# Rebuild, reinstall, and relaunch whenever a source file changes (polls every second).
watch:
	@last=""; while true; do \
	  cur=$$(find Sources Package.swift Info.plist AppIcon.icns -type f -exec stat -f '%m %N' {} + | shasum); \
	  if [ "$$cur" != "$$last" ]; then last="$$cur"; $(MAKE) run || true; fi; \
	  sleep 1; done

clean:
	swift package clean
	rm -rf dist
