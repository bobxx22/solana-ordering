# Inside the block: how Solana validators order transactions

Status: work in progress.

This repository measures, on Solana mainnet, how block producers order transactions inside a block, and whether the
rule differs between validator clients (Agave and its forks, Firedancer and its forks). The primary evidence is our
own transactions, sent with controlled fees and send order; their positions are read back with `getBlock`.

## Safety

- Dry run is the default. Nothing is sent to mainnet without the explicit `--live` flag.
- Spending is capped in code: `SPEND_CAP_SOL` (default 0.05), and mainnet never goes above 0.05 SOL whatever the setting.
- Keys are files mounted from the host (`keys/`, git-ignored) and never enter the image or the repository.
  `keygen` prints only the public address.

## Quick start

Requires Node.js 24.11+ (no npm install: there are no dependencies) or Docker.

```bash
node src/cli.ts keygen        # creates keys/payer.json, prints the address
node src/cli.ts address       # address and balance
node src/cli.ts discover      # validators by client and stake -> data/snapshots/
npm test
```

With Docker:

```bash
docker compose run --rm ordering discover
```
