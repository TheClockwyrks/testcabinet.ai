#!/usr/bin/env bash
# Builds the gallery and deploys it to Cloudflare Pages.
#
#   scripts/ci/deploy-site.sh <branch>
#
# `master` deploys to the `the-test-cabinet` project (testcabinet.ai) and
# `staging` to `the-test-cabinet-staging` (staging.testcabinet.ai). The branch
# is passed to wrangler as `--branch`, which makes the upload that project's
# production deployment, because each project's production branch is the
# branch it deploys from. The superrepo's Releasing page
# (apps/docs/src/content/docs/development/releasing.md), section "Gallery
# (Cloudflare Pages and Workers, one-time)", says how the two projects are set
# up.
#
# TCAB_SNAPSHOT_URL, the public bucket's read URL for the branch's environment,
# CLOUDFLARE_API_TOKEN (Cloudflare Pages: Edit) and CLOUDFLARE_ACCOUNT_ID must
# be in the environment. The pipeline's deploy stage maps the first from the
# definition's per-branch variable and the other two from its secret variables
# of the same names. The build writes TCAB_SNAPSHOT_URL into the page as the
# bucket it reads the published dataset from in the browser, and bakes in
# nothing of the dataset itself, so a publish needs no deploy. A gallery built
# without one reads nothing, so a URL that is missing, empty or not an http(s)
# URL (an undefined pipeline variable reaches the step as its own `$(NAME)`
# text) is refused before anything is built rather than deployed over the live
# gallery.
set -euo pipefail

# The wrangler release the project's sites deploy with (WRANGLER_VERSION in
# the superrepo's scripts/ci/deploy-docs.sh and the publisher image).
readonly WRANGLER_VERSION="4.40.3"
# The gallery's npm workspace member and what its build writes.
readonly SITE="apps/site"

if [[ $# -ne 1 ]]; then
	echo "usage: scripts/ci/deploy-site.sh <branch>" >&2
	exit 1
fi
readonly BRANCH="$1"

case "$BRANCH" in
	master) project=the-test-cabinet ;;
	staging) project=the-test-cabinet-staging ;;
	*)
		echo "deploy-site.sh: '${BRANCH}' deploys no site (expected master or staging)" >&2
		exit 1
		;;
esac

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID must be set}"
: "${TCAB_SNAPSHOT_URL:?TCAB_SNAPSHOT_URL must be set: a gallery built without one reads no bucket}"
if [[ ! "$TCAB_SNAPSHOT_URL" =~ ^https?://[^[:space:]]+$ ]]; then
	echo "deploy-site.sh: TCAB_SNAPSHOT_URL is not an http(s) URL: '${TCAB_SNAPSHOT_URL}'" >&2
	exit 1
fi
export TCAB_SNAPSHOT_URL

# From the repository root, whatever directory the caller ran it from.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

echo "=== npm ci ==="
npm ci --no-audit --no-fund

# By its directory rather than its package name, which the site decides.
echo "=== build ${SITE} reading ${TCAB_SNAPSHOT_URL} ==="
npm run build -w "$SITE"

echo "=== deploy to ${project} ==="
npx --yes "wrangler@${WRANGLER_VERSION}" pages deploy "${SITE}/dist" \
	--project-name="$project" --branch="$BRANCH"
