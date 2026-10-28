# Inside the block: how Solana validators order transactions

This repository measures, on Solana mainnet after Alpenglow, how block producers order transactions inside a block,
and whether the rule differs between validator clients.

## In short

- **Evidence.** Our own transactions: bursts of six, with fees chosen so that the candidate ordering rules (reward per
  cost, priority fee per cost, price per compute unit, total fee, arrival order) predict different orders.
- **Delivery.** Each burst goes over QUIC straight to the address the targeted leader advertises, two slots before
  its window, in a random send order. Positions are read back from the chain.
- **Tests.**
  - Three contrasts per client label, each isolating one term of the rule, plus a positive control.
  - Twelve exact one-sided tests with Holm adjustment for the four local-scheduler labels, and the same twelve for
    the four BAM and Harmonic pipelines.
  - Verdicts fixed before the main run (git tag `prereg-main`).
- **Result** (main run, 2026-10-27, 403 trials):
  - Agave, JitoLabs, Firedancer and Rakurai order the transactions waiting in the leader's buffer by **reward per
    requested cost unit**, as their deployed source does. All twelve primary tests hold, and 107 of 120 trials
    landed in the exact predicted order.
  - The exceptions are specific validators: three JitoLabs validators ordered by total priority fee.
  - The BAM pipelines order the same way. The Harmonic pipelines rank by a rule of their own: the transaction with a
    64 MiB loaded-data request always came last.
  - Arrival order decides only what the scheduler cannot rank: transactions streamed into a block being built, and
    ties. Firedancer puts the later of two equal transactions first.
- **Details.** [`REPORT.md`](REPORT.md); the generated tables are in
  [`data/mainnet-beta/results/results.md`](data/mainnet-beta/results/results.md).
- **Check it.** `docker compose up` needs no keys and sends nothing.

### Terms

| term | meaning |
|---|---|
| trial | one burst of six transactions (roles A–F) aimed at one leader window |
| window | the 4 consecutive slots (about 0.8 s) of one leader |
| role | a transaction's fee parameters (table below); A and E are identical twins |
| contrast | a pair of roles whose order tells two rules apart, e.g. C before B |
| cell | how a trial is delivered: `buffered` (all six two slots before the window), `burst` (all six one slot into it), `streamed` (30 ms apart); and whether the six write one account (`shared`) or six (`independent`) |
| label | the validator client a leader reports in gossip (`clientId`): Agave, JitoLabs, Firedancer, Rakurai, and the pipelines AgaveBam, FireBAM, HarmonicAgave, HarmonicFiredancer |
| ingress host | the host of the QUIC address a leader advertises: the validator itself, or a gateway shared by many |
| campaign | a named set of runs sharing quotas; the main run is campaign `main`, calibration runs are kept apart |
| gamma | per trial, the share of pairs in a rule's order minus the share against it (+1: all pairs in the rule's order) |

## Reproduce (one command)

```bash
docker compose up
```

This runs `reproduce`, which needs no keys and sends nothing. It does three things:

1. **Regenerates every table** from the committed raw data, and checks that the four result files are byte-identical
   to the committed ones.
2. **Checks the raw data against the chain** (`verify`). It uses public endpoints other than the one used to
   collect: `api.mainnet-beta.solana.com`, which keeps the whole history, then PublicNode.
   - Every landed transaction: its signature is at the recorded index of the recorded slot, and the slot is after
     Alpenglow.
   - The slot leader: checked against the leader schedule where an endpoint still serves that epoch (public
     endpoints keep only a few epochs, so the main run is also checked session by session, see below), otherwise
     against the block's fee-reward recipient.
   - A sample of whole transactions from every role: fee, fee payer (one of the run's own wallets), anchor, and the
     ComputeBudget instructions against the recorded role parameters. This is what tells A, E and F apart, since
     they pay the same fee.
   - A sample of whole blocks: every recorded row of everyone else's transactions (fees, requested limits,
     scheduled cost), rebuilt from the chain.
   - Every transaction recorded as not landed is unknown to the chain. It is asked only of an endpoint whose history
     reaches back to the slot it was sent in; otherwise it is counted as unchecked, not as absent.
   - The delivery-path probes (`paths/`, `quic-test/`): every recorded landing slot and non-landing.
   - Every sent transaction was planned before sending and reserved in the spend ledger.

   It exits with an error on any mismatch. A block that no endpoint serves any more is reported, not failed. The
   one-command check covers a seeded sample of 120 blocks, a few minutes on the rate-limited public endpoint.
   `node src/cli.ts verify` checks every block. The committed checks are `data/mainnet-beta/verify.json` (all runs)
   and `data/mainnet-beta/verify/<run>.json` (each main-run session, made while its leader schedule was served).
