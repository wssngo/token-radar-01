# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/wssngo/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/wssngo/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot of 758 protocols, ranks the ones that record no token yet by an implied launch value, and gives each a concrete farm plan. The value model is calibrated from the snapshot itself — each category's multiple is the median market-cap/TVL of that category's already-trading protocols, shrunk toward the global median — then adjusted by the protocol's own 7-day TVL growth, how long it has run with no token, and how many chains it serves. The dashboard is a static page (no network, no framework): a sortable, filterable board, a per-protocol detail view showing the pricing arithmetic and the farm plan, and an "Already trading" view of the protocols that calibrate the model.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18 or later, standard library only. The run writes `board.json` (the ranked board), `data.js` (the dashboard's dataset), `dashboard/`, `screenshots/` and `dossier.json` into the output directory. Open `dashboard/index.html` from the output directory in a browser to use the radar.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1zajvgzz&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
