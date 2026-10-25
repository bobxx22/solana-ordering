# How the schedulers we measure rank transactions (source reference)

Every statement below is read from the source of the exact versions mainnet ran during our measurements, as reported
in gossip. Each one links to the tagged line:

- **Agave v4.3.2**: the Agave, AgaveBam, HarmonicAgave and Rakurai labels report this version string.
- **Jito-Solana v4.3.2-jito**: the JitoLabs label.
- **Firedancer v26.10.4**: Firedancer, FireBAM and HarmonicFiredancer.

Statements about `master` are marked as such: several earlier claims (ours and the reviewers') came from `master`,
and they do not hold for the deployed versions. The sources were read on 2026-10-26, through the Helius `svm` skill
(`readSolanaSourceFile`) and raw GitHub files.

BAM sequencing (AgaveBam, FireBAM), Harmonic block building and Rakurai's scheduler are not covered: their ordering
components are outside these repositories. For those labels our results describe the whole pipeline (see README).

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

**Jito-Solana v4.3.2-jito.** `core/src/transaction_priority.rs` is byte-identical to Agave's.

**Firedancer v26.10.4**
- Pack keeps pending transactions in a treap ordered by `rewards / compute_est`
  ([src/disco/pack/fd_pack.c:227-249](https://github.com/firedancer-io/firedancer/blob/v26.10.4/src/disco/pack/fd_pack.c#L227-L249)).
- `compute_est` has the same terms and constants as Agave's cost, including the requested loaded-data limit
  ([src/disco/pack/fd_pack_cost.h:88-93, 540, 564](https://github.com/firedancer-io/firedancer/blob/v26.10.4/src/disco/pack/fd_pack_cost.h#L88-L93)).
- `rewards` is the priority fee plus 50% of the signature fees
  ([fd_pack.c:1036-1062](https://github.com/firedancer-io/firedancer/blob/v26.10.4/src/disco/pack/fd_pack.c#L1036-L1062);
  [fd_pack.h:42](https://github.com/firedancer-io/firedancer/blob/v26.10.4/src/disco/pack/fd_pack.h#L42)
  `FD_PACK_TXN_FEE_BURN_PCT 50`).

**Consequences for the design**

- The two production clients compute **the same ratio**. It is the one our design calls *reward/cost*
  (`src/design.ts`, `expectedPriority`), with the same half base fee and the same requested-limit cost.
  `test/misc.test.ts` checks that our reconstruction of that cost equals the design cost for every role.
- **F really is 8× more expensive** to both clients' schedulers: 18 711 vs 2 335 CU, because the loaded-data limit
  enters the cost before execution. That is why A,E before F is a direct test of the cost denominator.
- **D before C** holds under both clients' actual reward (half the base fee): D 11 500 / 7 336 = 1.57 against
  C 2 500 / 2 336 = 1.07. It is not rule-agnostic, though: counting the whole base fee would reverse it. The
  rule-agnostic control is A,E before C (same cost, strictly higher fee).

## Ties

**Agave v4.3.2 and Jito v4.3.2-jito**
- `TransactionPriorityId` is `{ priority, id }`, with derived ordering
  ([transaction_priority_id.rs:4-8](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/transaction_priority_id.rs#L4-L8)).
- Equal priorities are broken by the internal `id`, the slot index of the transaction in the container's slab
  ([transaction_state_container.rs:278-294](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/transaction_state_container.rs#L278-L294)).
  Slab slots are reused, so the tie order is **not** arrival order.
- `master` has since added an `arrival_order` field that breaks ties oldest-first. That is not what mainnet runs.

**Firedancer.** `COMPARE_WORSE` defines no secondary key; equal ratios are ordered by the treap's structure.

**Consequence for the design.** Our twins A and E have identical priority. Neither client is designed to keep them
in send order, so the twin column measures ingress plus tie-breaking, not FIFO. In the buffered calibration trials,
the twin sent first landed first in 2 of 9.

## When a leader holds transactions (Agave v4.3.2 after Alpenglow)

Before its slot starts, the decision maker
([decision_maker.rs:74-101](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/decision_maker.rs#L74-L101))
holds a received transaction when the leader is fewer than 20 slots away (`HOLD_TRANSACTIONS_SLOT_OFFSET`):
- under 2 slots it is `Hold`;
- 2 to 19 slots it is `ForwardAndHold`, and the scheduler does nothing with it
  ([scheduler_controller.rs:335-336](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/scheduler_controller.rs#L335-L336));
- 20 slots or more, or no upcoming leader slot, it is `Forward`, and the buffer is **cleared**
  (`clear_container`, L327-328).

**Consequence:** a burst arriving two slots before the window is kept and ranked when the window opens. Our buffered
delivery fires at −2 slots, and we measure its arrival margin.

## How a block is filled (Agave v4.3.2)

- **Scheduler.** The default block-production method is `CentralSchedulerGreedy`
  ([core/src/validator.rs:215-219](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/validator.rs#L215-L219)).
- **Popping.** Each scheduling pass pops the highest-priority transaction first
  ([greedy_scheduler.rs:132-137](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/greedy_scheduler.rs#L132-L137)).
  It then tries to take its account locks, assigning a thread through thread-aware account locks
  (`try_schedule_transaction`, from L245).
  - A transaction whose write lock is held by an in-flight batch goes to that same thread, behind the earlier one.
    This is our `shared` mode, where block order follows scheduling order.
  - Non-conflicting transactions go to the least loaded threads, and their order in the block is the order in which
    the threads' batches complete. This is our `independent` mode.
- **Pacing.** The schedulable budget grows linearly over `slot time − 50 ms` (150 ms at 200 ms slots)
  ([scheduler_controller.rs:64-65, 520-545](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/banking_stage/transaction_scheduler/scheduler_controller.rs#L520-L545)).
  Our six transactions, about 60 000 CU in all, fit in the first millisecond's allowance.

**Jito-Solana** adds one rule to the same greedy scheduler: a transaction is unschedulable while a bundle holds a
conflicting lock
([jito-solana greedy_scheduler.rs](https://github.com/jito-foundation/jito-solana/blob/v4.3.2-jito/core/src/banking_stage/transaction_scheduler/greedy_scheduler.rs)).
Our fresh anchors never appear in bundles.

## Reading the results against this

| outcome in buffered/shared | what it means |
|---|---|
| A,E before F and C before B and D before C, consistently | the client ranks by reward/cost as in its source |
| A,E before F fails, C before B holds | the cost term is ignored (price or fee per unit without the loaded-data cost) |
| C before B fails, A,E before F holds | the base-fee share is ignored (priority fee / cost) |
| A,E before C fails | no fee ordering detected (arrival or parallel execution dominates) |

Independent mode adds parallel execution on top: a weaker pattern there than in shared mode is what the source
predicts, not a different rule.
