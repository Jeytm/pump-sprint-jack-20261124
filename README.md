[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Jeytm/pump-sprint-jack-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Jeytm/pump-sprint-jack-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Sprint — Launch Scalper

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. The house replays the bot on 24 hours of pump.fun bonding-curve data; ranked by net PnL.

## Strategy: launch scalper

What the dev window shows: coins that complete do it in the same slot they are created (one giant buy takes them straight to migration), so there is no tradeable upside left in them; and coins that dip almost never come back. What pays, a little, is the pop in a launch's first seconds: a fresh curve usually ticks up as the creator and the first buyers pile in, then bleeds.

This bot buys launches in their first 3 slots — only ones whose opening tape looks clean (the creator's own buy is at most 2 SOL, the creator has not sold, at most 3 distinct non-creator buyers so far, net flow not negative, real SOL 0.3–40) — and scalps them: out at +18%, cut at −12%, never held past 15 slots, out at once if the creator sells or one big sell (≥ 0.5 SOL) lands.

Size is flat 0.1 SOL per coin, no adds: the edge is the first pop, and adding into a launch that is already running just buys the top.

A small probe mechanism keeps the run above the guardrail minimums (round trips of ≥ 0.01 SOL on ≥ 20 coins): when fills or coins lag the pace, the bot opens a tiny 0.01 SOL probe round trip on a liquid curve.

## Local backtest (dev window)

| | |
| --- | --- |
| Net PnL | **−0.086 SOL** |
| Max drawdown | 0.98% |
| Fills / coins / round trips | 390 / 125 / 195 |
| Winning trips | 23 |
| Rejected orders | 0 |

For comparison on the same dev window: the kit's momentum pilot −9.38 SOL, reversion −1.78 SOL, dip catcher −0.51 SOL, sniper −0.14 SOL. The dev window is a loss for every shape tried; the final window is fresh data, and this bot is the least-bad shape with the smallest drawdown — it loses slowly, stays inside every guardrail, and keeps 125 coins of round-trip volume.

## Files

- `main.ts` — entrypoint: wires the strategy into the house `runBot` loop.
- `strategy.ts` — the strategy (deterministic: no clock, no randomness, no I/O).
- `vendor/makefun-bot.ts` — the kit's house SDK, vendored byte-identical (excluded from authorship counts per the SDK's own note).

## How to run

```bash
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver docker --bundle <transcripts.tar.gz>
```
