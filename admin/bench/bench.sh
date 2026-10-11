#!/usr/bin/env bash
# Benchmark a Docusaurus site build, baseline (Node in Docker) vs candidate (this repo on Bun).
#
# Usage:
#   admin/bench/bench.sh baseline <site-copy-dir> [runs] [cold|warm]
#   admin/bench/bench.sh candidate <site-copy-dir> [runs] [cold|warm]
#
# Always point it at a throwaway copy of the site: it deletes build/, .docusaurus/
# and (in cold mode) node_modules/.cache.
set -euo pipefail

mode=${1:?baseline|candidate}
site=$(realpath "${2:?site dir}")
runs=${3:-3}
cache=${4:-cold}
image=${BENCH_NODE_IMAGE:-node:24}

run_once() {
  rm -rf "$site/build" "$site/.docusaurus"
  if [[ $cache == cold ]]; then rm -rf "$site/node_modules/.cache"; fi
  local log
  log=$(mktemp)
  local start end
  start=$(date +%s%N)
  if [[ $mode == baseline ]]; then
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e DOCUSAURUS_PERF_LOGGER=true \
      -v "$site:/site:z" -w /site "$image" npx docusaurus build >"$log" 2>&1
  else
    (cd "$site" && DOCUSAURUS_PERF_LOGGER=true bun run docusaurus build) >"$log" 2>&1
  fi
  end=$(date +%s%N)
  # Top-level phases only: "Build > <locale> > <phase> - <time>"
  grep -E '^\[PERF\] Build > [a-z-]+ > [^>]+ - ' "$log" | sed -E 's/ - \(Heap.*//' >&2 || true
  echo $(((end - start) / 1000000))
  rm -f "$log"
}

times=()
for i in $(seq "$runs"); do
  t=$(run_once)
  echo "run $i ($mode, $cache): ${t}ms" >&2
  times+=("$t")
done
printf '%s\n' "${times[@]}" | sort -n | awk '{a[NR]=$1} END {print "median_ms=" a[int((NR+1)/2)]}'
