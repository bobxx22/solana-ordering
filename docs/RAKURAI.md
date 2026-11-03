# Targeted run: JitoLabs validators with and without a Rakurai activation account

Committed and tagged `prereg-rakurai` before the first trial of campaigns `rakurai` and `rakurai-swap`. Pushing the tag
starts a GitHub Actions run, whose creation time GitHub records on its own server. The run directories are named by
their UTC start, and the chain dates every trial.

## Why

Data read after both earlier runs left a lead and two open points (REPORT, section 6):

- **The lead.** Among the 16 JitoLabs validators reached, two of the three that ordered by total fee hold an enabled
  account of Rakurai's activation program, and none of the 13 that followed reward/cost does: 2 of 3 against 0 of 13,
  Fisher's exact test p = 0.025, chosen after seeing the data. A pattern found in the data cannot be tested on the same
  data. 14 more JitoLabs validators hold such accounts, and we have not aimed at any of them.
- **What the order separates.** B D, then A, E, F, C fits total fee, and fits "the larger requested compute-unit limit
  first" (`docs/schedulers.md`, "What the contrasts identify").
- **Whether the method sees a change of code.** Jito-Solana v4.4.0-jito keeps the priority formula of Agave v4.3.2
  ([`core/src/transaction_priority.rs`](https://github.com/jito-foundation/jito-solana/blob/v4.4.0-jito/core/src/transaction_priority.rs),
  byte-identical) but breaks ties oldest first
  ([`transaction_priority_id.rs`](https://github.com/jito-foundation/jito-solana/blob/v4.4.0-jito/core/src/banking_stage/transaction_scheduler/transaction_priority_id.rs)).
  At Agave and Jito 4.3.2 the twin sent first landed first in 42% [29–55%] of trials. Most JitoLabs validators now report
  4.4.0.

## Who

Chosen from committed data before any trial: the snapshot `snapshots/2026-11-03T22-01-35Z-epoch1076.json` and
`rakurai-activation.json`. `selectPanel` in `src/targeted.ts` applies the rule, and `test/targeted.test.ts` checks that it
gives the lists below.

- **Holders.** Report JitoLabs, are not delinquent, hold an enabled activation account, have at least 0.1% of all leader
  slots of the epoch, and were not aimed at in the buffered/shared cell of campaigns `main` and `confirm`.
- **Matched.** For each holder, by descending leader slots: the unused validator that reports JitoLabs 4.4.0, is not
  delinquent, holds no enabled account, and is on the same side of port 11228, closest in leader slots. Whether it was
  aimed at before plays no part.

| holder | reports | QUIC port | share of leader slots | matched | reports | QUIC port | share of leader slots |
|---|---|---|---:|---|---|---|---:|
| `A9mvukTd` | 4.4.0 | 8022 | 0.302% | `bitHUmbK` | 4.4.0 | 9002 | 0.308% |
| `8tjFeSAp` | 4.4.0 | 11228 | 0.230% | `vu1sGn2f` | 4.4.0 | 11228 | 0.200% |
| `Ha1iade1` | 4.4.0-rc.1 | 8002 | 0.199% | `HM19KBHD` | 4.4.0 | 8002 | 0.182% |
| `siidBVew` | 4.4.0 | 11228 | 0.156% | `8o8wWCYN` | 4.4.0 | 11228 | 0.179% |
| `2Df1aLCR` | 4.4.0 | 11228 | 0.128% | `32ke3uf1` | 4.4.0 | 11228 | 0.103% |
| `fishfish` | 4.4.0-rc.1 | 8002 | 0.123% | `Cogent51` | 4.4.0 | 8002 | 0.122% |

Three more, described and not tested in campaign `rakurai`:

- `C8Bey3LK`, which ordered by total fee in both earlier runs and now reports JitoLabs 4.4.0: the same day as the others,
  which the confirmatory run lacked.
- `HEL1USMZ`, the largest JitoLabs validator, which ordered by reward/cost in the main run and holds no account.
- `EvnRmnMr`, which ordered by total fee while it reported JitoLabs and now reports HarmonicFiredancer 26.10.5.

## Design

- **The same experiment, narrowed.** Code, delivery and path are those of the earlier runs, in the one cell
  buffered/shared.
- **Campaign `rakurai`.** The six roles of the main run. Quota per validator: 8 for holders and matched, 10 for the other
  three.
- **Campaign `rakurai-swap`.** `C8Bey3LK` only, quota 12, with the parameters of B and D swapped round (`SWAPPED_ROLES` in
  `src/design.ts`): B pays 10 000 lamports for 1 000 CU, D 9 000 for 40 000. The other four roles are unchanged, and so is
  the cost of a trial. The rules now predict (`test/targeted.test.ts`):

  | rule | predicted order |
  |---|---|
  | total fee | B D, then A, E, F in any order, C |
  | the larger limit first, the larger fee between equal limits | D B, then A, E, F in any order, C |
  | reward/cost | B, then A and E either way, C, F, D |

- **The commands**, one after the other. They were first tried as dry runs on 2026-11-03 at 22:36–22:38 UTC (not committed:
  dry runs are git-ignored):
  ```
  node src/cli.ts run --live --campaign rakurai-swap --validators C8Bey3LK=12 --cells buffered/shared --roles swap --sub-target 0.002 --minutes 30
  node src/cli.ts run --live --campaign rakurai --validators A9mvukTd=8,8tjFeSAp=8,Ha1iade1=8,siidBVew=8,2Df1aLCR=8,fishfish=8,bitHUmbK=8,vu1sGn2f=8,HM19KBHD=8,8o8wWCYN=8,32ke3uf1=8,Cogent51=8,C8Bey3LK=10,HEL1USMZ=10,EvnRmnMr=10 --cells buffered/shared --sub-target 0.002 --minutes 240
  ```
- **What counts.**
  - A trial counts towards its validator's quota under the main run's rule: B, C, D, F and A or E in the targeted
    window (`countsTowardsQuota`).
  - A validator stops being targeted after three times its quota of dispatches. An address that never landed anything is
    no longer targeted after two failures in a row. No validator is replaced.
- **When to stop.** Every quota is reached, or it is 2026-11-05 12:00 UTC. The tests then run on the trials there are.
- **Cost.**
  - At most 0.000061 SOL per trial. With 138 trials that count and some that do not, about 0.009 SOL.
  - The 0.05 SOL cap in code still applies, with 0.029072 SOL committed before this run. It would stop the run first.

## Tests

`analyze` computes them in the section "Targeted run" of `results.md` (`src/targeted.ts`). They are also written in the
header of `src/analyze.ts`.

| | validators | prediction | measure | test |
|---|---|---|---|---|
| H1 | the holders against the matched, campaign `rakurai` | holders put B before C more than matched validators | per validator, the share of its trials with B before C, of those with both in the window | exact one-sided permutation test of the difference of group means, over validators |
| H2 | `C8Bey3LK`, campaign `rakurai-swap` | total fee, and not the larger limit, puts B first | B before D, of the trials with both in the window | one-sided exact binomial against chance |
| H3 | the matched, campaign `rakurai` | Jito 4.4.0 breaks ties oldest first | of the trials with A and E in the window, the twin sent first landed first | one-sided exact binomial against chance |

- **Why validators are the unit of H1.** The claim is about validators, and trials of one validator are not independent.
  Only validators with at least 5 trials with B and C in the window enter.
- **Why matched validators.** Holding an account could go with size or with a relayer in front of the validator. The
  match holds those two about equal. It is not used as pairs, so that a pair does not fall out with one of its members.
- **Verdicts.**
  - The three p values are Holm-adjusted together.
  - H1 with fewer than 3 validators in either group, H2 or H3 with fewer than 10 trials: **insufficient data**.
  - Otherwise, a Holm p below 0.05: **confirmed**; anything else: **not confirmed**.
- **Power.** These are exact computations.
  - H1, with six validators in each group, if k holders put B before C in all their trials and no matched validator does:
    p = 1/924 at k = 6, 7/924 at k = 5, 28/924 = 0.030 at k = 4, 84/924 = 0.091 at k = 3. So three holders of six do not
    confirm it, whatever they do, and the table per validator says what they did.
  - H2, with 12 trials: 11 or more confirm at any Holm step (p < 0.0167). If the true share is 90%, that happens with
    probability 0.66; 12 of 12, as `C8Bey3LK` nearly always ordered, gives p = 1/4096.
  - H3, with 48 trials: 32 or more confirm at any Holm step. That happens with probability 0.99 if the true share is 80%,
    0.87 at 73%, and 0.47 at 65%.
- **Descriptive, not tested.**
  - Per validator: reported client and version, QUIC port, dispatched, with all six, exact reward/cost and total-fee
    trials, F last, other orders, B before C, trials kept by the sensitivity filter of the main run, and the reading of
    "Validator by validator".
  - The swapped parameters: exact orders of `C8Bey3LK`.
  - Delivery.

## What each outcome means

- **H1 confirmed.** On validators chosen by the account alone, holders put B before C more than matched validators
  without one, the same day. The account goes with the order. What runs on them stays unseen: the account says what was
  approved, and the published Rakurai client reports `Rakurai`.
- **H1 not confirmed.** The lead does not hold on new validators, and REPORT says so. The table per validator shows which
  holders did what.
- **H2 confirmed.** At `C8Bey3LK` the fee decides, not the requested compute-unit limit. D before B would mean the larger
  limit first.
- **H2 not confirmed.** The two rules stay unseparated, or `C8Bey3LK` no longer orders that way: its exact orders say which.
- **H3 confirmed.** The method sees a change of code that was predicted from the source before the run.
- **H3 not confirmed.** Ties at Jito 4.4.0 do not follow our send order closely enough to show. The twins measure ingress
  plus tie-breaking, so this would not refute the source.

The targeted trials change none of the earlier tables or verdicts. They appear only in their own section of `results.md`,
in the run list, in "Reported client over time" and in `orders.md`.

## Checklist

1. Before:
   - `npm test` passes and `node src/cli.ts reproduce --offline` reports identical results;
   - `node src/cli.ts status` shows no open reservations;
   - this file and the code are committed, tagged `prereg-rakurai` and pushed.
2. The wallet's owner starts the two commands above. Within the first minute, check that `trials.jsonl` has
   `clockSource: "firstShred"`.
3. After every session, within 24 hours:
   - `node src/cli.ts collect all`;
   - `node src/cli.ts verify <run id> --write`;
   - commit the run directory, `ledger.jsonl` and the verify file.

   Then continue with the same command, if quotas remain.
4. After the last session:
   - `node src/cli.ts verify <run id> --sample all --out data/mainnet-beta/verify-every-transaction-<campaign>.json`;
   - `node src/cli.ts analyze`;
   - `node src/cli.ts sweep --live` (run by the wallet's owner), then `status`;
   - commit `results/`. REPORT quotes the section "Targeted run".
