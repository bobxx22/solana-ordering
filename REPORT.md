# Report: how Solana validators order transactions inside a block

Status: **draft before the main run**. The main run (campaign `main`) follows [`docs/RUNBOOK.md`](docs/RUNBOOK.md)
and the analysis plan pre-registered in README ("Noise versus rule"). The plan is frozen at the git tag `prereg-main`,
created before the first trial of campaign `main`; "Plan amendments" below lists what changed before that.

Every number below is copied from [`data/mainnet-beta/results/results.md`](data/mainnet-beta/results/results.md),
which `node src/cli.ts analyze` regenerates from the committed raw data, and the section it comes from is named.
Section names are quoted as they appear there. The chain check is
[`data/mainnet-beta/verify.json`](data/mainnet-beta/verify.json) (`node src/cli.ts verify --write`).

## Measurements

All times UTC. Every slot is after Alpenglow's activation (slot 459 653 000, 2026-10-21). Slots and epochs are from
"Runs"; spend is from `ledger.jsonl`.

| date and time | what | path | data | slots | spent, SOL |
|---|---|---|---|---|---:|
| 2026-10-24 16:59 | validator snapshot by client | – | `snapshots/` | epoch 1066 | 0 |
| 2026-10-24 19:07 | funding 10 sub-payers | RPC | `ledger.jsonl` | – | 0.000010 |
| 2026-10-24 19:08–19:12 | pilot: 15 trials × 5 transactions | public RPC | `runs/2026-10-24T19-08-02Z/` | 460 963 380 – 460 964 625 | 0.000780 |
| 2026-10-24 19:30–19:31 | path probe: 8 single transactions per endpoint, 3 endpoints | 3 RPCs | `paths/` | – | 0.000207 |
| 2026-10-24 23:25 | QUIC feasibility: 6 single transactions straight to leaders | direct QUIC | `quic-test/2026-10-24T23-25Z*.jsonl` | 461 036 036 – 461 036 146 | 0.000054 |
| 2026-10-24 23:35–23:37 | calibration 1: 8 trials × 6 (buffered sent one slot ahead, not two) | direct QUIC | `runs/2026-10-24T23-35-52Z/` | 461 039 133 – 461 039 486 | 0.000371 |
| 2026-10-25 15:38–15:41 | calibration 2: 13 trials × 6 | direct QUIC | `runs/2026-10-25T15-38-55Z/` | 461 311 213 – 461 311 909 | 0.000732 |
| 2026-10-25 22:02–22:07 | rehearsal of the final code: 16 + 1 trials, the second run continuing the first | direct QUIC | `runs/2026-10-25T22-02-17Z/`, `runs/2026-10-25T22-05-59Z/` | 461 419 536 – 461 420 912 | 0.000986 |
| | **total so far** | | | | **0.003140** |

The ledger and the wallet balances agree to the lamport. The twelve sub-payers hold 0.038624 SOL, the float for the
main run, which `sweep` returns to the main wallet (0.017128 SOL) at the end.

**Chain check** (`verify.json`, 2026-10-26 12:47 UTC, through `api.mainnet-beta.solana.com`, which keeps the whole
history), 0 problems:
- 279 landed transactions in 70 blocks, each at its recorded index;
- the leader confirmed by the schedule in all 70 blocks;
- 60 whole transactions checked for payer, fee, anchor and role parameters;
- 1 213 rows of 3 whole blocks rebuilt from the chain;
- all 24 unlanded transactions absent from the chain;
- all 30 probe transactions (`paths/`, `quic-test/`) as recorded.

## What we see so far (calibration and rehearsal; no test)

1. **The delivery path decides everything.** From "Rule agreement: pilot through the public RPC", row "all pilot
   trials":
   - the block order followed the order in which the public RPC released our transactions: gamma 0.87 [0.71, 0.97],
     Holm p = 0.005;
   - reward/cost: 0.23, p = 1.000;
   - total fee: −0.24 [−0.38, −0.11], p = 0.236.

   From the "Pilot path" line under that table:
   - the RPC answered `sendTransaction` after a median 1 302 ms (176–3 340);
   - that response time correlates with the landing delay at r = 0.91 (75 transactions);
   - only 19 of 75 transactions (25%) landed in the targeted window.

   Straight to the leader over QUIC, every landed transaction landed in the targeted window ("Delivery", spill-over
   0).
