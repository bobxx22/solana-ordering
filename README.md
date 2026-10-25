# Inside the block: how Solana validators order transactions

This repository measures, on Solana mainnet after Alpenglow, how block producers order transactions inside a block,
and whether the rule differs between validator clients. The primary evidence is our own transactions: bursts of six
transactions with fee parameters chosen so that the candidate ordering rules disagree. Each burst is delivered over
QUIC straight to the address the targeted leader advertises (the validator itself for most clients, a shared gateway
for BAM and Harmonic validators), and the transactions' positions are read back from the chain.

Results: [`REPORT.md`](REPORT.md). Generated tables: [`data/mainnet-beta/results/results.md`](data/mainnet-beta/results/results.md).

## Reproduce (one command)

```bash
docker compose up
```

This runs `reproduce`, which needs no keys and sends nothing. It does three things:

1. **Regenerates every table** from the committed raw data and checks that the result is byte-identical to the
   committed `results.md`.
2. **Checks the raw data against the chain** (`verify`), through a public RPC other than the one used to collect:
   - every landed transaction: its signature is at the recorded index of the recorded slot, with the recorded fee,
     paid by one of the run's own wallets, writing the recorded anchor; the slot is after Alpenglow; the slot leader
     is the recorded one, where the RPC still serves that epoch's leader schedule;
   - a sample of whole transactions from every role: their ComputeBudget instructions match the recorded role
     parameters (this is what tells A, E and F apart, since they pay the same fee);
   - every transaction recorded as not landed is unknown to the chain;
   - every sent transaction was planned before sending and reserved in the spend ledger.

   It exits with an error if anything does not match.
3. **Makes one dry-run trial** against mainnet. It opens the QUIC connection to the leader and simulates the six
   transactions with signature verification.

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

Three contrasts settle the question directly:

- **A,E vs F.** F has A's price and fee but eight times its cost. Only the cost denominator can separate them.
- **B vs C.** Only the base-fee share separates reward/cost from prio fee/cost and price.
- **A vs E.** E is A's twin; between them only the send order differs.

Each trial gets a cell, dealt per client in shuffled blocks of ten:

- **mode**:
  - `shared`: all six write the same anchor, a write-lock conflict the scheduler must serialize;
  - `independent`: each writes its own anchor.
- **delivery** (buffered three times as often as each of the others):
  - `buffered`: the whole burst at once two slots (~400 ms) before the window. All six wait in the leader's buffer
    when its block starts, so the scheduler ranks six transactions available together. This is the main cell.
  - `burst`: the whole burst at once one slot into the window, arriving while the block is being produced.
  - `streamed`: one transaction every 30 ms from one slot into the window. This is a control for arrival order: a
    leader that does not hold transactions back for 30 ms must include them in send order.

The send order is a fresh random permutation in every trial.

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
- **Shared gateways.** BAM and Harmonic validators advertise QUIC addresses on shared gateway hosts.
  - In epoch 1067, the 364 AgaveBam validators advertised 17 addresses, one of them for 102 validators.
  - FireBAM had 94% of its slots behind shared addresses.
  - The 86 Harmonic validators sat on 6 hosts, with a separate port each.
  - Every JitoLabs, Firedancer, Rakurai and Agave validator had its own address.

  For BAM and Harmonic labels our timing control therefore ends at the gateway, and two labels behind one gateway
  are not two independent schedulers. The analysis records the ingress host of every trial and resamples hosts, not
  validators. The comparison of clients rests on the four local-scheduler labels, with BAM and Harmonic reported as
  pipelines.

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
  - Some addresses accept the handshake but drop unstaked traffic. A run stops targeting an address after two bursts
    in a row that land nothing.
- **The probe.** `paths` measures the delay from dispatch to landing for single transactions: data in
  `data/mainnet-beta/paths/` and `quic-test/`.
- **What stays unknown.** QUIC stream handling, signature verification and QoS inside the leader. Unstaked
  connections get the lowest share of the leader's ingress capacity.

### Interaction of our own transactions

- **Separate payers.** Every transaction has its own fee payer, because the fee payer is always write-locked and a
  shared one would itself be a conflict. Two sets of six sub-payers alternate between consecutive trials, and they
  are topped up only while idle.
- **Fresh anchors.** Every trial writes fresh, random anchor accounts, so trials never touch each other's accounts.
- **Equal structure in both modes.** `shared` and `independent` differ only in whether the six anchors are the same
  account. The transactions have identical structure and cost (two write locks each).

