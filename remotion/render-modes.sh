#!/usr/bin/env bash
# Render the three README delivery-mode animations to ../assets/*.gif.
# Needs gifski (brew install gifski); remotion brings its own renderer.
set -euo pipefail
cd "$(dirname "$0")"
for pair in Multicast:multicast Unicast:unicast Anycast:anycast; do
  comp="Mode${pair%%:*}"
  name="${pair##*:}"
  npx remotion render "$comp" --sequence --image-format=png --concurrency=8 "out/seq-$name"
  gifski --fps 30 --quality 90 -o "../assets/$name.gif" "out/seq-$name"/*.png
done
