// Token Launch Radar — the model.
//
// One sealed DefiLlama snapshot in, one ranked board out. The board ranks protocols that record
// no token yet by an implied value: what a token would plausibly be worth if it were issued
// against the record the snapshot shows. Every number in the model is derived from the
// snapshot's own figures — nothing is keyed to a protocol's name.
//
//   implied = TVL x category multiple x growth factor x maturity factor x reach factor
//
// - category multiple: what the market actually pays for a dollar of TVL in this protocol's
//   category, measured inside the snapshot itself. For every category, take the protocols
//   whose token already trades, compute market cap / TVL for each, and use the median,
//   shrunk toward the global median by the peer count so a thin category cannot shout.
//   A category with no trading peers falls back to the global median.
// - growth factor: the protocol's own 7-day TVL change, clamped, so a hot week lifts the
//   value and a bleeding one discounts it — momentum, not hope.
// - maturity factor: how long DefiLlama has tracked the protocol with no token issued.
//   A long, token-less track record is the radar's whole premise: it earns a premium that
//   saturates at three years.
// - reach factor: a small premium per extra chain served, capped — a protocol live on five
//   chains launches to a wider first market than a single-chain one.
//
// Protocols whose token already trades never enter the ranked board: they are carried apart
// as the live set, shown at the market's own values, and they are what calibrates the model.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const MODEL_VERSION = 'radar-2';

/** The model's constants, stated on the dashboard so a reader can re-derive every row. */
export const MODEL = {
  /** Peers a category median is blended with the global median: mult = (n*median + k*global)/(n+k). */
  shrink_k: 8,
  /** Category multiples are clamped to this band before use. */
  multiple_min: 0.04,
  multiple_max: 2.5,
  /** 7-day TVL change (per cent) is clamped to this band before it moves the value. */
  growth_floor_pct: -50,
  growth_cap_pct: 150,
  /** growth factor = 1 + clamped_pct/100 * growth_weight. */
  growth_weight: 0.4,
  /** maturity factor runs from maturity_base (brand new) to maturity_base + maturity_span (3+ years). */
  maturity_base: 0.78,
  maturity_span: 0.44,
  maturity_days: 1095,
  /** A protocol whose listing day the snapshot does not carry is scored at this maturity factor. */
  maturity_unknown: 0.95,
  /** reach factor = 1 + reach_per_chain * min(extra chains, reach_max_extra). */
  reach_per_chain: 0.04,
  reach_max_extra: 5,
} as const;

const DAY_MS = 86_400_000;

/** A whole day count from listed_at to as_of, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories that are a wrapped, staked or bridged product of someone else's token, or an exchange. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** A name ending in a release marker is a later version of a protocol, not a fresh launch candidate. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product in a protocol's name. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that open with an exchange's name are that exchange's product, not an independent launch. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a pre-token protocol is a launch candidate in its own right: not a wrapped, staked or
 * bridged product of a token that already trades, not an exchange shelf, not a versioned rerun.
 * The snapshot's watchlist was built by the house's version of this rule, so every watchlist
 * protocol passes it; the filter only shapes the early rows below the floor.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** One category's calibration: how the snapshot's own trading peers price a dollar of TVL. */
export interface CategoryStat {
  category: string;
  protocols: number;
  pre_token: number;
  trading_peers: number;
  /** Median market cap / TVL among the category's trading protocols; null when none trade. */
  peer_median_ratio: number | null;
  /** The multiple the model uses for this category, after shrinkage toward the global median. */
  multiple: number;
}

/** Calibration measured from the snapshot: a multiple per category, plus the global fallback. */
export interface Calibration {
  global_median_ratio: number;
  trading_protocols: number;
  by_category: Map<string, CategoryStat>;
}

/** Measure how the market prices TVL, category by category, from the protocols that already trade. */
export function calibrate(snapshot: Snapshot): Calibration {
  const ratiosByCategory = new Map<string, number[]>();
  const counts = new Map<string, { total: number; pre: number }>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    const key = p.category ?? 'Uncategorized';
    const c = counts.get(key) ?? { total: 0, pre: 0 };
    c.total += 1;
    if (isPreToken(p)) c.pre += 1;
    counts.set(key, c);
    if (!isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      const ratio = p.mcap_usd / p.tvl_usd;
      allRatios.push(ratio);
      const list = ratiosByCategory.get(key) ?? [];
      list.push(ratio);
      ratiosByCategory.set(key, list);
    }
  }
  const globalMedian = allRatios.length > 0 ? median(allRatios) : 0.25;
  const byCategory = new Map<string, CategoryStat>();
  for (const [key, c] of counts) {
    const ratios = ratiosByCategory.get(key) ?? [];
    const peerMedian = ratios.length > 0 ? median(ratios) : null;
    const shrunk =
      peerMedian === null
        ? globalMedian
        : (ratios.length * peerMedian + MODEL.shrink_k * globalMedian) / (ratios.length + MODEL.shrink_k);
    byCategory.set(key, {
      category: key,
      protocols: c.total,
      pre_token: c.pre,
      trading_peers: ratios.length,
      peer_median_ratio: peerMedian === null ? null : round4(peerMedian),
      multiple: round4(clamp(shrunk, MODEL.multiple_min, MODEL.multiple_max)),
    });
  }
  return { global_median_ratio: round4(globalMedian), trading_protocols: allRatios.length, by_category: byCategory };
}

