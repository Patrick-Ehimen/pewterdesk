# Thin wrapper over pnpm and cargo — every target maps to a script, so the
# two can't drift. `make` on its own prints this menu.

TAURI_MANIFEST := apps/desktop/src-tauri/Cargo.toml

.DEFAULT_GOAL := help
.PHONY: help install lint fix typecheck test build check check-rust check-all dev dev-ui clean

help: ## Show this menu
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Resolve the workspace and enable the git hooks
	pnpm install
	git config core.hooksPath .githooks

lint: ## Biome lint + format check, whole repo
	pnpm lint

fix: ## Apply Biome's safe fixes and formatting
	pnpm fix

typecheck: ## tsc --noEmit every package
	pnpm -r run typecheck

test: ## Vitest every package
	pnpm -r run test

build: ## Build every package and app
	pnpm -r run build

check: lint typecheck test build ## What CI runs, in CI's order

check-rust: ## fmt, clippy and tests for the Tauri shell
	cargo fmt --manifest-path $(TAURI_MANIFEST) -- --check
	cargo clippy --manifest-path $(TAURI_MANIFEST) -- -D warnings
	cargo test --manifest-path $(TAURI_MANIFEST)

check-all: check check-rust ## check plus the Rust side (not in CI yet)

dev: ## Desktop app in a native window (needs Rust)
	pnpm --filter @pewterdesk/desktop tauri dev

dev-ui: ## Desktop frontend in a browser only, no Rust
	pnpm --filter @pewterdesk/desktop dev

clean: ## Remove build output (keeps node_modules and cargo target)
	find packages apps -name dist -type d -prune -not -path '*/node_modules/*' -exec rm -r {} +
