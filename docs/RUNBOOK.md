# Main run: operator checklist

Committed before the first trial of campaign `main`, and followed as written. Every step's output is committed with
the data.

## Before

1. The analysis plan (README "Noise versus rule", header of `src/analyze.ts`) and this checklist are committed; note the
   commit id in REPORT.
2. `npm test` passes; `node src/cli.ts reproduce --offline` reports identical results.
3. `node src/cli.ts status`: no open reservations; committed spend plus the main run's ceiling (360 × 61 000 lamports
   = 0.02196 SOL) stays under the 0.05 SOL cap.
4. `.env` points reads at a keyed endpoint that serves `slotsUpdatesSubscribe` (Helius).

## Run

5. `node src/cli.ts run --live --campaign main --minutes 240`.
6. Within the first minute, check that the first lines of the run's `trials.jsonl` have `clockSource: "firstShred"`;
   if not, stop and fix the read endpoint before going on.
7. If the run stops for any reason (time limit, error, closed window): run `node src/cli.ts collect all`, then start
   step 5 again with the same `--campaign main`. It continues the quotas, cells, per-validator counts and exclusions.
8. A label that cannot reach its quota by 2026-11-04 23:59 UTC is left with the trials it has (pre-registered
   shortfall rule).

## After

9. `node src/cli.ts collect all`, until `status` shows no open reservations.
10. `node src/cli.ts verify --write` within 24 hours of the last trial, while the leader schedule of those epochs is
    still served; commit `data/mainnet-beta/verify.json`.
11. `node src/cli.ts analyze`; REPORT quotes `results.md` and nothing else.
12. `node src/cli.ts sweep --live`, then `status`: the sub-payers are empty, and the ledger matches the main wallet's
    balance.
13. Commit the run directories, `ledger.jsonl`, `verify.json` and `results/`.
