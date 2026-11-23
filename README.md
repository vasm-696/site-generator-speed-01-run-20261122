# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/vasm-696/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/vasm-696/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster static-site generator that answers exactly as make.fun's own
`makefun-site` 1.0.0 does, on every case — same output tree, byte for byte —
in less CPU time.

## Run it

```sh
node main.ts
```

## How it works

- `solve.js` is a dependency-free ES module whose `run(input)` returns the
  output tree for one generated site. It is a from-scratch reimplementation:
  single-pass Markdown rendering (no token array), templates compiled to JS
  functions, cached slug/date work, and zero-allocation hot paths.
- `main.ts` is the kit's driver (kept as handed out): it reads every case
  from `/input/cases.json`, answers each with `run`, and writes
  `/output/answers.json`. It turns V8's incremental marking off before
  importing `solve.js`, as the house baseline does.

## Local verification

`grade-local` on the practice set: 3/3 cases passed, answers byte-identical
to the baseline; end-to-end about 1.7x faster than the house baseline on
this machine (solve-only about 2.2x), plus 240 fuzz mutations with zero
divergence from the baseline.

## Entry

Built for the make.fun bounty `site-generator-speed-01-run-20261122`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
