#!/usr/bin/env bash
# Deploys the gallery's two Workers to Cloudflare.
#
#   scripts/ci/deploy-workers.sh <branch>
#
# `master` deploys each Worker's `production` environment and `staging` its
# `staging` environment, as each Worker's wrangler.toml declares them: the
# preview-tag Worker (apps/preview-tags) on the gallery's run routes and the
# share-link Worker (apps/share-links) on tcab.ai or staging.tcab.ai. The
# superrepo's Public Gallery deployment page
# (apps/docs/src/content/docs/deployment/public-gallery.md), sections "The
# Workers" and "Staging", states the names, and its Releasing page, section
# "Gallery (Cloudflare Pages and Workers, one-time)", how the account is set up.
#
# CLOUDFLARE_API_TOKEN (Workers Scripts: Edit on the account, and Workers
# Routes: Edit and DNS: Edit on the testcabinet.ai and tcab.ai zones, since the
# share-link Worker's hostname is a custom domain the deploy creates) and
# CLOUDFLARE_ACCOUNT_ID must be in the environment; the pipeline's deploy stage
# maps them from its secret variables of the same names. A Worker imports
# nothing outside its own sources, so wrangler bundles each without an install.
set -euo pipefail

# The wrangler release the project's sites deploy with (WRANGLER_VERSION in
# deploy-site.sh, the superrepo's scripts/ci/deploy-docs.sh and the publisher
# image).
readonly WRANGLER_VERSION="4.40.3"
# The Workers, by their npm workspace member's directory.
readonly WORKERS=(apps/preview-tags apps/share-links)

if [[ $# -ne 1 ]]; then
	echo "usage: scripts/ci/deploy-workers.sh <branch>" >&2
	exit 1
fi
readonly BRANCH="$1"

case "$BRANCH" in
	master) environment=production ;;
	staging) environment=staging ;;
	*)
		echo "deploy-workers.sh: '${BRANCH}' deploys no Worker (expected master or staging)" >&2
		exit 1
		;;
esac

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID must be set}"

# From the repository root, whatever directory the caller ran it from.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

for worker in "${WORKERS[@]}"; do
	echo "=== deploy ${worker} (${environment}) ==="
	npx --yes "wrangler@${WRANGLER_VERSION}" deploy \
		--config "${worker}/wrangler.toml" --env "$environment"
done