/** The full scoring of one protocol: the implied value and every factor that produced it. */
export interface Score {
  implied: number;
  category_multiple: number;
  trading_peers: number;
  growth_pct: number;
  growth_factor: number;
  maturity_factor: number;
  reach_factor: number;
  age: number | null;
}

/** Score one pre-token protocol against the calibration. The same function scores every row. */
export function score(p: SnapshotProtocol, asOf: string, calibration: Calibration): Score {
  const stat = calibration.by_category.get(p.category ?? 'Uncategorized');
  const multiple = stat?.multiple ?? calibration.global_median_ratio;
  const growthPct = clamp(p.change_7d ?? 0, MODEL.growth_floor_pct, MODEL.growth_cap_pct);
  const growthFactor = 1 + (growthPct / 100) * MODEL.growth_weight;
  const age = ageDays(asOf, p.listed_at);
  const maturityFactor =
    age === null
      ? MODEL.maturity_unknown
      : MODEL.maturity_base + (Math.min(age, MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_span;
  const reachFactor = 1 + MODEL.reach_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.reach_max_extra);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthFactor * maturityFactor * reachFactor));
  return {
    implied,
    category_multiple: multiple,
    trading_peers: stat?.trading_peers ?? 0,
    growth_pct: growthPct,
    growth_factor: round4(growthFactor),
    maturity_factor: round4(maturityFactor),
    reach_factor: round4(reachFactor),
    age,
  };
}

// ---------------------------------------------------------------------------
// Farm plans. Each plan is derived from the protocol's own record — its
// category's playbook, its first chain's fee tier, a capital size from its
// TVL, and a program length from its age — never from a list of names.
// ---------------------------------------------------------------------------

type ChainClass = 'ethereum' | 'low-fee' | 'solana' | 'mid-fee';

const LOW_FEE_CHAINS = new Set([
  'Arbitrum', 'Base', 'Optimism', 'Polygon', 'Polygon zkEVM', 'Scroll', 'Linea', 'zkSync Era',
  'Starknet', 'Mantle', 'Blast', 'Mode', 'Taiko', 'Manta', 'Metis', 'Fraxtal', 'Celo', 'Gnosis',
  'World Chain', 'Ink', 'Unichain', 'Soneium', 'Abstract', 'Boba', 'Moonbeam', 'Moonriver', 'Aurora',
]);

/** The fee tier of a chain: what one on-chain action roughly costs there. */
function chainClass(chain: string): ChainClass {
  if (chain === 'Ethereum') return 'ethereum';
  if (chain === 'Solana') return 'solana';
  if (LOW_FEE_CHAINS.has(chain)) return 'low-fee';
  return 'mid-fee';
}

const ACTION_GAS: Record<ChainClass, string> = {
  ethereum: '$8–20 of ETH gas per action at typical mainnet fees',
  'low-fee': 'under $0.60 of gas per action at typical fees',
  solana: 'about $0.05 of SOL in fees per action',
  'mid-fee': '$0.20–1.50 of gas per action at typical fees',
};

const WEEKLY_GAS: Record<ChainClass, string> = {
  ethereum: 'about $10 a week in gas if every action stays on mainnet, less if the app routes through its cheaper chain',
  'low-fee': 'about $1 a week in gas',
  solana: 'well under $0.50 a week in fees',
  'mid-fee': 'about $2 a week in gas',
};

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 2_000_000_000) return 500;
  if (tvl >= 500_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 25_000_000) return 100;
  return 50;
}

/** How many weeks to run the program, from the protocol's age: younger protocols qualify longer. */
function weeksFor(age: number | null): number {
  if (age === null) return 8;
  if (age < 180) return 10;
  if (age < 365) return 8;
  return 6;
}

interface Playbook {
  open: (name: string, chain: string, capital: number) => string;
  deepen: (name: string, chain: string, capital: number) => string;
}

