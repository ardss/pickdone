# PickDone Cloud Cost Model

Configuration-driven capacity & cost calculator for the paid E2EE sync line.
Pure Node (zero deps), read-only. Docs: `docs/sync-v2-cloud-capacity-economics.md`.

```bash
node tools/cost-model/cost-cli.mjs --scenario neutral   # pessimistic|neutral|heavy
node tools/cost-model/cost-cli.mjs --format json        # machine-readable + provenance
node tools/cost-model/cost-cli.mjs --quote              # refuses unless every price has a source
```

- `cost-model.mjs` — default config + pure `computeEconomics()` (all formulas).
- `scenarios.mjs` — named deep-partial usage patches.
- `price-source.mjs` — provenance audit: verified / assumption / missing / notModeled.
- `example-output.txt` — sample neutral-scenario report.

Prices are PUBLIC LIST transcriptions with `source.url` + `verifiedAt` (R2,
Workers, DigitalOcean, Hetzner, Creem, Paddle @ 2026-10-10). Assumption-class
entries (VPS instance, relay egress, DB volume) MUST be replaced with a sourced
quote before `--quote` passes. D1 row billing is deliberately NOT MODELED and
surfaces as a warning in every report.

Tests: `node --test tests/unit/cloud-cost/*.test.mjs`
