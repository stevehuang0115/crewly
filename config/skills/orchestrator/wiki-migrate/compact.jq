# wiki-migrate compact report filter.
#
# The backend's scan/apply payload carries the full `proposedPages` array —
# hundreds of rows on a real project — and the orchestrator only needs the
# shape of the migration to decide whether to apply it. This filter drops the
# array and replaces it with counts (by sourceType), the already-migrated /
# net-new split, and a short sample of net-new target paths.
#
# Every other top-level key (ok, vaultPath, legacyDetected, bootstrapNeeded,
# summary, applied, skipped, bootstrapped, manifestPath, ...) passes through.
#
# Args: $sample (number) — how many net-new relPaths to include.
def is_new: (.skipReason // "") == "";

. as $r
| ($r.proposedPages // []) as $pages
| ($pages | map(select(is_new))) as $new
| ($r | del(.proposedPages))
+ {
    totalProposed: ($pages | length),
    alreadyMigrated: ($pages | map(select(.skipReason == "already migrated")) | length),
    skippedOther: ($pages | map(select((.skipReason // "") != "" and .skipReason != "already migrated")) | length),
    netNew: ($new | length),
    routingUncertain: ($pages | map(select(.routingUncertain == true)) | length),
    byCategory: (
      $pages
      | group_by(.sourceType)
      | map({
          key: (.[0].sourceType // "unknown"),
          value: { proposed: length, netNew: (map(select(is_new)) | length) }
        })
      | from_entries
    ),
    netNewSample: ($new | .[:$sample] | map(.targetRelativePath)),
    hint: "compact view — pass --full for the complete proposedPages array"
  }