2. **Buffered bursts.** From "Calibration and rehearsal runs", row "rehearsal: buffered/shared" (7 trials):
   - A,E before C 100%, A,E before F 100%, D before C 100%, C before B 86%;
   - the twins in send order 14%.

   This is the pattern the deployed source predicts (`docs/schedulers.md`): ranking by reward per requested cost, no
   arrival-order tie-break. "Delivery": the leader acknowledged all 60 rehearsal buffered transactions; the arrival
   margin before the window was a median 381 ms, minimum 134 ms, on our (lagging) clock.
3. **Streamed 30 ms apart.** Arrival order dominates. Row "rehearsal: streamed/shared": A,E before F 25%, twins in
   send order 100%. Row "calibration: streamed/shared": A,E before F 0%.
4. **Where we stand.** From "Where our transactions stand in their blocks":
   - A and E out-rank 98% of the other transactions in their blocks by reward/cost; B and F, the lowest, 74% and 75%;
   - buffered transactions sit at 2–8% of the block;
   - blocks hold 152–1 083 transactions (median 460).
5. **Not every address takes direct, unstaked traffic.** "Delivery", row "calibration / tpu / buffered": 42 of 48
   transactions acknowledged. The six missing ones are one JitoLabs burst whose address (port 11228) never
   acknowledged. One rehearsal JitoLabs burst was acknowledged and still not included.

## What went wrong

