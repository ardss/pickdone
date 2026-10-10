# Sync v2 Cloud — Capacity & Economics Model (tools/cost-model)

Config-driven cost/capacity calculator for the paid E2EE sync hosting line.
Pure Node, zero dependencies, read-only. Companion doc:
`docs/sync-v2-cloud-control-plane.md` (architecture + safety boundaries).

## Run

```bash
# from pickdone/
node tools/cost-model/cost-cli.mjs                          # neutral table
node tools/cost-model/cost-cli.mjs --scenario heavy         # pessimistic|neutral|heavy
node tools/cost-model/cost-cli.mjs --format json            # machine-readable
node tools/cost-model/cost-cli.mjs --mau 50000 --growth 0.03
node tools/cost-model/cost-cli.mjs --config my-prices.json  # deep-merged over defaults
node tools/cost-model/cost-cli.mjs --quote                  # refuses unless every price has a source
```

Unit tests: `node --test tests/unit/cloud-cost/*.test.mjs` (24 specs).
Sample output: `tools/cost-model/example-output.txt`.

## Price provenance rules (hard)

Every price is `{ value, unit, source: { url, verifiedAt } }` and is audited into:

| class       | meaning                                                        | quotable |
|-------------|----------------------------------------------------------------|----------|
| `verified`  | real http(s) URL + `YYYY-MM-DD` verification date              | yes      |
| `assumption`| source declares `ASSUMPTION:` / date `UNSET`                   | NEVER    |
| `missing`   | no usable source                                               | invalid config |
| `notModeled`| `value: null` on purpose — excluded from totals, listed as warning | n/a  |

Verified entries currently carried (PUBLIC LIST transcriptions, verified
2026-10-10 — NOT our contracted rates, editable in `defaultConfig()`):

- Cloudflare R2 Standard storage $0.015/GB-mo, Class A $4.50/M, Class B $0.36/M,
  egress $0 — https://developers.cloudflare.com/r2/pricing/
- Workers Paid $5/mo minimum — https://developers.cloudflare.com/workers/platform/pricing/
  (OPTIONAL control plane only; the Node relay CANNOT run on Workers)
- DigitalOcean Basic droplet from $6/mo — https://www.digitalocean.com/pricing/droplets/
- Hetzner CX23 from $6.49/mo excl. IPv4+tax — https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- Creem 3.9% + $0.40 — https://www.creem.io/pricing/
- Paddle 5% + $0.50 — https://www.paddle.com/pricing

`--quote` exit code 3 = refused (assumptions/missing sources present). No
unprovenanced number may ever reach a pricing page, investor doc, or customer.

## Units

bytes/GB decimal (1 GB = 1e9 B) · month = 30.44 d · money = `config.currency`
(default USD list-price transcription) · fees as fraction of revenue.

## Model shape (matches the MVP cloud decision)

- **Compute** = the EXISTING Node relay (Node HTTP + better-sqlite3/WAL,
  long-lived connections, `maxConnections` per process) on VPS/containers.
  `compute.instanceMonthly` is an ASSUMPTION the operator fills with a sourced
  VPS quote. Workers/D1 are an alternative data plane, priced nowhere by default.
- **DB track** = the relay's own SQLite volume: envelope rows + `rowOverheadBytesPerEnvelope`
  (serverSeq/opId/indexes) x replicas x WAL/page `volumeOverheadFactor`.
  D1 `rows_read/rows_written` billing: explicitly **NOT MODELED** (null price)
  — totals are flagged incomplete until a D1-based plan fills them.
- **Object track** = R2-style storage for encrypted snapshots + cold archive
  segments; Class A/B request fees apply here; R2 egress is $0 (verified).
- **Relay egress** = envelope pull fan-out over the relay's VPS network — a REAL
  cost (quota included per plan or per-GB), separate from R2 free egress.
- **Retention**: hot DB keeps `envelopeRetentionMonths` of envelopes (GC floor
  semantics from sync-relay.mjs bound this in production); cold archive keeps
  `coldArchiveMonths` more (packed, no row overhead); snapshots per tier
  (`generationsFree`/`generationsPaid`).

## Output definitions

| metric | definition |
|---|---|
| per-user pure variable | storage + network lines for ONE user of that tier |
| fully loaded           | + computeCost / MAU share |
| net revenue per payer  | gross x (1-refund) x (1-tax) |
| contribution per payer | net - payment fee - fully-loaded paid variable |
| break-even paid users  | ceil( (compute + fixed + freeUsers x free pure-variable) / contribution ) |
| growth month-12/36     | MAU x (1+g)^m, FULL steady-state storage = conservative upper bound (fresh cohorts over-counted) |
| sensitivity            | each input x0.5 / x2.0 -> totals move for cost prices; break-even moves for payment fee |
| scenarios              | pessimistic (0.5x paid share, 1.5x volume, 0.5x growth), heavy (3x volume, 2x payload, +1 device) |

## Stage NO-GO conditions

- **NG1 Quoting**: `--quote` fails (any assumption/missing source) → no external
  pricing may be published.
- **NG2 Not-modeled costs**: D1 row billing (or any future row-billed store) is
  required for the chosen data plane and still null → totals are not complete;
  no board-level cost claim.
- **NG3 Unit economics**: contribution per payer <= 0, or neutral break-even
  paid users exceeds the 12-month realistic paid base → re-price or cut fixed.
- **NG4 Plaintext hosting**: E2EE (Step 7 key hierarchy) not landed → TODAY the
  relay stores envelopeJson as PLAINTEXT strings ("opaque" = unparsed, NOT
  encrypted). Paid hosting must not open registration before E2EE.
- **NG5 Account model**: `account` is still a client-asserted free string in the
  relay (register is the only gate, softened by the enrollment secret) → no
  multi-tenant open registration until the control-plane account model lands.
- **NG6 Capacity**: relay egress overruns the included VPS quota
  (`quotaOverrunPct > 0`) or peak concurrent devices exceed
  `instances x connectionsPerInstance` without a scale-out runbook → pause growth.
- **NG7 Durability**: backup/restore drill not passed on the chosen storage →
  no paid tier (the free-tier promise is "data is never deleted").
