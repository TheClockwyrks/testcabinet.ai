#!/usr/bin/env bash
# Table test for deploy-site.sh. Run it directly: scripts/ci/deploy-site.test.sh
#
# A copy of the script runs in a throwaway repository with `npm` and `npx`
# stubbed first on PATH, each recording its arguments, the directory it ran in
# and the Cloudflare and snapshot variables it saw. Nothing is built and nothing reaches
# Cloudflare. The subject is which Pages project each branch deploys to, from
# where, and what is refused.
set -uo pipefail

CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly CI_DIR
pass=0
fail=0

ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() {
	fail=$((fail + 1))
	printf 'FAIL  %s\n' "$1"
	shift
	printf '        %s\n' "$@"
}

check_equal() { # label expected actual
	if [ "$2" = "$3" ]; then
		ok "$1"
	else
		bad "$1" "expected: $2" "got:      ${3:-<empty>}"
	fi
}

check_contains() { # label needle haystack
	if grep -qF -- "$2" <<<"$3"; then
		ok "$1"
	else
		bad "$1" "expected output containing: $2" "got: ${3:-<empty>}"
	fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

repo="$tmp/repo"
mkdir -p "$repo/scripts/ci" "$repo/bin" "$tmp/elsewhere"
repo="$(cd "$repo" && pwd -P)"
cp "$CI_DIR/deploy-site.sh" "$repo/scripts/ci/"
for tool in npm npx; do
	cat >"$repo/bin/$tool" <<STUB
#!/usr/bin/env bash
echo "$tool \$* [cwd=\$(pwd -P) token=\${CLOUDFLARE_API_TOKEN:-} account=\${CLOUDFLARE_ACCOUNT_ID:-} snapshot=\${TCAB_SNAPSHOT_URL:-}]" >>"\$STUB_LOG"
exit "\${STUB_EXIT_$tool:-0}"
STUB
	chmod +x "$repo/bin/$tool"
done

run() { # args...
	: >"$tmp/calls.log"
	(cd "$tmp/elsewhere" && STUB_LOG="$tmp/calls.log" PATH="$repo/bin:$PATH" \
		CLOUDFLARE_API_TOKEN="${TOKEN-token}" CLOUDFLARE_ACCOUNT_ID="${ACCOUNT-account}" \
		TCAB_SNAPSHOT_URL="${SNAPSHOT-https://snapshot.example}" \
		"$repo/scripts/ci/deploy-site.sh" "$@" 2>&1)
}

seen="token=token account=account snapshot=https://snapshot.example"

out="$(run master)"
check_equal "master deploys" "0" "$?"
check_equal "installs, builds the gallery by directory with the snapshot URL and deploys the production project, from the root" \
	"npm ci --no-audit --no-fund [cwd=$repo $seen]
npm run build -w apps/site [cwd=$repo $seen]
npx --yes wrangler@4.40.3 pages deploy apps/site/dist --project-name=the-test-cabinet --branch=master [cwd=$repo $seen]" \
	"$(cat "$tmp/calls.log")"

out="$(SNAPSHOT=https://snapshot.staging.example run staging)"
check_equal "staging deploys" "0" "$?"
check_contains "to the staging project, as its branch" \
	"--project-name=the-test-cabinet-staging --branch=staging" "$(cat "$tmp/calls.log")"
check_contains "built with the snapshot URL it was handed" \
	"npm run build -w apps/site [cwd=$repo token=token account=account snapshot=https://snapshot.staging.example]" \
	"$(cat "$tmp/calls.log")"

out="$(run nightly)"
check_equal "another branch is refused" "1" "$?"
check_contains "naming it" "'nightly' deploys no site (expected master or staging)" "$out"
check_equal "and runs nothing" "" "$(cat "$tmp/calls.log")"

out="$(TOKEN="" run master)"
check_equal "no API token is refused" "1" "$?"
check_contains "naming it" "CLOUDFLARE_API_TOKEN must be set" "$out"
check_equal "before anything runs" "" "$(cat "$tmp/calls.log")"

out="$(ACCOUNT="" run master)"
check_equal "no account id is refused" "1" "$?"
check_contains "naming it" "CLOUDFLARE_ACCOUNT_ID must be set" "$out"
check_equal "before anything runs" "" "$(cat "$tmp/calls.log")"

out="$(SNAPSHOT="" run master)"
check_equal "no snapshot URL is refused" "1" "$?"
check_contains "naming it" "TCAB_SNAPSHOT_URL must be set" "$out"
check_equal "before anything is built" "" "$(cat "$tmp/calls.log")"

# What an undefined pipeline variable reaches a step as: the macro, unexpanded.
# shellcheck disable=SC2016
out="$(SNAPSHOT='$(TCAB_SNAPSHOT_URL_MASTER)' run master)"
check_equal "an undefined pipeline variable is refused" "1" "$?"
check_contains "naming the value" "TCAB_SNAPSHOT_URL is not an http(s) URL: '\$(TCAB_SNAPSHOT_URL_MASTER)'" "$out"
check_equal "before anything is built" "" "$(cat "$tmp/calls.log")"

out="$(SNAPSHOT="snapshot.testcabinet.ai" run staging)"
check_equal "a URL without a scheme is refused" "1" "$?"
check_equal "before anything is built" "" "$(cat "$tmp/calls.log")"

out="$(STUB_EXIT_npm=1 run master)"
check_equal "a failed build fails the deploy" "1" "$?"
check_equal "and uploads nothing" "npm ci --no-audit --no-fund [cwd=$repo $seen]" \
	"$(cat "$tmp/calls.log")"

out="$(run)"
check_equal "no branch is a usage error" "1" "$?"
check_contains "which says how to call it" "usage: scripts/ci/deploy-site.sh <branch>" "$out"

out="$(run master staging)"
check_equal "two branches are a usage error" "1" "$?"

echo
echo "deploy-site.test.sh: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