### Competition inside the block

- **The market around us.** Our six transactions land among 200–600 others per block. We cannot control those.
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
- **Twins.** A and E isolate arrival order.
- **Three deliveries.** `buffered` (all six at once, before the window) asks how the scheduler ranks transactions
  that are all available together. `burst` asks the same while the block is already being produced. `streamed`
  (30 ms apart) checks that arrival order is preserved when nothing is held back.
- **Ingress order.** In shared/buffered trials the twins also show whether our six streams reached the scheduler in
  the order we sent them: Agave breaks equal-priority ties by earlier arrival.

### Noise versus rule

- **Unit.** One trial. Its transactions that landed in the targeted leader's window are ordered by (slot, index): a
  transaction pushed to a later slot of the same window counts as later.
- **Headline: decisive pairs.** Single pairs of roles that separate the rules (A before F, E before F, C before B,
  A before B): one indicator per trial, reported as shares with Wilson intervals and exact binomial tests,
  Holm-adjusted over each table, per delivery and mode. D before C, where all rules agree, is the positive control.
  A null result is reported as such when the control works and the rules do not.
- **Rule agreement.** Per trial: gamma = (pairs in the rule's order − pairs against it) / pairs the rule ranks
  differently. Per client: the mean, a 95% bootstrap interval resampling *ingress hosts* (trials through one host
  are not independent), and a sign-flip permutation test, Holm-adjusted.
- **Power.** With about 30 buffered trials per label, a pair that holds 90% of the time is detected after
  correction; a 70–80% tendency per label generally is not, though it can be when the local-scheduler labels are
  pooled.

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
- **Operator configuration within a client label.**
- **Staked vs unstaked delivery.** We are unstaked; a staked sender may be treated differently.
- **Bundles.** Jito bundles and tips are out of scope; they occupy positions in the same blocks.

## Safety and engineering

- **Dry run by default.** Without `--live` nothing is sent and no wallet key is read. A dry run signs with throwaway
  keys, simulates every transaction with signature verification, and writes to `data/<cluster>/dry-runs/`, which is
  git-ignored.
- **Spend cap in code.**
  - Every send first reserves its maximum fee in an append-only ledger (`data/mainnet-beta/ledger.jsonl`).
  - A reservation closes at the fee actually charged, or at zero only once the transaction's blockhash has
    provably expired.
  - Mainnet never exceeds 0.05 SOL, and 0.0001 SOL of that is kept for returning the sub-payers' balances.
  - A live process holds an exclusive lock on the ledger.
  - The chain is identified by its genesis hash, not by a flag.
- **Keys.** Wallets are files mounted from the host (`keys/`, git-ignored and Docker-ignored). `keygen` prints only
  the address. The QUIC sender receives only signed transactions. Logged RPC URLs keep only scheme and host.
- **Logging.** Every run writes `run.json` (options, roles, wallets, cap) and JSONL files:
  - `planned`: signatures, written before reserving;
  - `trials`, `txs`: dispatch slot and time, send results;
  - `events`: skips, simulations, errors;
  - `blocks`, `positions`, `landed.json`.
- **CI.** Tests, plus a check that the results regenerate byte for byte, plus the Docker image running the same
  check and starting the QUIC sender.

## Data

`data/mainnet-beta/`:

- `snapshots/`: validators by client.
- `runs/<UTC start>/`: one live run, with the raw files listed above.
- `paths/`, `quic-test/`: delivery-path measurements. The QUIC feasibility data was produced once by
  `scripts/quic-feasibility.ts`, which is kept as a record and was written against an earlier API.
- `ledger.jsonl`: every reservation and settlement.
- `verify.json`: the last check against the chain.
- `results/`: generated by `analyze`.

## Commands

`node src/cli.ts help` lists them all.

| command | what it does |
|---|---|
| `reproduce` | the one-command check described above |
| `discover` | snapshot validators by client |
| `run [--live]` | the experiment. Options: `--path tpu\|rpc`, `--per-client`, `--per-validator`, `--deliveries`, `--seed`, `--minutes` |
| `collect [run\|all] [--refresh]` | landing slot, in-block position and slot leader; settles the ledger |
| `analyze` | all tables, offline |
| `verify [--verify-rpc URL]` | the check against the chain |
| `paths [--live]` | delivery-path probe |
| `keygen`, `address`, `status`, `fund`, `sweep` | wallet and budget |
