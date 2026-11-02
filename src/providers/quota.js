/**
 * Global daily/monthly counters for processed Resend webhooks.
 *
 * The Resend free plan is small (100/day, 3,000/month) and every received
 * message counts against it, including mail for addresses this app does not
 * know. These counters let the provider stop *processing* before it burns the
 * account's allowance, and surface a soft warning earlier.
 *
 * The daily window is a UTC calendar day (midnight-to-midnight UTC), matching
 * how Resend resets its daily quota.
 */

function utcDayKey(now) {
  const d = new Date(now);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

function utcMonthKey(now) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class QuotaTracker {
  constructor({
    dailyLimit = 100,
    monthlyLimit = 3000,
    softLimitRatio = 0.8,
    now = () => Date.now(),
  } = {}) {
    this.dailyLimit = dailyLimit;
    this.monthlyLimit = monthlyLimit;
    this.softLimitRatio = softLimitRatio;
    this.now = now;
    const at = now();
    this.daily = { key: utcDayKey(at), used: 0 };
    this.monthly = { key: utcMonthKey(at), used: 0 };
  }

  /** Roll the counters over when the UTC day/month changes. */
  sync() {
    const at = this.now();
    const day = utcDayKey(at);
    if (this.daily.key !== day) {
      this.daily = { key: day, used: 0 };
    }
    const month = utcMonthKey(at);
    if (this.monthly.key !== month) {
      this.monthly = { key: month, used: 0 };
    }
  }

  levelFor(used, limit) {
    if (limit > 0 && used >= limit) return 'hard';
    if (limit > 0 && used >= Math.ceil(limit * this.softLimitRatio)) return 'soft';
    return 'ok';
  }

  level() {
    this.sync();
    const levels = [
      this.levelFor(this.daily.used, this.dailyLimit),
      this.levelFor(this.monthly.used, this.monthlyLimit),
    ];
    if (levels.includes('hard')) return 'hard';
    if (levels.includes('soft')) return 'soft';
    return 'ok';
  }

  /**
   * Reserve one slot. Returns whether processing may continue and the current
   * level. A `hard` result must NOT increment the counters.
   */
  tryAcquire() {
    const level = this.level();
    if (level === 'hard') {
      return { allowed: false, level, state: this.state() };
    }
    this.daily.used += 1;
    this.monthly.used += 1;
    return { allowed: true, level, state: this.state() };
  }

  state() {
    this.sync();
    return {
      daily: { used: this.daily.used, limit: this.dailyLimit, level: this.levelFor(this.daily.used, this.dailyLimit) },
      monthly: { used: this.monthly.used, limit: this.monthlyLimit, level: this.levelFor(this.monthly.used, this.monthlyLimit) },
      softLimitRatio: this.softLimitRatio,
      level: this.level(),
    };
  }
}
