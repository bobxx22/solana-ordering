# Confirmatory run: the validators that departed from the rule

Committed and tagged `prereg-confirm` before the first trial of campaign `confirm`. Pushing the tag starts a GitHub
Actions run, whose creation time GitHub records on its own server. The run directories are named by their UTC start,
and the chain dates every trial.

## Why

The main run found two things only after looking at its data (REPORT section 6; `results.md`, "Deviations from the
reward/cost order, validator by validator"):

- **Three JitoLabs validators ordered by total fee.** 7cVfgArC, EvnRmnMr and C8Bey3LK: all 7 of their trials
  (2 + 4 + 1) landed in the exact total-fee order (B D, then A, E, F in any order, C last). The other 13 JitoLabs
  validators reached: 23 of 23 in the reward/cost order.
- **One Firedancer validator departed.** JD549Hsb: 4 of its 10 trials in the exact reward/cost order. The other 9
  Firedancer validators: 20 of 20.

A pattern found in the data cannot be tested on the same data. This run collects new trials to test both.

## What changed since the main run

Checked on 2026-10-28 around 17:20 UTC, with a dry run (not committed: dry runs are git-ignored) and
`getLeaderSchedule` / `getVoteAccounts` on `api.mainnet-beta.solana.com`.

- **7cVfgArC cannot be reached.**
  - It stopped voting at slot 462 239 999, the last slot of epoch 1069.
  - It has no leader slots in epochs 1070 and 1071, although its 1.19 million SOL stake is still delegated.
  - It is left out. H1 tests the other two JitoLabs validators.
- **The other three are unchanged.** Each reports the version and the QUIC address of the main run:
  - EvnRmnMr: JitoLabs 4.3.2, port 11228;
  - C8Bey3LK: JitoLabs 4.3.2, port 8022;
  - JD549Hsb: Firedancer 26.10.4, port 9007.

## Design

- **The same experiment, narrowed.** Code, roles, fees, delivery and path are those of the main run. Only the
  buffered/shared cell is used, where both deviations were seen, and the quotas are per validator.
- **The command:**
  ```
  node src/cli.ts run --live --campaign confirm --validators EvnRmnMr=15,C8Bey3LK=15,JD549Hsb=20 --cells buffered/shared --minutes 240
  ```
- **What counts.**
  - A trial counts towards its validator's quota under the main run's rule: B, C, D, F and A or E in the targeted
    window (`countsTowardsQuota`).
  - A validator stops being targeted after three times its quota of dispatches.
- **When to stop.** Every quota is reached, or it is 2026-11-03 23:59 UTC. The tests then run on the trials there
  are.
- **Cost.**
  - At most 0.000061 SOL per trial, so at most 0.0092 SOL even if every validator used up three times its quota
    of dispatches.
  - The 0.05 SOL cap in code still applies (0.025805 SOL committed before this run).

## Tests

`analyze` computes them in the section "Confirmatory run" of `results.md`. They are also written in the header of
`src/analyze.ts`.

| | validators | prediction | measure | test |
|---|---|---|---|---|
| H1 | JitoLabs EvnRmnMr, C8Bey3LK | they order by total fee | B before C, pooled over both validators | one-sided against chance by its exact null distribution, like the primary contrasts of the main run |
| H2 | Firedancer JD549Hsb | it departs from the exact reward/cost order | share of its trials with all six in the window that are in the exact reward/cost order (A/E either way) | exact lower binomial tail against 80% |

- **Why B before C for H1.** Reward/cost puts C first (k > 0.12); total fee puts B first. In the main run the two
  validators had B before C in 5 of 5 trials; the other JitoLabs validators had C before B.
- **Why 80% for H2.** The other nine Firedancer validators had 20 of 20 trials exact, and the lower end of that
  Wilson interval is 84%. A reference below it does not overstate how exact a typical validator is.
- **Verdicts.**
  - The two p values are Holm-adjusted together.
  - Fewer than 10 trials: **insufficient data**.
  - Otherwise, a Holm p below 0.05: **confirmed**; anything else: **not confirmed**.
- **Power.**
  - H1: if both validators keep B before C as in the main run, 10 trials already give p ≈ 0.001.
  - H2: with 20 trials, the test confirms at 11 exact trials or fewer. At the main run's rate (40% exact) that
    happens with probability 94%; at 50%, with probability 75%.
- **Descriptive, not tested.**
  - Per validator: versions, QUIC port, exact reward/cost and exact total-fee trials, other orders, B before C, and
    trials kept by the sensitivity filter of the main run.
  - Both tests again on the trials the sensitivity filter keeps.
  - Delivery.

## What each outcome means

- **H1 confirmed.** These validators put B before C: B has the higher total fee and the lower reward per unit of
  cost. The table per validator shows whether both do. A rule other than reward/cost runs on these validators or in
  front of them. Port 11228, behind which EvnRmnMr sits, is most likely a Jito relayer.
- **H1 not confirmed.** The main-run finding did not reproduce, and REPORT says so.
- **H2 confirmed.** JD549Hsb departs from the order its client's source predicts. This run does not tell why.
- **H2 not confirmed.** The 4 of 10 of the main run may have been noise or a passing state.

The confirmatory trials change none of the main run's tables or verdicts. They appear only in their own section of
`results.md`, in the run list and in `orders.md`.

## Checklist

1. Before:
   - `npm test` passes and `node src/cli.ts reproduce --offline` reports identical results;
   - `node src/cli.ts status` shows no open reservations;
   - this file and the code are committed, tagged `prereg-confirm` and pushed.
2. Start the command above. Within the first minute, check that `trials.jsonl` has `clockSource: "firstShred"`.
3. After every session, within 24 hours:
   - `node src/cli.ts collect all`;
   - `node src/cli.ts verify <run id> --write`;
   - commit the run directory, `ledger.jsonl` and the verify file.

   Then continue with the same command, if quotas remain.
4. After the last session:
   - `node src/cli.ts analyze`;
   - `node src/cli.ts sweep --live` (run by the wallet's owner), then `status`;
   - commit `results/`. REPORT quotes the section "Confirmatory run".
