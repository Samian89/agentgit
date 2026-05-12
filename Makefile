.PHONY: build test release

build:
	pnpm build

test:
	pnpm test:integration

release: build test
