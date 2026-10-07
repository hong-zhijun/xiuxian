/**
 * 灵股行情（docs/灵股行情开发计划.md）——纯定义与纯计算。
 *
 * 系统坐庄：价格由「种子 + 时间」确定性算出，不写库、可复算；种子存在数据库里（不在代码里），
 * 所以拿到开源代码也推算不出未来价格。本文件不读库、不取时间。
 *
 * 价格单位：最小单位灵石（1 灵石 = 1000）；时间：UTC 毫秒，行情按分钟取（minute = floor(ms / 60000)）。
 */

export const MARKET_UNLOCK_SECT_LEVEL = 3;
/** 每笔手续费（基点，30 = 0.3%），向上取整。 */
export const MARKET_FEE_BP = 30;
/** 买入后这么久内不能卖出这支股票。 */
export const MARKET_HOLD_MS = 10 * 60_000;
/** 每天成交笔数上限（买卖合计）。 */
export const MARKET_DAILY_TRADES = 30;
/** 每支股票的持仓成本上限 = 灵石容量 × 20%。 */
export const MARKET_POSITION_CAP_BP = 2000;
/** 一笔最多多少股。 */
export const MARKET_MAX_SHARES_PER_TRADE = 100_000;
/** 行情一跳的时长。 */
export const MARKET_TICK_MS = 60_000;

const MINUTE = 1;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface StockDef {
  id: string;
  name: string;
  /** 代码（界面上的小字）。 */
  code: string;
  sector: string;
  description: string;
  /** 基准价（展示单位灵石）：价格长期围着它波动。 */
  basePrice: number;
  /** 波动幅度（对数价格的缩放）。 */
  volatility: number;
}

export const STOCKS: readonly StockDef[] = [
  { id: 'tiangong', name: '天工坊', code: 'TGF', sector: '炼器', description: '天下兵甲半出其炉，接朝廷与各大宗门的炼器订单。', basePrice: 48, volatility: 0.26 },
  { id: 'baicao', name: '百草堂', code: 'BCT', sector: '药材', description: '灵药种植与收购的老字号，药材行情的风向标。', basePrice: 22, volatility: 0.22 },
  { id: 'lingkuang', name: '灵矿商会', code: 'LKS', sector: '矿石', description: '把持北境数座灵矿，矿石产量看天也看人。', basePrice: 35, volatility: 0.28 },
  { id: 'zhenyao', name: '镇妖司', code: 'ZYS', sector: '战斗', description: '承接斩妖除魔的悬赏，妖潮一来便是大起大落。', basePrice: 60, volatility: 0.4 },
  { id: 'yunlai', name: '云来商号', code: 'YLS', sector: '贸易', description: '坊市里最大的商号，生意稳当，涨跌都慢。', basePrice: 15, volatility: 0.15 },
  { id: 'juling', name: '聚灵阁', code: 'JLG', sector: '灵气', description: '经营聚灵阵法与灵气储运，修士人人离不开。', basePrice: 80, volatility: 0.3 },
];

export function findStock(stockId: string): StockDef | undefined {
  return STOCKS.find((stock) => stock.id === stockId);
}

/* ---------- 哈希与噪声 ---------- */

