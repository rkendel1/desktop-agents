# Compute main recordings

Real output of `compute` built from `rkendel1/compute` main (commit c389fcc, `compute 0.1.5`), recorded on Linux x86_64 with
`environment inspect --json`, `recipe list --json` and `recipe resolve --json`. `resolve-*.json` omit `runtime_distribution`,
`admission` and the placement `requirements`/`selection_policy` blocks, which Foundry does not read. The contract fixture
(`../../compute-contract.cjs`) is built from these files, so its JSON has Compute's shape, not one Foundry made up.
`resolve-unsatisfied.json` is the stock `examples/recipes/dev.json` on a host whose `this-machine` target offers no `terminal`.
