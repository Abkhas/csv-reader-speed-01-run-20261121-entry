# csv-reader-speed-01-run-20261121-entry

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Abkhas/csv-reader-speed-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Abkhas/csv-reader-speed-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0: `solve.js` returns exactly what csv-reader returns for every `{text, header}`, and `main.ts` is the harness driver (reads `/input/cases.json`, writes `/output/answers.json`). About 4–7x faster than the baseline on `run()` CPU over the practice set, byte-identical on 6,069 differential checks (6 practice cases, 55 hand-built edge cases, 6,000 seeded fuzz cases, 8 large generator-shaped files).

Approach: most records are plain (no quotes, no stray CRs) and are parsed with one slice + `split(',')` per record instead of one step per character. Only a record whose line holds a quote or a stray CR takes the careful field-by-field path, which still moves in whole chunks (`indexOf` to the next delimiter, `slice` for the content). All csv-reader semantics are preserved: BOM, CRLF/LF, stray CRs, doubled quotes, CR/LF inside quotes read as LF, quote junk, unterminated quotes re-read as unquoted, short/long rows with their errors, and exact `{code, line, row}` error records.

## Run it

```sh
node main.ts
```

Node 22.18 or later. Reads `/input/cases.json`, writes `/output/answers.json` (`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in for those paths outside a container).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