/** 字符串 → 32 位种子（FNV-1a）。 */
export function seedNumberOf(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 多个整数 → [0, 1) 的确定性随机数（整数混合，跨平台一致）。 */
function hash01(seed: number, ...parts: number[]): number {
  let h = seed ^ 0x9e3779b9;
  for (const part of parts) {
    h = Math.imul(h ^ (part | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4_294_967_296;
}

/** 平滑值噪声：每 period 分钟一个随机锚点（-1～1），中间平滑插值。 */
function valueNoise(seed: number, channel: number, minute: number, period: number): number {
  const x = minute / period;
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(seed, channel, i) * 2 - 1;
  const b = hash01(seed, channel, i + 1) * 2 - 1;
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

/** 五层噪声的周期与权重（周 / 日 / 4 小时 / 45 分钟 / 5 分钟）。 */
const OCTAVES: readonly { period: number; weight: number }[] = [
  { period: 7 * DAY, weight: 0.5 },
  { period: DAY, weight: 0.35 },
  { period: 4 * HOUR, weight: 0.25 },
  { period: 45 * MINUTE, weight: 0.12 },
  { period: 5 * MINUTE, weight: 0.05 },
];
/** 全市场共同噪声（指数联动）占个股波动的比例。 */
const MARKET_WIDE_WEIGHT = 0.35;
/** 每分钟的微小抖动（对数，±0.15%）：抖动彼此独立，低买高卖最多 0.3%，小于来回 0.6% 手续费，脚本吃不到。 */
const TICK_JITTER = 0.0015;

function layeredNoise(seed: number, channel: number, minute: number): number {
  let total = 0;
  OCTAVES.forEach((octave, index) => {
    total += octave.weight * valueNoise(seed, channel * 16 + index, minute, octave.period);
  });
  return total;
}

/* ---------- 坊间消息 ---------- */

/** 消息按 3 小时一段生成，每段 70% 概率出一条。 */
export const NEWS_SLOT_MINUTES = 3 * HOUR;
const NEWS_CHANCE = 0.7;
/** 属实的概率。 */
const NEWS_TRUTH_CHANCE = 0.75;
/** 影响曲线：公布后延迟、走出来的时长（2～4 小时随机）、维持、回落。 */
const NEWS_DELAY = 5 * MINUTE;
const NEWS_PLATEAU = 6 * HOUR;
const NEWS_DECAY = 12 * HOUR;
const NEWS_MAX_RAMP = 4 * HOUR;
/** 往回看多少段消息就够覆盖全部影响。 */
const NEWS_LOOKBACK_SLOTS = Math.ceil((NEWS_DELAY + NEWS_MAX_RAMP + NEWS_PLATEAU + NEWS_DECAY + NEWS_SLOT_MINUTES) / NEWS_SLOT_MINUTES);

export interface MarketNews {
  id: string;
  /** 公布时刻（分钟）。 */
  minute: number;
  /** null = 全市场消息。 */
  stockId: string | null;
  /** 利好 1 / 利空 -1（字面方向）。 */
  direction: 1 | -1;
  title: string;
  /** 实际对对数价格的影响（属实 = 方向 × 强度；谣言 = 0 或小幅反向）。只在服务端用，不下发。 */
  effect: number;
  rampMinutes: number;
}

const NEWS_TEMPLATES: Readonly<Record<string, { up: readonly string[]; down: readonly string[] }>> = {
  tiangong: {
    up: ['天工坊接下皇朝一批兵甲大单', '天工坊新炉开炼，据说出了一柄仙品', '各大宗门扩军，兵器求购激增'],
    down: ['天工坊炉火失控，数座炼器炉停工', '坊间传出天工坊以次充好的流言', '玄铁短缺，炼器坊纷纷减产'],
  },
  baicao: {
    up: ['南疆大旱，灵药价格飞涨', '百草堂得了一张失传的丹方', '丹会将开，药材被各家抢购一空'],
    down: ['药园丰收，药材堆满仓库', '百草堂一批药材受潮霉变', '新药园大量开垦，药价恐将走低'],
  },
  lingkuang: {
    up: ['北境灵矿塌方，矿石或将紧缺', '灵矿商会探得一条新富矿', '炼器之风大盛，矿石供不应求'],
    down: ['灵矿商会新矿脉产量远超预期', '矿工罢工风波平息，矿石大批出货', '朝廷加征矿税，商会利润承压'],
  },
  zhenyao: {
    up: ['妖潮将至，各地悬赏暴涨', '镇妖司斩落一头化神大妖，声名大振', '边境妖兽异动，镇妖司急招人手'],
    down: ['妖患平息，悬赏大幅缩水', '镇妖司一支队伍折损于妖巢', '仙盟收回部分斩妖悬赏的发放权'],
  },
  yunlai: {
    up: ['云来商号打通东海商路', '坊市集会将开，各地商队云集', '云来商号拿下仙盟采买的大单'],
    down: ['东海风浪大作，商路暂断', '云来商号账房卷款潜逃的传言', '坊市新开数家商号，生意被分走'],
  },
  juling: {
    up: ['天地灵潮将至，聚灵阵订单爆满', '聚灵阁新阵法可让灵气产出翻倍', '突破之风盛行，灵气紧俏'],
    down: ['灵潮退去，聚灵阵乏人问津', '聚灵阁一处阵眼崩毁', '有宗门自研聚灵阵，聚灵阁订单流失'],
  },
  market: {
    up: ['仙盟颁布新令，坊市交易大活跃', '诸宗大比将至，各行各业都有生意', '天降祥瑞，坊间人心振奋'],
    down: ['妖潮迫近，坊间人心惶惶', '仙盟清查各大商号账目', '数位大能闭关，坊市一片冷清'],
  },
};

/** 第 slot 段的消息（没有返回 null）；确定性。 */
export function newsOfSlot(seed: number, slot: number): MarketNews | null {
  if (hash01(seed, 7001, slot) >= NEWS_CHANCE) return null;
  const stockRoll = hash01(seed, 7002, slot);
  // 15% 是全市场消息，其余均分给 6 支股票。
  const stock = stockRoll < 0.15 ? null : STOCKS[Math.min(STOCKS.length - 1, Math.floor(((stockRoll - 0.15) / 0.85) * STOCKS.length))]!;
  const direction: 1 | -1 = hash01(seed, 7003, slot) < 0.5 ? 1 : -1;
  const strength = 0.06 + hash01(seed, 7004, slot) * 0.12;
  const truthful = hash01(seed, 7005, slot) < NEWS_TRUTH_CHANCE;
  // 谣言：一半不应验，一半小幅反向。
  const effect = truthful ? direction * strength : hash01(seed, 7006, slot) < 0.5 ? 0 : -direction * strength * 0.3;
  const minute = slot * NEWS_SLOT_MINUTES + Math.floor(hash01(seed, 7007, slot) * (NEWS_SLOT_MINUTES - 30));
  const rampMinutes = 2 * HOUR + Math.floor(hash01(seed, 7008, slot) * 2 * HOUR);
  const templates = NEWS_TEMPLATES[stock?.id ?? 'market']!;
  const pool = direction > 0 ? templates.up : templates.down;
  const title = pool[Math.floor(hash01(seed, 7009, slot) * pool.length)] ?? pool[0]!;
  return { id: `news-${String(slot)}`, minute, stockId: stock?.id ?? null, direction, title, effect, rampMinutes };
}

/** 消息在某分钟的影响系数（0～1）：延迟 → 平滑走出来 → 维持 → 平滑回落。 */
function newsWeight(news: MarketNews, minute: number): number {
  const start = news.minute + NEWS_DELAY;
  if (minute <= start) return 0;
  const smooth = (x: number) => x * x * (3 - 2 * x);
  const rampEnd = start + news.rampMinutes;
  if (minute < rampEnd) return smooth((minute - start) / news.rampMinutes);
  const decayStart = rampEnd + NEWS_PLATEAU;
  if (minute < decayStart) return 1;
  const decayEnd = decayStart + NEWS_DECAY;
  if (minute < decayEnd) return 1 - smooth((minute - decayStart) / NEWS_DECAY);
  return 0;
}

/** 某分钟所有生效消息对这支股票的影响之和（对数）。 */
function newsEffectAt(seed: number, stockId: string, minute: number): number {
  const slot = Math.floor(minute / NEWS_SLOT_MINUTES);
  let total = 0;
  for (let s = slot - NEWS_LOOKBACK_SLOTS; s <= slot; s += 1) {
    const news = newsOfSlot(seed, s);
    if (news === null || news.minute > minute) continue;
    if (news.stockId !== null && news.stockId !== stockId) continue;
    total += news.effect * newsWeight(news, minute);
  }
  return total;
}

/** [fromMinute, toMinute] 之间已公布的消息（新的在前）。 */
export function newsBetween(seed: number, fromMinute: number, toMinute: number): MarketNews[] {
  const result: MarketNews[] = [];
  for (let s = Math.floor(toMinute / NEWS_SLOT_MINUTES); s >= Math.floor(fromMinute / NEWS_SLOT_MINUTES) - 1; s -= 1) {
    const news = newsOfSlot(seed, s);
    if (news !== null && news.minute >= fromMinute && news.minute <= toMinute) result.push(news);
  }
  return result.sort((a, b) => b.minute - a.minute);
}

/* ---------- 价格 ---------- */

/** 时间戳 → 行情分钟。 */
export function marketMinuteOf(ms: number): number {
  return Math.floor(ms / MARKET_TICK_MS);
}

/** 某支股票在某分钟的价格（最小单位，至少 1）。 */
export function stockPriceAt(seed: number, stock: StockDef, minute: number): number {
  const channel = STOCKS.indexOf(stock) + 1;
  const own = layeredNoise(seed, channel, minute);
  const marketWide = layeredNoise(seed, 99, minute);
  const jitter = (hash01(seed, channel, 5000, minute) * 2 - 1) * TICK_JITTER;
  const logPrice =
    Math.log(stock.basePrice) +
    stock.volatility * ((1 - MARKET_WIDE_WEIGHT) * own + MARKET_WIDE_WEIGHT * marketWide) +
    jitter +
    newsEffectAt(seed, stock.id, minute);
  return Math.max(1, Math.round(Math.exp(logPrice) * 1000));
}

/** 综合指数：各股相对基准价的几何平均 × 1000（展示用，不交易）。 */
export function marketIndexAt(seed: number, minute: number): number {
  let sum = 0;
  for (const stock of STOCKS) sum += Math.log(stockPriceAt(seed, stock, minute) / (stock.basePrice * 1000));
  return Math.round(Math.exp(sum / STOCKS.length) * 1000 * 100) / 100;
}

/* ---------- K 线 ---------- */

export type ChartRange = '1h' | '6h' | '1d' | '7d';

/** 各周期：根数 × 每根分钟数。 */
export const CHART_RANGES: Readonly<Record<ChartRange, { candles: number; minutes: number; label: string }>> = {
  '1h': { candles: 60, minutes: 1, label: '1 小时' },
  '6h': { candles: 72, minutes: 5, label: '6 小时' },
  '1d': { candles: 96, minutes: 15, label: '1 天' },
  '7d': { candles: 84, minutes: 120, label: '7 天' },
};

export interface Candle {
  /** 这根 K 线的起始时刻（毫秒）。 */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** 截至 nowMinute 的 K 线（最后一根可能是未走完的当前根）；高低价按每根内最多 30 个采样点算。 */
export function stockCandles(seed: number, stock: StockDef, nowMinute: number, range: ChartRange): Candle[] {
  const { candles, minutes } = CHART_RANGES[range];
  const lastStart = Math.floor(nowMinute / minutes) * minutes;
  const firstStart = lastStart - (candles - 1) * minutes;
  const step = Math.max(1, Math.floor(minutes / 30));
  const result: Candle[] = [];
  for (let start = firstStart; start <= lastStart; start += minutes) {
    const end = Math.min(start + minutes - 1, nowMinute);
    const open = stockPriceAt(seed, stock, start);
    let high = open;
    let low = open;
    for (let minute = start + step; minute <= end; minute += step) {
      const price = stockPriceAt(seed, stock, minute);
      if (price > high) high = price;
      if (price < low) low = price;
    }
    const close = stockPriceAt(seed, stock, end);
    result.push({ t: start * MARKET_TICK_MS, o: open, h: Math.max(high, close), l: Math.min(low, close), c: close });
  }
  return result;
}

/* ---------- 交易规则 ---------- */

/** 手续费（最小单位，向上取整，至少 1）。 */
export function marketFee(amount: number): number {
  if (amount <= 0) return 0;
  return Math.max(1, Math.ceil((amount * MARKET_FEE_BP) / 10_000));
}

/** 每支股票的持仓成本上限（最小单位）。 */
export function marketPositionCap(stoneCapacity: number): number {
  return Math.floor((Math.max(0, stoneCapacity) * MARKET_POSITION_CAP_BP) / 10_000);
}

/** 什么时候能卖（最近一次买入 + 10 分钟）。 */
export function marketSellableAt(lastBuyAt: number | null): number | null {
  return lastBuyAt === null ? null : lastBuyAt + MARKET_HOLD_MS;
}