| what | how we found it | what we changed |
|---|---|---|
| The public RPC held bursts ~1.3 s and released them in its own order, so the pilot measured the RPC, not the leader. | Round-1 reviews of the pilot. | Direct QUIC delivery to the leader's advertised TPU address (`py/tpu_sender.py`). The pilot is kept as the comparison it became. |
| 7 of 22 pilot dispatch attempts were skipped as "missed slot": a `>=` instead of `>`, and signing too late. | Pilot log and ledger. | Fixed; skips are logged in `events.jsonl`. |
| The pilot run crashed waiting 160 s for a rare client's window (fixed 120 s timeout), so the automatic collection did not run. | Pilot log. | Timeout proportional to the distance; collection runs after any error. |
| The block's fee-reward recipient is not always the leader: some validators collect block revenue in a separate account. | QUIC feasibility test. | The leader is the slot's scheduled leader (`getSlotLeaders`); the fee recipient is stored separately. |
| BAM and Harmonic validators advertise shared gateways, so "direct to the leader" is direct to a gateway for them. | Round-2 reviews; confirmed from the snapshot. | Ingress host recorded per trial; BAM and Harmonic get their own family of tests, read as pipelines, with a check grouped by host. |
| reward/cost and price per CU disagreed on one pair only. | Round-1 reviews. | Role F (A with a 64 MiB loaded-data limit). |
| The rebuilt cost of other transactions ignored the requested loaded-data limit. | Round-2 reviews. | Cost rebuilt from first principles; a test checks it equals the design cost for all six roles. |
| Spend-cap gaps (reservations released on a send error or after 20 s; sweep could be refused; two processes could spend). | Round-1 reviews (no overspend happened). | Reservations close only on landing or proven expiry; sweep allowance; exclusive, host-aware ledger lock; genesis-hash check. |
| One payer set would never have been topped up during a long run. | Round-2 review (not triggered yet). | Payers pre-funded for the whole run and checked before each use. |
| `verify` defaulted to an endpoint that keeps ~40 h of blocks. | Round-3 review. | Full-history endpoint first; unavailable blocks reported, not failed; leader falls back to the fee recipient. |
| Reviewers asserted FIFO tie-breaking from Agave `master`. The deployed v4.3.2 breaks ties by a container id; only the 4.4/4.5 pre-releases (about a fifth of the Agave label's slots) break them by arrival. | Reading the tagged sources (round 4 found the pre-releases). | Twins reported by version family; `docs/schedulers.md` corrected. |
| The live loop stopped on any transient error, could not be continued, and exclusion memory was per campaign, so one unlucky start could exclude a 100-validator gateway. | Round-3 and round-4 reviews. | Per-iteration recovery; campaigns that continue a stopped run; address history from every live run. |
| REPORT quoted pilot numbers that `analyze` did not produce. | Round-4 review. | `analyze` emits them; this report copies `results.md` only. |
| Free Helius plan: 1 sendTransaction/s, no staked connections; free dRPC does not serve mainnet. | Provider documentation; probe. | Helius is used for reads only. |
| Docker Desktop cannot run on the author's Windows build. | Installer error. | The image is built in GitHub Actions on every push, and the tests and the offline `reproduce` run in it. The full online `reproduce` runs in a separate job that does not fail the build, because public endpoints rate-limit shared runners; it last passed in [this run](https://github.com/bobxx22/solana-ordering/actions/runs/40304512073). |
| The recorded rows of other transactions in 18 blocks of the pilot and calibration runs had a stale scheduled cost: 2 280 CU per Ed25519 precompile signature instead of the deployed 2 400. The code had been corrected, but those blocks were collected before the fix. | The new comparison of whole blocks with the chain (the round-5 review asked for it). | The three runs recollected (`collect --refresh`): 24 rows changed, only in that field; no table that REPORT quotes changed. |
| `verify` reported unlanded transactions as checked when no endpoint answered. It took an empty answer from the first endpoint as final, and would have accepted "unknown" from an endpoint whose history does not reach the send slot. | Round-5 review; one block came back empty from the public endpoint while re-checking. | Unlanded transactions are asked only of endpoints whose history reaches their send slot, and count as checked only when one answered. An empty answer passes the request on to the next endpoint. |
| `results.md` gave the pilot 75 transactions "in the targeted window" in one table and 19 in the next line. | Round-5 review. | The window is now the targeted leader's window for every path; the pilot rows show 19 and a spill-over of 56. |
| Four statements in README and REPORT did not match the code: a spend "at most 0.022 SOL" (the bound is the 0.05 SOL cap), "no wallet key is read" (true of `run`, not of `fund`, `sweep` or `status`), the online `reproduce` in CI (it does not block the build), and "statistics resample hosts". | Round-5 review. | Corrected. |

## Plan amendments before the main run

The analysis plan was first committed at `d86fc31`. An independent full review (round 5) found that parts of it would
have misread the data. It was amended before any trial of campaign `main`, and the amended plan is the one tagged
`prereg-main`:

- **Verdicts.** "Contradicted" (interval below 0.75) would have read chance-level order (share near 0.5) as an
  alternative rule, for example "the base fee does not count". It is split:
  - "reversed" (interval below 0.5) is the only verdict read as an alternative rule;
  - "no stable order" (below 0.75) names none.
- **Minimum.** Fewer than 10 trials is "insufficient data", not "no fee ordering detected".
- **Quota.** A trial counted when any two of its transactions landed, so 30 primary trials could leave a contrast with
  about 24 pairs (power 0.62 instead of 0.76 at an 80% share). It now counts only with B, C, D, F and A or E in the
  targeted window. In the rehearsal 9 of 10 buffered trials met this ("Delivery", complete trials).
- **Pipelines.** The four BAM and Harmonic labels hold about two thirds of mainnet's leader slots ("Coverage per
  label"). They get their own family of twelve tests, read as statements about the pipeline.
- **Validators.** Agave and Rakurai each rest on about four effective validators ("Coverage per label"). Added:
  - a group-level sign-flip check per label;
  - each label's coverage (validators, slot share, effective number, reachable share, validators reached);
  - conclusions stated for the validators reached.
- **Sensitivity.** Trials with an unknown arrival margin are left out, not kept.
- **Twins.** Only versions whose source was read enter a version family. Agave 4.4.0-beta.1 and Firedancer 26.10.3
  were read and joined their families; Firedancer "0.1.1" was not identified.

## Main run (to come)

Campaign `main`, run by [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
- **Quotas:** 60 trials per local-scheduler label (Agave, JitoLabs, Firedancer, Rakurai) and 30 per pipeline label.
  A trial counts only with B, C, D, F and A or E landed in the targeted window.
- **Cells per 10 trials:** 5 buffered/shared, 2 buffered/independent, 1 burst/shared, 2 streamed.
- **Budget.**
  - Expected about 0.025 SOL: a trial costs at most 61 000 lamports, and some trials land only in part.
  - The bound is the 0.05 SOL cap in code, of which 0.003140 SOL is spent.
- **Verification** after every session, while that epoch's leader schedule is still served (`verify/<run>.json`).

The results section will be:
1. Runs and dates; versions and coverage per label.
2. Delivery and attrition per label.
3. Control per label.
4. The twelve primary tests with verdicts and their reading; the twelve pipeline tests.
5. Exact orders.
6. Secondary cells and twins by version family.
7. Robustness: leave one validator out, the group-level check, per-validator shares, the sensitivity run.
8. Context in the block.
9. What the results do not show.
10. What went wrong in the main run.