3. **Makes one dry-run trial** against mainnet.
   - It opens the QUIC connection to the leader and simulates the six transactions with signature verification.
   - It then simulates unsigned copies paid by a public wallet of the last live run, with signature verification
     off. This shows that every role executes (600 CU each, F's 64 MiB loaded-data limit accepted). Such copies can
     never be valid on chain.

`docker compose run --rm ordering reproduce --offline` does only step 1.

Without Docker you need Node.js 24.11 or newer (there are no npm dependencies) and Python 3 with `aioquic`, which the
direct path uses:

```bash
python -m venv .venv && .venv/bin/pip install -r py/requirements.txt
node src/cli.ts reproduce
npm test
```

On Windows the pip in the second line is `.venv\Scripts\pip`.

## The question and the experiment

When a leader builds a block, which transaction goes first? Candidate rules:

- **reward / cost.** What Agave's and Firedancer's schedulers compute: the priority fee plus the leader's half of the
  base fee, divided by the scheduling cost.
- **priority fee / cost.** The same, without the base-fee share.
- **price per compute unit.**
- **total priority fee.**
- **arrival order.**
- **no rule at all**, because parallel execution scrambles the order.

A **trial** is a burst of six transactions aimed at one leader window, which is 4 slots of 200 ms. Each transaction is
`SetComputeUnitLimit`, `SetComputeUnitPrice`, `SetLoadedAccountsDataSizeLimit`, and a 0-lamport transfer to an anchor
account. The cost below is the scheduling cost in compute units, before execution.

| role | CU limit | CU price, µL/CU | loaded-data limit | priority fee | cost | reward/cost | prio fee/cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| A | 1 000 | 4 000 000 | 16 KiB | 4 000 | 2 335 | 2.78 | 1.71 |
| B | 40 000 | 250 000 | 16 KiB | 10 000 | 41 335 | 0.30 | 0.24 |
| C | 1 000 | 0 | 16 KiB | 0 | 2 335 | 1.07 | 0 |
| D | 6 000 | 1 500 000 | 16 KiB | 9 000 | 7 335 | 1.57 | 1.23 |
| E | = A | | | | | | |
| F | 1 000 | 4 000 000 | 64 MiB | 4 000 | 18 711 | 0.35 | 0.21 |

Each rule therefore predicts a different order of the six:

| rule | predicted order |
|---|---|
| reward/cost | AE D C F B |
| prio fee/cost | AE D B F C |
| price | AEF D B C |
| total fee | B D AEF C |

`test/design.test.ts` checks these orders.

Contrasts that settle the question directly:

- **A,E vs F.** F has A's price and fee but eight times its cost. Only the cost denominator can separate them.
- **C vs B.** Only the base-fee share separates reward/cost from prio fee/cost and price.
- **D vs C.** With half the base fee (what both clients' source uses) D goes first; with the whole base fee, or cost
  alone, C would.
- **A,E vs C.** Same cost, strictly higher fee: every fee-aware rule puts A and E first. This is the positive control.
- **A vs E.** E is A's twin; between them only the send order differs.

What the deployed schedulers actually compute is documented, with links to the exact source lines of Agave v4.3.2,
Jito-Solana v4.3.2-jito and Firedancer v26.10.4, in [`docs/schedulers.md`](docs/schedulers.md). Both clients rank by
exactly the reward/cost of the table above.

Each trial gets a cell, dealt per client in shuffled blocks of ten:

| cell | per 10 trials | what it asks |
|---|---:|---|
| buffered / shared | 5 | **primary.** The whole burst arrives at once two slots (~400 ms) before the window, so the leader holds all six when its block starts. They conflict on one anchor, so they run on one thread in the order the scheduler picks: block order is scheduling order. |
| buffered / independent | 2 | the same with separate anchors: parallel threads may record them in completion order |
| burst / shared | 1 | the whole burst one slot into the window, while the block is being produced |
| streamed / shared, streamed / independent | 1 + 1 | one transaction every 30 ms from one slot into the window: a control for arrival order, since a leader that does not hold transactions back for 30 ms must include them in send order |

The send order is a fresh random permutation in every trial.

**Quotas.**
- 60 trials per local-scheduler label (Agave, JitoLabs, Firedancer, Rakurai) and 30 per pipeline label (AgaveBam,
  FireBAM, HarmonicAgave, HarmonicFiredancer): 360 trials.
- A trial counts towards its quota only when B, C, D, F and at least one of A and E landed in the targeted window, so
  every counted trial carries every primary contrast.
- **Spend.** A trial costs at most 61 000 lamports. With trials that land only in part, the main run is expected to
  cost about 0.025 SOL. A label may be dispatched up to three times its quota, so the bound is not an estimate: it is
  the spend cap in code, 0.05 SOL for everything this repository ever sends to mainnet.

**Campaigns.** Runs belong to a campaign (`--campaign`). The main run is the campaign `main`; the calibration runs
are kept apart and never enter a test. A run that stops is continued by starting it again with the same campaign
name: the quotas, the per-validator counts and the excluded addresses carry over.

### What Alpenglow changes for this experiment

- **When.** Alpenglow replaced TowerBFT at slot 459 653 000 on 2026-10-21. That is the slot announced for the switch
  ([Solana Compass](https://solanacompass.com/news/alpenglow-is-pending-activation-on-solana-mainnet-with-towerbft-set-to-retire-at-slot-459653000)).
  On chain, the last block before it, slot 459 652 996, has block time 13:53:59 UTC. `analyze` and `verify` check that
  every measured slot is at or after the switch.
- **No vote transactions.** Consensus votes no longer travel as transactions in blocks, so every transaction in a
  block is a user transaction competing for position.
- **Timing.** Slots are about 200 ms, so a leader's 4-slot window lasts about 0.8 s, and "two slots ahead" is about
  400 ms.
- **When a leader holds transactions.** Agave's decision maker has a separate Alpenglow path. It decides when a
  validator holds, forwards or drops received transactions before its slot (`docs/schedulers.md`, "When a leader
  holds transactions"). The buffered delivery is timed against it.

## How the design handles each consideration

### Leader schedule and leader types

- **Targeting.** The run reads the leader schedule (`getSlotLeaders`) and the client of every validator (gossip
  `clientId` and version, snapshotted at the start of each run, because operators switch). It aims each trial at
  one upcoming window. Among the windows of the next ~12 s it takes the one whose client is furthest from its quota.
- **Per-validator cap.** Trials per validator are capped. The cap is raised for clients whose leader slots sit with
  few validators (it uses the effective number of validators by slot share), so that every quota stays reachable.
- **Attribution.** A block is attributed to the *scheduled leader of its slot*, not to the recipient of the block's
  fee reward. We found that some validators send their block revenue to a separate collector account.
- **Producer types.** The client labels (gossip `clientId`) are not equivalent kinds of block producer:
  - Agave, Firedancer and Rakurai schedule locally;
  - JitoLabs (Jito-Agave) adds a bundle stage;
  - BAM validators (AgaveBam, FireBAM) take the order from an external sequencer;
  - Harmonic validators (HarmonicAgave, HarmonicFiredancer) accept blocks from external builders.

  A result for a label describes that whole pipeline as it treats ordinary transactions, not a scheduler in
  isolation.
- **Few operators per label.** Some labels rest on very few validators. By leader slots in epoch 1068, Agave and
  Rakurai each have about four effective validators, and Firedancer about six. A verdict is therefore stated for the
  validators of the label that we reached. `results.md` gives each label's validators, slot share, effective number,
  reachable share and validators reached ("Coverage per label").
- **Shared gateways.** BAM and Harmonic validators advertise QUIC addresses on shared gateway hosts.
  - In epoch 1067, the 364 AgaveBam validators advertised 17 addresses, one of them for 102 validators.
  - FireBAM had 94% of its slots behind shared addresses.
  - The 86 Harmonic validators sat on 6 hosts, with a separate port each.
  - Every JitoLabs, Firedancer, Rakurai and Agave validator had its own address. But 37 JitoLabs validators (about a
    quarter of JitoLabs slots) advertise port 11228, most likely a Jito relayer in front of the validator. Both
    JitoLabs bursts that landed nothing in calibration went to that port. The run excludes such addresses once they
    have failed twice without ever landing; the reachable share in `results.md` shows what that leaves.

  For BAM and Harmonic labels our timing control therefore ends at the gateway, and two labels behind one gateway
  are not two independent schedulers. The analysis records the ingress host of every trial:
  - the pipelines' group-level check groups trials by host;
  - rule-agreement intervals resample hosts.

  The comparison of clients rests on the four local-scheduler labels. BAM and Harmonic get their own family of tests,
  read as statements about the pipeline.

### Path from our backend to the node

- **The pilot.** It went through `sendTransaction` of the public RPC. The RPC held five-transaction bursts for
  about 1.3 s, released them in its own order, and the block order followed that release order (pilot table in
  `results.md`). The pilot therefore measured the RPC, not the leader. Only a quarter of the transactions reached
  the targeted leader.
- **The main path.** The experiment therefore delivers the burst **directly to the leader's advertised QUIC TPU
  address**, the path RPC nodes themselves use to forward transactions (`py/tpu_sender.py`, `aioquic`).
  - We connect a second ahead as an unstaked peer.
  - Each transaction goes on its own stream in the chosen order.
  - We record the send time and the time the peer's QUIC stack acknowledged the whole stream. The acknowledgement
    is the proof of delivery, which separates "not delivered" from "delivered and dropped".
  - Some addresses accept the handshake but drop unstaked traffic. A run stops targeting an address that has never
    landed anything once it fails twice in a row (empty bursts or refused handshakes); an address that landed before
    is never excluded.
- **The probe.** `paths` measures the delay from dispatch to landing for single transactions: data in
  `data/mainnet-beta/paths/` and `quic-test/`.
- **What stays unknown.** QUIC stream handling, signature verification and QoS inside the leader. Unstaked
  connections get the lowest share of the leader's ingress capacity.

### Interaction of our own transactions

- **Separate payers.** Every transaction has its own fee payer, because the fee payer is always write-locked and a
  shared one would itself be a conflict. Two sets of six sub-payers alternate between consecutive trials. They are
  funded for the whole run before it starts, and checked (and if needed topped up) before each use, while idle.
- **Fresh anchors.** Every trial writes fresh, random anchor accounts, so trials never touch each other's accounts.
- **Equal structure in both modes.** `shared` and `independent` differ only in whether the six anchors are the same
  account. The transactions have identical structure and cost (two write locks each).

### Competition inside the block

- **The market around us.** Our six transactions land among 150–1 100 others per block (`results.md`). We cannot
  control those.
- **Where we stand.** In lamports our priority fees are small (0 to 10 000), but per scheduled compute unit even our
  weakest roles out-rank most of the block: the typical transaction requests far more compute than it pays for.
  The experiment therefore measures how a scheduler ranks transactions **near the head of its queue**. It does not
  probe how ordinary low-priority transactions are deferred. `analyze` reports each role's rank among the others in
  its block and its position in the block.
- **Background analysis.** For every block holding our transactions, `analyze` correlates position with reward per
  *scheduled* cost unit for everyone else, over the whole block and over its first 10%. The scheduled cost is
  rebuilt from each transaction's requested compute-unit limit, because `meta.costUnits` counts consumed units.

### Send order

- **Randomized.** The send order is randomized per trial, independently of the fees, so arrival cannot masquerade
  as a fee rule.
- **Twins.** A and E have identical priority. The deployed versions break such ties differently
  (`docs/schedulers.md`):
  - Agave and Jito 4.3.2 use an internal container id;
  - the Agave 4.4/4.5 pre-releases use arrival order;
  - Firedancer uses its treap structure.

  The twin column is therefore reported by version family. It measures ingress plus tie-breaking, and FIFO only for
  the pre-releases.
- **Three deliveries.**
  - `buffered` (all six at once, before the window) asks how the scheduler ranks transactions that are all
    available together.
  - `burst` asks the same while the block is already being produced.
  - `streamed` (30 ms apart) checks that arrival order is preserved when nothing is held back.

### Noise versus rule

The analysis is fixed before the first trial of the main run. This section, the header of `src/analyze.ts`, the quota
rule in `src/design.ts` and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) are the plan. They are frozen at the git tag
`prereg-main`, which is older than every trial of campaign `main` (the run directories are named by their UTC start).
Anything added after the data is marked exploratory (REPORT, "The plan").

- **Unit.** One trial.
  - Its transactions that landed in the targeted leader's 4-slot window are ordered by (slot, index): a
    transaction pushed to a later slot of the window counts as later.
  - Landings outside the window are counted as spill-over and left out.
  - A contrast uses every trial in which both of its roles landed in the window.
- **Primary family: 12 tests.** Campaign `main`, cell buffered/shared, the four local-scheduler labels (Agave,
  JitoLabs, Firedancer, Rakurai), three contrasts:
  - A,E before F (per trial, the mean of the two indicators);
  - C before B;
  - D before C.

  The Agave label includes its 4.4/4.5 pre-release validators: their priority formula is byte-identical
  (`docs/schedulers.md`).
  - Each test is one-sided against chance, using the exact null distribution of the sum of per-trial values.
  - A single pair is 0 or 1 with probability 1/2; A,E vs F is 0, 1/2 or 1 with probability 1/3 each. The send order
    and the payers are randomized in every trial. So when the order does not depend on the roles' fee parameters,
    this null is exact, whatever else (arrival, payer, signature) the validator orders by.
  - The twelve are Holm-adjusted together, and a test without data enters with p = 1.
  - Shares are given with 95% bootstrap intervals over trials.
- **Verdicts**, per contrast and label.
  - **insufficient data**: fewer than 10 trials. Below 8, even unanimous trials cannot pass the strictest Holm step.
  - **holds**: Holm-adjusted p < 0.05.
  - **reversed**: the interval's upper end is below 0.5, so the opposite order dominates.
  - **no stable order**: the upper end is below 0.75 but not below 0.5. This is neither the near-deterministic
    order the source predicts nor the opposite.
  - **inconclusive**: anything else.

  Only "reversed" is read as evidence for an alternative rule. Chance-level order (a share near 0.5) is "no stable
  order", never "the base fee does not count". For A,E vs F, chance level is what "the loaded-data limit does not
  count" predicts, because A, E and F would then tie, and the reading says so. An inconclusive contrast is reported
  as such, never as its opposite. `analyze` prints the verdicts and the reading of each label from the decision
  table in `docs/schedulers.md`.
- **Control.** A,E before C (same cost, strictly higher fee), outside the family.
  - A label with fewer than 10 control trials is "insufficient data".
  - A label whose control has unadjusted p ≥ 0.05 is "no fee ordering detected", whatever its other contrasts say.
- **Pipelines: a second family of 12 tests.** The same control, contrasts and verdicts for AgaveBam, FireBAM,
  HarmonicAgave and HarmonicFiredancer (buffered/shared, campaign `main`), Holm-adjusted within these twelve. A
  verdict describes the whole pipeline behind the gateway, not a client's scheduler.
- **What the contrasts identify.**
  - C before B and D before C bracket the base-fee share counted as reward between 0.12 and 0.84; the source's 0.5
    lies inside.
  - A,E before F shows that the *requested loaded-data limit* enters the cost.
- **Quota and power.**
  - A trial counts towards its label's quota only with B, C, D, F and A or E in the window, so 30 primary trials per
    local label give every primary contrast at least 30 pairs.
  - At the strictest Holm threshold (0.05/12), with 30 pairs, a contrast that holds 90% of the time passes with
    probability 0.99, and 80% of the time with 0.76. With 25 pairs: 0.97 and 0.62. These are exact binomial
    computations.
- **Shortfall.** A label that misses its quota by the end of the measurement period stays in the family with the
  number of trials it has.
- **Scope of a conclusion.** The exact test is valid trial by trial, so a verdict is a statement about the validators
  of the label that we reached. How far it extends beyond them is what the robustness checks show.
- **Robustness**, reported, not tested:
  - each test rerun without each validator in turn (leave one out), with the worst p and any change of verdict;
  - a group-level check: per validator (for pipelines, per ingress host) the mean share minus 0.5, with a one-sided
    sign-flip test over the groups; with k groups its p cannot go below 2^-k;
  - per-validator shares for validators with at least 5 primary trials;
  - each label's coverage: validators, slot share, effective number, reachable share, validators reached;
  - a sensitivity run without trials that reconnected before sending, had an unknown or under-100 ms arrival margin,
    or ran on a clock other than `firstShred`.
- **Secondary, descriptive.** Shares with intervals, no tests:
  - buffered/independent per label;
  - burst per label;
  - streamed pooled over the local labels;
  - the twins by version family, only for versions whose source was read;
  - exact-order rates;
  - rule agreement (gamma per trial, bootstrap over ingress hosts, sign-flip over host means);
  - the calibration and rehearsal runs.

  `results/orders.md` lists every trial's send order and observed order.

### What this design does not separate

- **Ingress inside the leader vs its scheduler.** The order in which the leader's QUIC, signature-verification and
  scheduler stages received our transactions. The QUIC acknowledgement proves delivery, not the time each
  transaction reached the scheduler.
- **Gateway vs validator** for BAM and Harmonic labels (see above).
- **Exactly when a buffered burst arrived** relative to the leader's slot start. Our slot clock lags the leader by a
  fraction of a slot, which is why buffered bursts are sent two slots ahead.
- **Head-of-queue vs ordinary transactions** (see "Competition inside the block").
- **Lock contention vs parallel execution.** Parallel banking threads or bank tiles record non-conflicting
  transactions in completion order. The `shared` vs `independent` contrast shows the combined effect.
- **External sequencers and builders vs the client scheduler.** For BAM and Harmonic, the label covers the whole
  pipeline.
- **Operator configuration within a client label**, and the label itself: the client id and version are what the
  validator reports in gossip, and the chain cannot confirm them.
- **Staked vs unstaked delivery.** We are unstaked; a staked sender may be treated differently.
- **Bundles.** Jito bundles and tips are out of scope; they occupy positions in the same blocks.

## Safety and engineering

- **Dry run by default.**
  - `run` without `--live` sends nothing and reads no wallet key. It signs with throwaway keys, simulates the
    transactions (above, step 3) and writes to `data/<cluster>/dry-runs/`, which is git-ignored.
  - `fund` and `sweep` read the wallet files to print their plan, and `status` reads them to show balances; all
    three send only with `--live`.
  - `--live` accepts no value other than true or false.
- **Spend cap in code.**
  - Every send first reserves its maximum fee in an append-only ledger (`data/mainnet-beta/ledger.jsonl`).
  - A reservation closes at the fee actually charged, or at zero only once the transaction's blockhash has
    provably expired.
  - Mainnet never exceeds 0.05 SOL, and 0.0001 SOL of that is kept for returning the sub-payers' balances.
  - A live process holds an exclusive lock on the ledger.
  - The chain is identified by its genesis hash, not by a flag.
- **Keys.**
  - Wallets are files mounted from the host: `keys/`, git-ignored and Docker-ignored.
  - In Docker only the `live` service mounts them (`docker compose run --rm live run --live --campaign main`). The
    default service, which reproduces, never sees them.
  - `keygen` prints only the address.
  - The QUIC sender receives only signed transactions.
  - Logged RPC URLs keep only scheme and host.
- **Logging.** Every run writes `run.json` (options, roles, wallets, cap) and JSONL files:
  - `planned`: signatures, written before reserving;
  - `trials`, `txs`: dispatch slot and time, send results;
  - `events`: landing checks, skips, simulations, errors;
  - `blocks`, `positions`, `landed.json`.

  A line torn by a killed process is skipped with a warning, so analysis and a continued campaign still start.
- **CI** ([workflow](.github/workflows/ci.yml)), on every push:
  - a type check (`tsconfig.json`; TypeScript is fetched for that step only);
  - the unit tests, including the QUIC sender against a local QUIC server (`py/loopback_server.py`);
  - the results regenerated byte for byte;
  - the same checks inside the Docker image.

  The full online `reproduce` runs as a separate job that does not fail the build, because public endpoints
  rate-limit shared runners. REPORT links its latest result.

## Data

`data/mainnet-beta/`:

- `snapshots/`: validators by client.
- `runs/<UTC start>/`: one live run, with the raw files listed above.
- `paths/`, `quic-test/`: delivery-path measurements. The QUIC feasibility data was produced once by
  `archive/quic-feasibility.ts`, which is kept as a record, was written against an earlier API and does not run.
- `ledger.jsonl`: every reservation and settlement.
- `verify.json`: the last check of all runs against the chain; `verify/<run>.json`: the check of each main-run
  session, made while its leader schedule was still served.
- `results/`: generated by `analyze`.

## Commands

The main run follows [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

`node src/cli.ts help` lists them all.

| command | what it does |
|---|---|
| `reproduce` | the one-command check described above |
| `discover` | snapshot validators by client |
| `run [--live --campaign NAME]` | the experiment. Options: `--quota Agave=60,...`, `--path tpu\|rpc`, `--per-validator`, `--seed`, `--minutes` |
| `collect [run\|all] [--refresh]` | landing slot, in-block position and slot leader; settles the ledger |
| `analyze` | all tables, offline |
| `verify [run\|all] [--write] [--verify-rpc URL]` | the check against the chain |
| `paths [--live]` | delivery-path probe |
| `keygen`, `address`, `status`, `fund`, `sweep` | wallet and budget |
