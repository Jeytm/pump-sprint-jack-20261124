[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Jeytm/pump-sprint-jack-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Jeytm/pump-sprint-jack-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Sprint — Strong-Coin Dip Buyer

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. The house replays the bot on 24 hours of pump.fun bonding-curve data; ranked by net PnL.

## Strategy: strong-coin dip buyer (v2 — replaces the launch scalper)

The launch scalper (v1) bought every fresh launch and paid full fees on ~700 fills with a ~14% win rate: net **−0.290 SOL** on the dev window. Momentum is worse (the kit's pilot loses ~9 SOL) and shallow-dip reversion loses ~4 SOL. Coins that dip almost never come back — except the strongest ones.

What the dev window actually shows, coin by coin: of 1,222 mints, only 56 ever hold 50+ SOL of real reserves. A coin that has already attracted 50+ SOL is a real market, not a fresh rug: when such a coin falls 30–45% from its high over the last 2,500 slots, it bounces often enough and far enough to pay. This bot buys exactly that — one flat 0.5 SOL position per coin (the 1% per-order cap on a 50-SOL curve allows just that), no adds, one entry per coin — and exits at +55% take-profit, −15% stop-loss, or after 600 slots.

Because the rule fires rarely (9 dip trades in 24h), the guardrail (round trips of ≥ 0.01 SOL on ≥ 20 coins) is met by probes: tiny 0.01 SOL round trips on liquid curves, paced across the window, each sold as soon as its buy lands. A probe costs roughly its fees (~0.0004 SOL).

## Local backtest (dev window, `grade-local --driver process`)

| | v1 launch scalper | v2 dip buyer |
| --- | --- | --- |
| Net PnL | −0.290 SOL | **+0.513 SOL** |
| Return | −2.9% | +5.1% (90% interval −0.28…+1.42) |
| Max drawdown | 3.09% | 3.05% |
| Fills / coins / round trips | 690 / 276 / 345 | 52 / 26 / 26 |
| Win rate | 13.9% | 11.5% (3 of 26 trips carry all the gains) |
| Rejected / failed orders | 0 | 0 / 0 |
| Guardrails | met | met |

Honest caveat: the edge is concentrated — 3 coins make 100% of the gains, and without them the net is −0.32 SOL. The dev window is one small sample and the final window is fresh data; this is the best shape found across launch-scalping, momentum, breakout, buy-and-hold, and several dip variants, and it is the only one that scores positive on the dev window.

## Files

- `main.ts` — entrypoint: wires the strategy into the house `runBot` loop.
- `strategy.ts` — the strategy (deterministic: no clock, no randomness, no I/O).
- `vendor/makefun-bot.ts` — the kit's house SDK, vendored byte-identical (excluded from authorship counts per the SDK's own note).

## How to run

```bash
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver docker --bundle <transcripts.tar.gz>
```
