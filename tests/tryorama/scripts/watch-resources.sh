#!/usr/bin/env bash
# CI's watch on the machine the suite runs on (Linux only). Every 10 seconds
# it writes memory, swap, disk, load and the largest processes to
# .logs/resources.log, beside the file then running. A runner that runs out of
# memory or disk loses touch with GitHub and leaves no log at all, so when
# either gets close, this stops the suite instead: the job then fails as any
# other does, and uploads its logs, this one included.
#
#   scripts/watch-resources.sh &   (from tests/tryorama, before `npm test`)
set -u
logs=.logs
mkdir -p "$logs"
out="$logs/resources.log"
# Memory counts what swap has left too: CI adds swap for the conductors.
low_memory_mb=1500
low_disk_mb=1500
# The tightest it got, said in the job's log when the suite ends.
tightest_mb=999999
tightest_during=none
trap 'echo "Runner memory at its tightest: ${tightest_mb}MB free, counting swap, during ${tightest_during}"; exit 0' TERM

while true; do
  available_mb=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
  swap_used_mb=$(awk '/^SwapTotal:/ { t = $2 } /^SwapFree:/ { f = $2 } END { print int((t - f) / 1024) }' /proc/meminfo)
  swap_free_mb=$(awk '/^SwapFree:/ { print int($2 / 1024) }' /proc/meminfo)
  disk_mb=$(df -Pm . | awk 'NR == 2 { print $4 }')
  tmp_mb=$(df -Pm "${TMPDIR:-/tmp}" | awk 'NR == 2 { print $4 }')
  current=$(ls -t "$logs" 2>/dev/null | grep -v '^resources.log$' | head -1)
  if [ $((available_mb + swap_free_mb)) -lt "$tightest_mb" ]; then
    tightest_mb=$((available_mb + swap_free_mb))
    tightest_during=${current:-none}
  fi
  {
    echo "$(date -u +%H:%M:%S) ${current:-none} memory_free=${available_mb}MB swap_used=${swap_used_mb}MB swap_free=${swap_free_mb}MB disk_free=${disk_mb}MB tmp_free=${tmp_mb}MB load=$(cut -d' ' -f1-3 /proc/loadavg)"
    ps -eo rss=,comm= --sort=-rss | head -5 | awk '{ printf "    %6d MB  %s\n", $1 / 1024, $2 }'
  } >> "$out"
  if [ $((available_mb + swap_free_mb)) -lt "$low_memory_mb" ] || [ "$disk_mb" -lt "$low_disk_mb" ] || [ "$tmp_mb" -lt "$low_disk_mb" ]; then
    {
      echo "LOW: stopping the suite while the runner can still report (memory_free=${available_mb}MB swap_free=${swap_free_mb}MB disk_free=${disk_mb}MB tmp_free=${tmp_mb}MB, during ${current:-none})"
      ps -eo pid,rss,etime,args --sort=-rss | head -25
      du -sh "${TMPDIR:-/tmp}"/* 2>/dev/null | sort -rh | head -10
    } >> "$out"
    echo "::error::The runner ran low on memory or disk during ${current:-none}: see resources.log in this job's tryorama logs"
    pkill -TERM -f "node run.ts"
    sleep 5
    pkill -KILL -f "(holochain|lair-keystore)"
    exit 1
  fi
  sleep 10 &
  wait $!
done
