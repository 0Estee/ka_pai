/**
 * 确定性伪随机数生成器（xorshift32）
 *
 * 为什么不用 Math.random：
 *  1. 对局可完整复现（存一个种子就能重放整局）
 *  2. 自动对战模拟需要可控的随机源
 *  3. 未来做联机时，随机数可交由服务端下发
 *
 * 状态是一个 32 位无符号整数，可直接序列化进 GameState。
 */

const MASK = 0xffffffff;

export function createRng(seed = 0x9e3779b9) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9; // xorshift 的状态不能为 0
  return {
    get state() {
      return s;
    },
    set state(v) {
      s = (v >>> 0) || 0x9e3779b9;
    },
  };
}

/** 推进随机数状态并返回 [0,1) 的浮点数 */
export function nextFloat(rng) {
  let x = rng.state >>> 0;
  x ^= (x << 13) >>> 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0;
  x >>>= 0;
  rng.state = x;
  return (x >>> 0) / 4294967296;
}

/** 返回 [0, maxExclusive) 的整数 */
export function nextInt(rng, maxExclusive) {
  if (maxExclusive <= 0) return 0;
  return Math.floor(nextFloat(rng) * maxExclusive) % maxExclusive;
}

/** 以 probability 的概率返回 true */
export function chance(rng, probability) {
  return nextFloat(rng) < probability;
}

/** Fisher-Yates 洗牌（原地，返回同一数组） */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

export { MASK };
