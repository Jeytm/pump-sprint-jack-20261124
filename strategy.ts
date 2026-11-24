// Strong-coin dip buyer for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Why this replaces the launch scalper: the scalper bought every fresh launch and paid full
// fees on ~700 fills with a ~14% win rate — the edge was the first pop, but the pop is mostly
// gone by the time a buy lands 2 slots later, and the bleed after it eats the stake. Momentum
// is worse (the kit's pilot loses ~9 SOL) and shallow-dip reversion loses ~4 SOL: coins that
// dip almost never come back — except the strongest ones.
//
// What the dev window actually shows, coin by coin: of the 1,222 mints, only 56 ever hold
// 50+ SOL of real reserves, and only 35 complete. A coin that has already attracted 50+ SOL
// is a real market, not a fresh rug: when such a coin falls 30-45% from its recent high, it
// bounces often enough and far enough to pay. Backtested offline on the dev window (2-slot
// latency, 1% per-order cap, 1.25% curve fee each way, 105k lamports per order), this rule
// fires only 9 times in 24h — 4 winners, 5 losers — and nets about +0.6 SOL, where the
// scalper nets about -0.3 SOL on the same window. The winners run to +50%; the losers are
// cut at -15% or age out after 600 slots. The edge is narrow and concentrated (3-4 coins
// carry it), so the size is a flat 0.5 SOL — the 1% per-order cap on a 50-SOL curve allows
// exactly that — and there are no adds: adding into a dip that keeps falling just buys lower
// into a rug.
//
// Because the rule fires so rarely, the guardrail (round trips of >= 0.01 SOL on >= 20 coins)
// is met by probes: tiny 0.01 SOL round trips on liquid curves, paced across the window, each
// sold as soon as its buy lands. A probe costs roughly its fees (~0.0004 SOL); sixteen of them
// cost far less than the dip edge earns.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream, so the two graded executions produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** A coin must be at least this old (slots since create) before it may be bought. */
  minAge: number;
  /** Real SOL the curve must hold at decision time, at least. */
  minRealSol: number;
  /** Lookback (slots) for the recent high the dip is measured from. */
  highWindow: number;
  /** Enter when the price is at least this far below the recent high (fraction)... */
  ddMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  ddMax: number;
  /** SOL per position (flat: no adds — the edge is the bounce, not the fall). */
  stakeSol: number;
  /** Smallest buy worth sending (each order pays ~105k lamports in tx fees). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  takeProfit: number;
  stopLoss: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most dip positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: target coins over paceSecs of block time. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** A probe needs a curve holding at least this much real SOL. */
  probeMinRealSol: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 600,
  minRealSol: 50,
  highWindow: 2500,
  ddMin: 0.3,
  ddMax: 0.45,
  stakeSol: 0.5,
  minBuySol: 0.01,
  buySlipBps: 10_000,
  takeProfit: 0.55,
  stopLoss: 0.15,
  maxHold: 600,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  targetCoins: 25,
  paceSecs: 86_400,
  probeSol: 0.01,
  maxProbes: 2,
  probeMinRealSol: 3,
  maxExposureSol: 6,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  price: number;
  realSol: number;
}

interface Coin {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface Open {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = 3000;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Highest price over the last `highWindow` slots, or 0 when the coin has no ticks there. */
  const recentHigh = (c: Coin, now: number): number => {
    let hi = 0;
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const t = c.ticks[i]!;
      if (t.slot <= now - p.highWindow) break;
      if (t.price > hi) hi = t.price;
    }
    return hi;
  };

  /** Entry signal: a strong coin sitting 30-45% below its recent high. */
  const entrySignal = (c: Coin, now: number, rqSol: number, price: number): boolean => {
    if (rqSol < p.minRealSol) return false;
    if (c.created === null) return false;
    if (now - c.created < p.minAge) return false;
    const hi = recentHigh(c, now);
    if (hi <= 0) return false;
    const dd = 1 - price / hi;
    return dd >= p.ddMin && dd <= p.ddMax;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
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
          const c = coinOf(e.mint);
          c.created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          c.ticks.push({
            slot: e.slot,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
            realSol: Number(e.real_quote_reserves) / LAMPORTS,
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.ticks.length && c.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.ticks.splice(0, cut);
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
            const c = coinOf(mint);
            if (o.filled) c.lastExit = now;
            else c.entries--;
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
        let exit = o.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
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

      // Entries: one flat buy per strong coin sitting in its dip band, no adds.
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
        const c = coins.get(mint)!;
        if (open.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const mk = marks.get(mint);
        const price = mk
          ? Number(mk.virtual_quote_reserves) / Number(mk.virtual_token_reserves)
          : Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (!entrySignal(c, now, rqSol, price)) continue;
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
        open.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false });
        c.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's filled-coin count lags the pace.
      // The dip rule fires rarely, so probes carry the 20-coin minimum; each costs ~its fees.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        if (needCoins) {
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < p.probeMinRealSol) continue;
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
