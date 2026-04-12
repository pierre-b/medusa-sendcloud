.PHONY: help dev build publish-local lint format check test test-unit test-integration test-http clean

# ─── Help ─────────────────────────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Development ──────────────────────────────────────────────────────────────

dev: ## Watch, rebuild, and republish to the local yalc registry
	npx medusa plugin:develop

build: ## Build plugin into .medusa/server/
	npx medusa plugin:build

publish-local: ## Publish the plugin to the local yalc registry
	npx medusa plugin:publish

# ─── Quality ──────────────────────────────────────────────────────────────────

lint: ## Run ESLint with autofix
	npx eslint . --fix

format: ## Run Prettier
	npx prettier --write .

check: ## Run lint + format check + type check (CI gate)
	npx eslint .
	npx prettier --check .
	npx tsc --noEmit

# ─── Tests ────────────────────────────────────────────────────────────────────

test: test-unit test-integration test-http ## Run all tests

test-unit: ## Run unit tests
	npm run test:unit

test-integration: ## Run module integration tests
	npm run test:integration:modules

test-http: ## Run HTTP integration tests
	npm run test:integration:http

# ─── Cleanup ──────────────────────────────────────────────────────────────────

clean: ## Remove build artifacts and cache
	rm -rf .medusa .cache dist
