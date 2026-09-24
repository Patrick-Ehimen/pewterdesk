# pewterdesk — task runner
#
# A thin, discoverable wrapper over pnpm and cargo. Every target here shells out
# to the underlying tool rather than reimplementing it, so `make` and the
# pnpm scripts can never drift apart. Run `make` on its own for the menu.
#
# Targeted at GNU Make 3.81 (the version macOS ships), so no .ONESHELL and no
# 4.x-only builtins.

PNPM        := pnpm
CARGO       := cargo
DESKTOP_PKG := @pewterdesk/desktop
WEB_PKG     := @pewterdesk/web
SRC_TAURI   := apps/desktop/src-tauri
ICON_SRC    := ../../assets/icon/pewterdesk-icon-dark-1024.png
DEV_PORT    := 1420

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------

##@ Getting started

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\npewterdesk — make <target>\n"} \
		/^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } \
		END { printf "\n" }' $(MAKEFILE_LIST)

.PHONY: install
install: ## Install workspace dependencies (also enables the git hooks)
	$(PNPM) install

.PHONY: doctor
doctor: ## Check that the local toolchain can actually build and run the app
	@echo "node    $$(node --version 2>/dev/null || echo 'MISSING — need >= 22.12')"
	@echo "pnpm    $$(pnpm --version 2>/dev/null || echo 'MISSING — corepack enable')"
	@echo "cargo   $$(cargo --version 2>/dev/null || echo 'MISSING — https://rustup.rs')"
	@echo "rustc   $$(rustc --version 2>/dev/null || echo MISSING)"
	@printf 'tauri   '
	@$(PNPM) --filter $(DESKTOP_PKG) exec tauri --version 2>/dev/null \
		|| echo "BROKEN — native binding missing for $$(uname -m); re-run 'make install'"
	@printf 'hooks   '
	@h=$$(git config core.hooksPath 2>/dev/null); \
		if [ "$$h" = ".githooks" ]; then echo "enabled (.githooks)"; \
		else echo "NOT enabled — run 'make hooks'"; fi

##@ Running

.PHONY: dev
dev: ## Run the desktop app in a native window (Tauri; needs Rust)
	$(PNPM) --filter $(DESKTOP_PKG) run tauri dev

.PHONY: dev-ui
dev-ui: ## Run the desktop frontend in a browser only (no Rust, port 1420)
	$(PNPM) --filter $(DESKTOP_PKG) run dev

.PHONY: dev-web
dev-web: ## Run the deferred v2 web app
	$(PNPM) --filter $(WEB_PKG) run dev

.PHONY: stop
stop: ## Kill a stray Vite dev server holding port 1420
	@pid=$$(lsof -nP -iTCP:$(DEV_PORT) -sTCP:LISTEN -t 2>/dev/null); \
		if [ -n "$$pid" ]; then kill $$pid && echo "stopped pid $$pid on :$(DEV_PORT)"; \
		else echo "nothing listening on :$(DEV_PORT)"; fi

##@ Checks

.PHONY: check
check: lint typecheck test build ## Run everything CI runs, in CI's order
	@echo "all checks passed"

# ci.yml has no cargo steps, so CI currently cannot catch a broken Rust build.
# Until it does, this is the target to run before pushing anything touching
# src-tauri.
.PHONY: check-all
check-all: check rust-fmt-check rust-clippy rust-test ## check + the Rust side that CI does not cover
	@echo "all checks passed (JS + Rust)"

.PHONY: lint
lint: ## Lint every package
	$(PNPM) run lint

.PHONY: typecheck
typecheck: ## Typecheck every package
	$(PNPM) run typecheck

.PHONY: test
test: ## Run unit tests
	$(PNPM) run test

.PHONY: build
build: ## Build every package (tsc + vite)
	$(PNPM) run build

##@ Rust (apps/desktop/src-tauri)

.PHONY: rust-check
rust-check: ## cargo check the Tauri shell
	$(CARGO) check --manifest-path $(SRC_TAURI)/Cargo.toml

.PHONY: rust-clippy
rust-clippy: ## Lint the Rust side, warnings as errors
	$(CARGO) clippy --manifest-path $(SRC_TAURI)/Cargo.toml -- -D warnings

.PHONY: rust-fmt
rust-fmt: ## Format the Rust side in place
	$(CARGO) fmt --manifest-path $(SRC_TAURI)/Cargo.toml

.PHONY: rust-fmt-check
rust-fmt-check: ## Fail if the Rust side is unformatted
	$(CARGO) fmt --manifest-path $(SRC_TAURI)/Cargo.toml -- --check

.PHONY: rust-test
rust-test: ## Run Rust tests
	$(CARGO) test --manifest-path $(SRC_TAURI)/Cargo.toml

##@ Packaging

.PHONY: bundle
bundle: ## Build a distributable desktop app (.app/.dmg on macOS) — slow, release profile
	$(PNPM) --filter $(DESKTOP_PKG) run tauri build

.PHONY: icons
icons: ## Regenerate every icon size from the source PNG
	$(PNPM) --filter $(DESKTOP_PKG) run tauri icon $(ICON_SRC)
	@# tauri icon has no desktop-only flag; drop the mobile sets we don't ship
	rm -rf $(SRC_TAURI)/icons/android $(SRC_TAURI)/icons/ios

##@ Git hooks

.PHONY: hooks
hooks: ## Enable the repo's git hooks
	$(PNPM) run hooks:install

.PHONY: hooks-off
hooks-off: ## Disable the repo's git hooks
	$(PNPM) run hooks:uninstall

##@ Cleaning

.PHONY: clean
clean: ## Remove JS/TS build output (dist/, *.tsbuildinfo)
	rm -rf apps/web/dist apps/desktop/dist
	rm -rf packages/core/dist packages/ui/dist packages/exchange-hyperliquid/dist
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -not -path '*/node_modules/*' -delete

.PHONY: clean-rust
clean-rust: ## Remove the Rust build cache (forces a full recompile next run)
	$(CARGO) clean --manifest-path $(SRC_TAURI)/Cargo.toml

.PHONY: distclean
distclean: clean clean-rust ## Everything clean removes, plus node_modules
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	@echo "run 'make install' before building again"
