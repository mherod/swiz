PACKAGE_PATH := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))
APP_NAME     := SwizNotify
APP_BUNDLE   := $(PACKAGE_PATH)/$(APP_NAME).app
APP_MACOS    := $(APP_BUNDLE)/Contents/MacOS
APP_BINARY   := $(APP_MACOS)/swiz-notify
BUILD_DIR    := $(PACKAGE_PATH)/.build/release

.PHONY: all build install clean debug

all: build

## Build release binary and assemble .app bundle
build:
	swift build -c release --package-path "$(PACKAGE_PATH)"
	@mkdir -p "$(APP_MACOS)"
	@ditto "$(BUILD_DIR)/swiz-notify" "$(APP_BINARY)"
	@ditto "$(PACKAGE_PATH)/Info.plist" "$(APP_BUNDLE)/Contents/Info.plist"
	@codesign --sign - --force --deep "$(APP_BUNDLE)"
	@echo "Built: $(APP_BUNDLE)"
	@echo "Binary: $(APP_BINARY)"

## Build debug binary (faster, no optimization)
debug:
	swift build --package-path "$(PACKAGE_PATH)"
	@mkdir -p "$(APP_MACOS)"
	@ditto "$(PACKAGE_PATH)/.build/debug/swiz-notify" "$(APP_BINARY)"
	@ditto "$(PACKAGE_PATH)/Info.plist" "$(APP_BUNDLE)/Contents/Info.plist"
	@codesign --sign - --force --deep "$(APP_BUNDLE)"
	@echo "Built (debug): $(APP_BUNDLE)"

## Install binary to /usr/local/bin (calls the binary inside the .app bundle)
install: build
	@ln -sf "$(APP_BINARY)" /usr/local/bin/swiz-notify
	@echo "Installed: /usr/local/bin/swiz-notify -> $(APP_BINARY)"

## Remove build artifacts and .app bundle
clean:
	@rm -rf "$(PACKAGE_PATH)/.build" "$(APP_BUNDLE)"
	@echo "Cleaned"
