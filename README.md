# csv-reader-speed-01-run-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/yuu078/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/yuu078/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast drop-in replacement for csv-reader 1.0.0, written from scratch: reads broken CSV files exactly as the reference does — same `{columns, rows, errors}` on every case — about 3.2× faster on the practice set (177 ms vs 559 ms median over 10.2 MB of CSV).

## Run it

```sh
node main.ts
```

`main.ts` is the driver the harness runs as `node /bot/main.ts`. It reads every case from `/input/cases.json`, answers each one on its own with `run` from `solve.js`, and writes the answers, in order, to `/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## How it is fast

The reference walks the text one character at a time and builds every field with per-character string concatenation. This implementation walks it with native scans instead:

- One regex exec finds the next separator (`,` / LF / CR) of an unquoted field, and the field is taken with a single `slice()`.
- Inside quotes, one regex exec finds the next quote or line break; the literal run between specials is sliced whole, and only `""` escapes and CR/LF normalisation take the slow path.
- Stray CRs, unterminated quotes, quote junk, and short/long rows follow the reference's policy exactly, including error order and the 1-based line each record starts on.

Nothing is cached between cases and no output is ever looked up: every case is parsed from scratch.

## Layout

- `solve.js` — the parser (dependency-free ES module, exports `run(input)`)
- `main.ts` — the driver
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=pd4x8eme&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
