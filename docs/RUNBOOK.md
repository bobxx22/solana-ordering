# Main run: operator checklist

Committed before the first trial of campaign `main` (git tag `prereg-main`), and followed as written, except for the
timing of one commit in step 7 (REPORT, "What went wrong"). Every step's output is committed with the data.

## Before

1. The analysis plan (README "Noise versus rule", header of `src/analyze.ts`, `countsTowardsQuota` in
   `src/design.ts`) and this checklist are committed and tagged `prereg-main`; REPORT names the tag and its commit.
2. `npm test` passes; `node src/cli.ts reproduce --offline` reports identical results.
3. `node src/cli.ts status`: no open reservations, and at least 0.03 SOL of the 0.05 SOL cap left (the main run is
   expected to cost about 0.025 SOL; the cap stops it in any case).
4. `.env` points reads at a keyed endpoint that serves `slotsUpdatesSubscribe` (Helius).

## Run

A session is one start of step 5. The run can take several sessions over several days.

5. `node src/cli.ts run --live --campaign main --minutes 240`.
6. Within the first minute, check that the first lines of the run's `trials.jsonl` have `clockSource: "firstShred"`;
   if not, stop and fix the read endpoint before going on.
7. After every session, however it ended (time limit, error, closed window), and within 24 hours of its last trial,
   while public endpoints still serve that epoch's leader schedule:
   - `node src/cli.ts collect all`;
   - `node src/cli.ts verify <run id> --write`, which writes `data/mainnet-beta/verify/<run id>.json`;
   - commit the run directory, `ledger.jsonl` and that file.

   Then start step 5 again with the same `--campaign main`. It continues the quotas, cells, per-validator counts and
   exclusions.
8. A label that cannot reach its quota by 2026-11-04 23:59 UTC is left with the trials it has (pre-registered
   shortfall rule).

## After

9. `node src/cli.ts collect all`, until `status` shows no open reservations.
10. `node src/cli.ts verify --write`: the check of all runs, `data/mainnet-beta/verify.json`. Leaders of epochs no
    longer served are checked against the fee recipient there; the per-session files of step 7 hold their schedule
    check.
11. `node src/cli.ts analyze`; REPORT quotes `results.md` and nothing else.
12. `node src/cli.ts sweep --live`, then `status`: the sub-payers are empty, and the ledger matches the main wallet's
    balance.
13. Commit the run directories, `ledger.jsonl`, `verify.json`, `verify/` and `results/`.