/** The category playbooks: the core position and the second, deepening action for each kind of protocol. */
function playbookFor(category: string | null): Playbook {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return {
      open: (n, ch, cap) => `Supply $${cap} of USDC (or ETH, if the market list prefers it) as collateral on ${n} on ${ch}, in the largest market so the position counts from day one`,
      deepen: (n, ch, cap) => `Borrow no more than 40% of the supplied value and re-supply it once on ${n}: one loop deepens the activity record without turning the farm into a leverage bet`,
    };
  }
  if (c.includes('dex')) {
    return {
      open: (n, ch, cap) => `Add $${cap} of liquidity to the deepest USDC or ETH pool on ${n} on ${ch}, split evenly on both sides of the pair`,
      deepen: (n, ch, cap) => `Route one real swap a week through ${n} itself rather than an aggregator, sized $25–50, so the wallet builds a trading history as well as a liquidity one`,
    };
  }
  if (c.includes('deriv') || c.includes('perpetual') || c.includes('option')) {
    return {
      open: (n, ch, cap) => `Deposit $${cap} of USDC as margin on ${n} and open one small position hedged with an opposite spot holding, so the farm earns activity without directional risk`,
      deepen: (n, ch, cap) => `Trade a little every week on ${n} — open and close a small position rather than churning — aiming for steady cumulative volume, not a single big day`,
    };
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return {
      open: (n, ch, cap) => `Deposit $${cap} into the flagship vault on ${n} on ${ch} — the vault with the most deposits, since curator programs reward the main vaults first`,
      deepen: (n, ch, cap) => `Split a second, smaller deposit across one more vault or curator on ${n}, so the wallet shows up in more than one of its reward lists`,
    };
  }
  if (c.includes('yield')) {
    return {
      open: (n, ch, cap) => `Deposit $${cap} of USDC or ETH into the main vault on ${n} on ${ch} and keep the vault shares in the same wallet`,
      deepen: (n, ch, cap) => `Restake or re-deposit the vault shares where ${n} integrates with a partner protocol, only if the shares stay withdrawable within a week`,
    };
  }
  if (c.includes('basis')) {
    return {
      open: (n, ch, cap) => `Deposit $${cap} of USDC into the basis vault on ${n} on ${ch} and hold the shares: the yield is the record here, not trading`,
      deepen: (n, ch, cap) => `Add a small top-up deposit every two weeks on ${n} so the wallet's balance history trends up instead of sitting flat`,
    };
  }
  if (c.includes('rwa')) {
    return {
      open: (n, ch, cap) => `Mint $${cap} of the yield-bearing asset on ${n} on ${ch} after finishing its onboarding or allowlist step, and hold the asset in the farming wallet`,
      deepen: (n, ch, cap) => `Use the minted asset where ${n} lists an integration — as collateral or in a pool — once, so the wallet touches the wider product, not only the mint`,
    };
  }
  if (c.includes('leveraged')) {
    return {
      open: (n, ch, cap) => `Supply $${cap} on ${n} on ${ch} and lever it no more than 2x: beyond that, a normal market move liquidates the position and the whole farm with it`,
      deepen: (n, ch, cap) => `Rebalance the position weekly on ${n} back to the same leverage, and keep a written liquidation price in the farm log`,
    };
  }
  if (c.includes('prediction')) {
    return {
      open: (n, ch, cap) => `Fund the account on ${n} with $${cap} and take one small position in its most liquid market`,
      deepen: (n, ch, cap) => `Take one position a week on ${n} in markets you can actually judge, and let positions settle rather than selling out early`,
    };
  }
  if (c.includes('insurance')) {
    return {
      open: (n, ch, cap) => `Buy $${cap} of cover on ${n} for a position you already hold elsewhere, so the premium buys both protection and the activity record`,
      deepen: (n, ch, cap) => `Renew the cover on ${n} when it lapses instead of letting the wallet go quiet, and stake a small amount in its capital pool only if withdrawals are under a week`,
    };
  }
  if (c.includes('staking')) {
    return {
      open: (n, ch, cap) => `Stake $${cap} worth of the chain's native asset through ${n} on ${ch} and keep the staking receipt in the same wallet`,
      deepen: (n, ch, cap) => `Use the staking receipt once in a lending or liquidity market that ${n} lists as a partner, so the wallet earns a second protocol's record too`,
    };
  }
  return {
    open: (n, ch, cap) => `Deposit $${cap} of USDC into ${n}'s core product on ${ch} — the one its own front page leads with — and keep the position open`,
    deepen: (n, ch, cap) => `Use one more feature of ${n} beyond the deposit (a second pool, a vote, or its partner integration) so the wallet's history is not a single transaction`,
  };
}

/** A step as one string: the action, then its cost and its time, inside the gate's 20..600 characters. */
function stepText(action: string, cost: string, time: string): string {
  let s = `${action}. Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and log it.`;
  return s;
}

