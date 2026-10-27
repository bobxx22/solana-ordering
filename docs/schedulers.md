# How the schedulers we measure rank transactions (source reference)

Every statement below is read from the source of the versions mainnet runs. Each one links to the tagged line.

## Versions

The version strings come from gossip (snapshot of epoch 1068, by share of each label's leader slots; the `Versions`
table of `results.md` is generated from the main run's own snapshots).

| label | versions | source read |
|---|---|---|
| Agave | 4.3.2 80%, 4.4.0-rc.0 9%, 4.5.0-alpha.2 8%, 4.4.0-beta.1 2% | `anza-xyz/agave` tags v4.3.2, v4.4.0-beta.1, v4.4.0-rc.0, v4.5.0-alpha.2 |
| JitoLabs | 4.3.2 99.9%; 4.3.0 and 4.3.0-rc.1 under 0.1% | `jito-foundation/jito-solana` tag v4.3.2-jito |
| AgaveBam, HarmonicAgave, Rakurai | report 4.3.2 | Agave v4.3.2 for the base scheduler; the BAM sequencer, Harmonic block building and Rakurai's scheduler are not in these repositories |
| Firedancer | 26.10.4 92%, 26.10.3 6%, "0.1.1" 1% | `firedancer-io/firedancer` tags v26.10.4, v26.10.3 (pack's cost header and comparison identical to v26.10.4) |
| FireBAM, HarmonicFiredancer | report 26.10.4 | Firedancer v26.10.4 for pack |

Sources were read on 2026-10-26, through the Helius `svm` skill (`readSolanaSourceFile`) and raw GitHub files.
Statements about `master` are marked as such: earlier claims (ours and reviewers') that came from `master` do not all
hold for the deployed versions. "0.1.1" is reported by two small Firedancer-label validators; we did not identify that
build. It is kept in the label, but the twins table, which depends on the version, puts it, like any version whose
source was not read, under "other versions".

## What both clients sort by

**Agave v4.3.2**
- Priority is computed once, when a transaction enters the scheduler's buffer:
  `priority = reward × 1 000 000 / (cost + 1)`
  ([core/src/transaction_priority.rs:32-63](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/transaction_priority.rs#L32-L63)).
- **Cost** is `calculate_cost_for_executed_transaction` called with the *requested* compute-unit limit and the
  *requested* loaded-accounts-data limit (L37-42).
  - It adds 720 CU per signature (precompile signatures: Ed25519 2 400, secp256k1 6 690, secp256r1 4 800), 300 per
    write lock, instruction data bytes / 4, the CU limit, and 8 per started 32 KiB of the loaded-data limit
    ([cost-model/src/cost_model.rs:130-199](https://github.com/anza-xyz/agave/blob/v4.3.2/cost-model/src/cost_model.rs#L130-L199)).
  - With no limit set, the loaded-data limit is 64 MiB, which costs 16 384 CU.
- **Reward** is `get_deposit()`: the whole priority fee plus the base fee minus a 50% burn (L52, and
  [runtime/src/bank/fee_distribution.rs:97-106](https://github.com/anza-xyz/agave/blob/v4.3.2/runtime/src/bank/fee_distribution.rs#L97-L106)).
- `core/src/transaction_priority.rs` is byte-identical in **v4.4.0-beta.1, v4.4.0-rc.0 and v4.5.0-alpha.2**, and in
  **Jito-Solana v4.3.2-jito**.

**Firedancer v26.10.4**
- Pack keeps pending transactions in a treap ordered by `rewards / compute_est`
  ([src/disco/pack/fd_pack.c:227-249](https://github.com/firedancer-io/firedancer/blob/v26.10.4/src/disco/pack/fd_pack.c#L227-L249)).
- `compute_est` has the same terms and constants as Agave's cost, including the requested loaded-data limit
  ([src/disco/pack/fd_pack_cost.h:88-93, 540, 564](https://github.com/firedancer-io/firedancer/blob/v26.10.4/src/disco/pack/fd_pack_cost.h#L88-L93)).
- `rewards` is the priority fee plus 50% of the signature fees
  ([fd_pack.c:1036-1062](https://github.com/firedancer-io/firedancer/blob/v26.10.4/src/disco/pack/fd_pack.c#L1036-L1062);
  [fd_pack.h:42](https://github.com/firedancer-io/firedancer/blob/v26.10.4/src/disco/pack/fd_pack.h#L42)
  `FD_PACK_TXN_FEE_BURN_PCT 50`).

**What this means for the design**
- Every deployed version computes **the same ratio**. It is the one our design calls *reward/cost*
  (`src/design.ts`, `expectedPriority`), with the same half base fee and the same requested-limit cost.
  `test/misc.test.ts` checks that our reconstruction of that cost equals the design cost for every role.
- **F really is 8× more expensive** to both clients' schedulers: 18 711 vs 2 335 CU, because the requested loaded-data
  limit enters the cost before execution. A and F have the same CU limit, so A,E before F shows specifically that the
  *requested loaded-data limit* enters the ranking.

## What the contrasts identify

Let the leader count a share *k* of the base fee as reward (both clients' source: *k* = 0.5). From the design's
numbers (priority fees A 4 000, B 10 000, C 0, D 9 000 lamports; costs 2 335, 41 335, 2 335, 7 335):
- **C before B** holds for *k* > 0.12 (C 5 000*k*/2 336 against B (10 000 + 5 000*k*)/41 336).
- **D before C** holds for *k* < 0.84 (D (9 000 + 5 000*k*)/7 336 against C 5 000*k*/2 336).
- **Together** they bracket *k* in (0.12, 0.84), which contains the source's 0.5, rather than proving exactly 0.5.
- **A,E before C** holds for every fee-aware rule (same cost, strictly higher fee): it is the positive control.

## Ties

| deployed version | equal priorities are broken by | source |
|---|---|---|
| Agave v4.3.2, Jito v4.3.2-jito | the internal `id`: the transaction's key in the container's slab, assigned at insertion and reused after removal (not arrival order) | `TransactionPriorityId { priority, id }` with derived ordering, [transaction_priority_id.rs:4-8](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/transaction_priority_id.rs#L4-L8); `insert_map_only` takes the slab's vacant key, [transaction_state_container.rs:268-273, 292-295](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/transaction_state_container.rs#L268-L295) |
| Agave v4.4.0-beta.1, v4.4.0-rc.0, v4.5.0-alpha.2 | **arrival order, oldest first**, then `id` | `TransactionPriorityId { priority, arrival_order, id }` ([v4.5.0-alpha.2](https://github.com/anza-xyz/agave/blob/v4.5.0-alpha.2/core/src/banking_stage/transaction_scheduler/transaction_priority_id.rs)) |
| Firedancer v26.10.4, v26.10.3 | the treap's structure; `COMPARE_WORSE` defines no secondary key | fd_pack.c:227-249 (the same lines in both tags) |

**What this means for the design**
- Our twins A and E have identical priority. Only the Agave pre-releases (about a fifth of the Agave label's slots) are
  designed to keep them in arrival order.
- The twin column is therefore reported **by version family**: Agave 4.3.2 (Jito included), the Agave 4.4/4.5
  pre-releases, Firedancer 26.10.3-4. Versions whose source was not read, Rakurai's own scheduler and the pipelines
  are kept apart. It measures ingress plus tie-breaking, and FIFO only for the pre-releases.
- Agave's primary includes the pre-releases: their priority formula is identical, so the three primary contrasts
  mean the same for every Agave version.

## When a leader holds transactions

**Agave v4.3.2 after Alpenglow.** Before its slot starts, the decision maker
([decision_maker.rs:74-101](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/decision_maker.rs#L74-L101))
holds a received transaction when the leader is fewer than 20 slots away (`HOLD_TRANSACTIONS_SLOT_OFFSET`):
- under 2 slots it is `Hold`;
- 2 to 19 slots it is `ForwardAndHold`, and the scheduler does nothing with it
  ([scheduler_controller.rs:335-336](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/scheduler_controller.rs#L335-L336));
- 20 slots or more, or no upcoming leader slot, it is `Forward`, and the buffer is **cleared**
  (`clear_container`, L327-328).

**Firedancer v26.10.4.** Pack inserts resolved transactions whether or not the validator is leader, and starts
scheduling when its leader slot begins.

**Consequence.** A burst arriving two slots before the window is kept and ranked when the window opens. Our buffered
delivery fires at −2 slots; `results.md` reports the measured arrival margin.

**Ingress floor (Agave v4.3.2).** When the scheduler's buffer is saturated, it publishes a priority floor, and
signature verification then drops arriving packets at or below it
([scheduler_controller.rs:69-113, 281](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/scheduler_controller.rs#L69-L113)).
Our lowest roles, B and F, out-rank about three quarters of their blocks, so this should rarely touch them. If it did,
B and F would go missing more often than other roles: `results.md` reports landing per role.

## How a block is filled (Agave v4.3.2)

- **Scheduler.** The default block-production method is `CentralSchedulerGreedy`
  ([core/src/validator.rs:215-219](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/validator.rs#L215-L219)).
- **Popping.** Each scheduling pass pops the highest-priority transaction first
  ([greedy_scheduler.rs:132-137](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/greedy_scheduler.rs#L132-L137)).
  It then tries to take its account locks, assigning a thread through thread-aware account locks
  (`try_schedule_transaction`, from L245).
  - A transaction whose write lock is held by an in-flight batch is scheduled on that same thread, behind the earlier
    one. This is our `shared` mode, where block order follows scheduling order.
  - Non-conflicting transactions go to the least loaded threads, and their order in the block is the order in which
    the threads' batches complete. This is our `independent` mode.
- **Pacing.** The schedulable budget grows linearly over `slot time − 50 ms` (150 ms at 200 ms slots)
  ([scheduler_controller.rs:64-65, 520-545](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/scheduler_controller.rs#L520-L545)).
  Our six transactions, about 60 000 CU in all, fit in the first millisecond's allowance.

**Jito-Solana** adds one rule to the same greedy scheduler: a transaction is unschedulable while a bundle holds a
conflicting lock
([jito-solana greedy_scheduler.rs](https://github.com/jito-foundation/jito-solana/blob/v4.3.2-jito/core/src/banking_stage/transaction_scheduler/greedy_scheduler.rs)).
Our fresh anchors never appear in bundles.

## Reading the results against this (pre-registered)

Verdicts per contrast and label (`src/analyze.ts`):
- **insufficient data**: fewer than 10 trials;
- **holds**: Holm-adjusted one-sided p < 0.05;
- **reversed**: the upper end of the 95% interval of the per-trial share is below 0.5;
- **no stable order**: that upper end is below 0.75 but not below 0.5;
- **inconclusive**: anything else.

A label with fewer than 10 control trials (A,E before C) is "insufficient data"; one whose control has unadjusted
p ≥ 0.05 is "no fee ordering detected", whatever else it shows.

The alternative rules predict the opposite order, not chance, so only "reversed" is read as one of them. Each verdict
is read on its own:

| contrast | holds | reversed | no stable order |
|---|---|---|---|
| A,E before F | the requested loaded-data limit enters the ranking | F before A and E: no candidate rule predicts this | consistent with the requested loaded-data limit not entering the ranking, since A, E and F would then tie |
| C before B | a base-fee share above 0.12 counts | the base fee does not count: priority fee per cost, price or total fee ranks | no stable order between C and B; no rule is named |
| D before C | the base-fee share is below 0.84 | the whole base fee counts, or cost alone ranks | no stable order between D and C; no rule is named |

All three hold: the label ranks by reward per requested cost, the requested loaded-data limit included, with a
base-fee share between 0.12 and 0.84 (the source: 0.5). Inconclusive and insufficient data are stated as such, never
as the opposite. Between price per CU and total fee, A before B tells them apart (descriptive).

The pipelines (BAM, Harmonic) are read the same way, as statements about the whole pipeline.

Independent mode adds parallel execution on top: a weaker pattern there than in shared mode is what the source
predicts, not a different rule.
