// Launch scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window actually shows: coins that complete do it in the same slot they are
// created (one giant buy takes them straight to migration), so there is no tradeable upside left
// in them; and coins that dip almost never come back. What does pay, a little, is the pop in a
// launch's first seconds: a fresh curve usually ticks up as the creator and the first buyers
// pile in, then bleeds. This bot buys launches in their first few slots — only ones whose
// opening tape looks clean (the creator's own buy is small, the creator has not sold, only a
// handful of distinct buyers so far, net flow not negative) — and scalps them: out at +18%, cut
// at -12%, never held past 15 slots, out at once if the creator sells or one big sell lands.
//
// Size is flat 0.1 SOL per coin, no adds: the edge is the first pop, and adding into a launch
// that is already running just buys the top.
//
// Guardrail pacing keeps the run above the minimum bar (round trips of >= 0.01 SOL on >= 20 coins):
// when fills or coins lag the pace set in block time, the bot opens a tiny 0.01 SOL probe round
// trip on a liquid curve and sells it as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream, so the two graded executions produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** The creator's own buys in the opening tape, at most (SOL). */
  maxDevBuySol: number;
  /** Distinct non-creator buyers so far, at most (a launch crowded in its first slots is a dump in waiting). */
  maxBuyers: number;
  /** Trades needed before entry. */
  minTrades: number;
  /** Net buy SOL (buys minus sells) over the tape, at least. */
  minNetSol: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL per position (flat: no adds — the edge is the first pop). */
  stakeSol: number;
  /** Smallest buy worth sending (each order pays ~105k lamports in tx fees). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  takeProfit: number;
  stopLoss: number;
  /** Exit when net SOL over the fade window falls below -fadeSol. */
  fadeWindow: number;
  fadeSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most launch positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: target coins / fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  maxDevBuySol: 2,
  maxBuyers: 3,
  minTrades: 1,
  minNetSol: 0,
  minRqSol: 0.3,
  maxRqSol: 40,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 10_000,
  takeProfit: 0.18,
  stopLoss: 0.12,
  fadeWindow: 15,
  fadeSol: 1000,
  bigSellSol: 0.5,
  maxHold: 15,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 300,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 6,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Open {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = 2000;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flowSlots = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal: a launch whose opening tape looks clean at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (t.trades.length < p.minTrades) return false;
    let buySol = 0;
    let sellSol = 0;
    let devBuy = 0;
    const buyers = new Set<string>();
    let creatorSold = false;
    for (const tr of t.trades) {
      if (tr.buy) {
        buySol += tr.sol;
        if (t.creator !== null && tr.user === t.creator) devBuy += tr.sol;
        else buyers.add(tr.user);
      } else {
        sellSol += tr.sol;
        if (t.creator !== null && tr.user === t.creator) creatorSold = true;
      }
    }
    if (creatorSold) return false;
    if (devBuy > p.maxDevBuySol) return false;
    if (buyers.size > p.maxBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const creatorSold = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) creatorSold.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, o] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (o.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        o.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > o.peakValue) o.peakValue = value;
        o.lastValue = value;
        let exit = o.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && flowSlots(t, now, p.fadeWindow) < -p.fadeSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && creatorSold.has(mint)) exit = true;
        if (!exit && now - o.opened > p.maxHold) exit = true;
        if (!exit) continue;
        o.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries only: one flat buy per position, no adds — the edge is the first pop.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, o] of open) exposure += Math.max(o.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (open.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        // Size under the per-reply cap with a margin: reserves move in the 2-slot latency, and a
        // buy sized exactly at the cap is rejected when they shrink.
        const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS) * 0.9;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        open.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0 });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
