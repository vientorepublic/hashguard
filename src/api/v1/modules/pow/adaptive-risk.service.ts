import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../modules/redis/redis.module';

// One hash per subject: atomic across replicas and compatible with Redis Cluster.
// Redis TIME avoids disagreement between application clocks. Previous windows are
// blended in so rotating a context or crossing a window boundary cannot reset risk.
export const RISK_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) + tonumber(time[2]) / 1000000
local mode = ARGV[1]
local function window(name, seconds, amount)
  local epoch = math.floor(now / seconds)
  local oldEpoch = tonumber(redis.call('HGET', KEYS[1], name .. ':epoch') or '-1')
  local current = tonumber(redis.call('HGET', KEYS[1], name .. ':current') or '0')
  local previous = tonumber(redis.call('HGET', KEYS[1], name .. ':previous') or '0')
  if oldEpoch ~= epoch then
    previous = oldEpoch == epoch - 1 and current or 0
    current = 0
  end
  current = current + amount
  redis.call('HSET', KEYS[1], name .. ':epoch', epoch,
    name .. ':current', current, name .. ':previous', previous)
  return current + previous * (1 - (now % seconds) / seconds)
end
local last = tonumber(redis.call('HGET', KEYS[1], 'failedAt') or now)
local failures = tonumber(redis.call('HGET', KEYS[1], 'failures') or '0')
failures = failures * math.exp(-math.log(2) * math.max(0, now - last) / 300)
if mode == 'failure' then failures = failures + 1 end
redis.call('HSET', KEYS[1], 'failures', failures, 'failedAt', now)
-- Hard limits use continuously refilling buckets, independently of the
-- approximate observation windows used for risk. Check all dimensions before
-- debiting any bucket; a rejected expensive request cannot spend a cheap budget.
local allowed = 1
local buckets = {}
local function bucket(name, capacity, seconds, charge)
  local last = tonumber(redis.call('HGET', KEYS[1], name .. ':at') or now)
  local tokens = tonumber(redis.call('HGET', KEYS[1], name .. ':tokens') or capacity)
  tokens = math.min(capacity, tokens + math.max(0, now - last) * capacity / seconds)
  if tokens < charge then allowed = 0 end
  table.insert(buckets, {name, tokens, charge})
end
local cost = mode == 'request' and tonumber(ARGV[2]) or 0
if mode == 'request' then
  bucket('hard:requests', tonumber(ARGV[3]), 60, 1)
  bucket('hard:units', tonumber(ARGV[4]), 60, cost)
  bucket('hard:burst', tonumber(ARGV[5]), 5, cost)
elseif mode == 'verify' then
  bucket('hard:verify', tonumber(ARGV[6]), 60, 1)
end
for _, b in ipairs(buckets) do
  local left = b[2] - (allowed == 1 and b[3] or 0)
  redis.call('HSET', KEYS[1], b[1] .. ':tokens', left, b[1] .. ':at', now)
end
local rpm = window('requests', 60, mode == 'request' and 1 or 0)
local units = window('units', 60, cost)
local burst = window('burst', 5, cost)
local verify = window('verify', 60, mode == 'verify' and 1 or 0)
redis.call('EXPIRE', KEYS[1], 1800)
return {tostring(rpm), tostring(units), tostring(burst), tostring(failures), tostring(verify), tostring(allowed)}
`;

export interface RiskAssessment {
  riskScore: number;
  challengeRequired: boolean;
}

@Injectable()
export class AdaptiveRiskService {
  private readonly secret: string;
  private readonly costs: Record<string, number>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    const secret = config.get<string>('pow.riskKeySecret');
    if (!secret && config.get<string>('app.nodeEnv') === 'production') {
      throw new Error('POW_RISK_KEY_SECRET is required in production');
    }
    this.secret = secret ?? randomBytes(32).toString('hex');
    this.costs = JSON.parse(
      config.get<string>('pow.contextCostsJson', '{}'),
    ) as Record<string, number>;
  }

  private async signals(ip: string, mode: string, cost = 0): Promise<number[]> {
    const subject = createHmac('sha256', this.secret)
      .update('ip\0' + ip)
      .digest('hex');
    try {
      const result = (await this.redis.eval(
        RISK_SCRIPT,
        1,
        `risk:${subject}`,
        mode,
        cost,
        this.config.get<number>('pow.maxChallengeRpm', 60),
        this.config.get<number>('pow.hardLimitUnits', 120),
        this.config.get<number>('pow.burstHardLimitUnits', 30),
        this.config.get<number>('pow.maxVerificationRpm', 120),
      )) as string[];
      const values = result.map(Number);
      if (values.length !== 6 || values.some((v) => !Number.isFinite(v)))
        throw new Error('Invalid risk state');
      return values;
    } catch {
      throw new ServiceUnavailableException({
        code: 'POW_RISK_UNAVAILABLE',
        message: 'Risk state could not be checked safely',
      });
    }
  }

  async assess(ip: string, context: string): Promise<RiskAssessment> {
    // Only server configuration determines costs. Unknown labels still share the
    // same IP counters, so changing labels never resets a hard limit.
    const cost = Object.prototype.hasOwnProperty.call(this.costs, context)
      ? this.costs[context]
      : 1;
    const [, units, burst, failures, , allowed] = await this.signals(
      ip,
      'request',
      cost,
    );
    if (allowed !== 1) this.rateLimited();
    const soft = this.config.get<number>('pow.softLimitUnits', 30);
    const burstSoft = this.config.get<number>('pow.burstSoftLimitUnits', 5);
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const velocity = clamp(Math.log(Math.max(1, units / soft)) / Math.log(8));
    // Detect repeated traffic rather than treating one expensive operation as a burst.
    const burstSignal = clamp((Math.max(0, burst - cost) / burstSoft - 1) / 2);
    const riskScore =
      35 * velocity + 20 * burstSignal + 20 * clamp(failures / 5);
    return {
      riskScore,
      challengeRequired:
        riskScore >= this.config.get<number>('pow.challengeRiskThreshold', 20),
    };
  }

  async checkVerificationRate(ip: string): Promise<void> {
    const values = await this.signals(ip, 'verify');
    if (values[5] !== 1) this.rateLimited();
  }

  async recordFailure(ip: string): Promise<void> {
    await this.signals(ip, 'failure');
  }

  private rateLimited(): never {
    throw new HttpException(
      {
        code: 'POW_ADAPTIVE_RATE_LIMITED',
        message: 'Request hard limit exceeded',
        retryAfter: 60,
      },
      429,
    );
  }
}
