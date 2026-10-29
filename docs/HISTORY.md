# Fixed before the main run

What the pilot, the calibration runs and five rounds of independent review found before the main run, and what was
changed. REPORT ("What went wrong", "Before the main run") keeps the six items that change how the data read; these
are the others, moved here from REPORT after the confirmatory run.

| what | how we found it | what we changed |
|---|---|---|
| 7 of 22 pilot dispatch attempts were skipped as "missed slot": a `>=` instead of `>`, and signing too late. | Pilot log and ledger. | Fixed; skips are logged in `events.jsonl`. |
| The pilot run crashed waiting 160 s for a rare client's window (fixed 120 s timeout), so the automatic collection did not run. | Pilot log. | Timeout proportional to the distance; collection runs after any error. |
| reward/cost and price per CU disagreed on one pair only. | Round-1 reviews. | Role F (A with a 64 MiB loaded-data limit). |
| The rebuilt cost of other transactions ignored the requested loaded-data limit. | Round-2 reviews. | Cost rebuilt from first principles; a test checks it equals the design cost for all six roles. |
| Spend-cap gaps (reservations released on a send error or after 20 s; sweep could be refused; two processes could spend). | Round-1 reviews (no overspend happened). | Reservations close only on landing or proven expiry; sweep allowance; exclusive, host-aware ledger lock; genesis-hash check. |
| One payer set would never have been topped up during a long run. | Round-2 review (not triggered yet). | Payers pre-funded for the whole run and checked before each use. |
| `verify` defaulted to an endpoint that keeps ~40 h of blocks. | Round-3 review. | Full-history endpoint first; unavailable blocks reported, not failed; leader falls back to the fee recipient. |
| The live loop stopped on any transient error, could not be continued, and exclusion memory was per campaign, so one unlucky start could exclude a 100-validator gateway. | Round-3 and round-4 reviews. | Per-iteration recovery; campaigns that continue a stopped run; address history from every live run. |
| REPORT quoted pilot numbers that `analyze` did not produce. | Round-4 review. | `analyze` emits them; REPORT copies `results.md` only. |
| Free Helius plan: 1 sendTransaction/s, no staked connections; free dRPC does not serve mainnet. | Provider documentation; probe. | Helius is used for reads only. |
| `verify` reported unlanded transactions as checked when no endpoint answered. It took an empty answer from the first endpoint as final, and would have accepted "unknown" from an endpoint whose history does not reach the send slot. | Round-5 review; one block came back empty from the public endpoint while re-checking. | Unlanded transactions are asked only of endpoints whose history reaches their send slot, and count as checked only when one answered. An empty answer passes the request on to the next endpoint. |
| `results.md` gave the pilot 75 transactions "in the targeted window" in one table and 19 in the next line. | Round-5 review. | The window is now the targeted leader's window for every path; the pilot rows show 19 and a spill-over of 56. |
| Four statements in README and REPORT did not match the code: a spend "at most 0.022 SOL" (the bound is the 0.05 SOL cap), "no wallet key is read" (true of `run`, not of `fund`, `sweep` or `status`), the online `reproduce` in CI (it does not block the build), and "statistics resample hosts". | Round-5 review. | Corrected. |