/** One protocol's farm plan: six steps, each an action with a cost and a time, from its own record. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const cls = chainClass(chain);
  const capital = capitalFor(p.tvl_usd);
  const weeks = weeksFor(age);
  const play = playbookFor(p.category);
  const multi = p.chains.length > 1 ? ` It also runs on ${p.chains[1]}${p.chains.length > 2 ? ` and ${p.chains.length - 2} more chain${p.chains.length > 3 ? 's' : ''}` : ''}, where fees may be lower` : '';
  return [
    stepText(
      `Set up a fresh wallet for ${p.name} alone, write its seed phrase on paper, and fund it only with what this farm needs; never farm from a wallet that holds your main assets`,
      'no fee beyond the wallet itself',
      '10 minutes, once',
    ),
    stepText(
      `Move $${capital + 50} of USDC to ${chain} — directly from an exchange if it supports the chain, otherwise bridge from Ethereum — and keep $${capital} for the position and the rest for fees.${multi}`,
      `${ACTION_GAS[cls]}, plus a bridge fee of $1–6 if you bridge`,
      '15 minutes, once',
    ),
    stepText(play.open(p.name, chain, capital), `${ACTION_GAS[cls]}; the $${capital} stays in the position`, '15 minutes to set up'),
    stepText(play.deepen(p.name, chain, capital), `${ACTION_GAS[cls]} per action`, '10 minutes, from week 2'),
    stepText(
      `Repeat one qualifying action every week for ${weeks} weeks — a deposit, a swap, a vote or a claim — so the wallet appears in many weekly snapshots of ${p.name}'s activity, not one`,
      `${WEEKLY_GAS[cls]}`,
      `10 minutes a week for ${weeks} weeks`,
    ),
    stepText(
      `Every Sunday, check ${p.name}'s own app for a points or rewards page and claim only from inside that app — never from a link in a message or a search ad. Unwind if its TVL falls by a third in a week, if the team announces a token with a snapshot already taken, or when the ${weeks}-week program ends; log every transaction in a farm note as you go`,
      'no fee to check; never pay anyone to "unlock" a claim',
      '10 minutes a week, ongoing',
    ),
  ];
}

// ---------------------------------------------------------------------------
// The board and the dashboard's data.
// ---------------------------------------------------------------------------

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    trading_peers: number;
    growth_pct: number;
    growth_factor: number;
    maturity_factor: number;
    reach_factor: number;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so it is shown at the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
  symbol: string | null;
}

/** Everything the dashboard renders: the board, the live set, the calibration and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: {
    shrink_k: number;
    growth_weight: number;
    growth_floor_pct: number;
    growth_cap_pct: number;
    maturity_base: number;
    maturity_span: number;
    reach_per_chain: number;
    global_median_ratio: number;
    trading_protocols: number;
  };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  universe_size: number;
  categories: CategoryStat[];
  rows: BoardRow[];
  live: LiveRow[];
}

/** How many live-token protocols the comparison view carries, by market cap. */
export const LIVE_ROWS = 30;

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, calibration: Calibration): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => watch.has(p.slug) || isLaunchCandidate(p));
  const scored = chosen.map((p) => ({ p, s: score(p, snapshot.as_of, calibration) }));
  scored.sort(
    (a, b) =>
      b.s.implied - a.s.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: s.age,
    token_status: 'pre-token' as const,
    watchlist: watch.has(p.slug),
    implied_value_usd: s.implied,
    model: {
      category_multiple: s.category_multiple,
      trading_peers: s.trading_peers,
      growth_pct: s.growth_pct,
      growth_factor: s.growth_factor,
      maturity_factor: s.maturity_factor,
      reach_factor: s.reach_factor,
    },
    farm_steps: farmSteps(p, s.age),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's comparison view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      symbol: p.symbol,
    }));
}

/** Everything the entry writes, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibrate(snapshot);
  const board = buildBoard(snapshot, calibration);
  const live = liveRows(snapshot);
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: {
      shrink_k: MODEL.shrink_k,
      growth_weight: MODEL.growth_weight,
      growth_floor_pct: MODEL.growth_floor_pct,
      growth_cap_pct: MODEL.growth_cap_pct,
      maturity_base: MODEL.maturity_base,
      maturity_span: MODEL.maturity_span,
      reach_per_chain: MODEL.reach_per_chain,
      global_median_ratio: calibration.global_median_ratio,
      trading_protocols: calibration.trading_protocols,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: live.length,
    universe_size: snapshot.protocols.length,
    categories: [...calibration.by_category.values()].sort((a, b) => (a.category < b.category ? -1 : 1)),
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, farm steps, values. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `row ${i} carries rank ${r.rank}`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${r.slug} outranks the row above it on implied value`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
