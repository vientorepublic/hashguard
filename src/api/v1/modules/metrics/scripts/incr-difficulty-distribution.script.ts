/**
 * Lua script for incrementing the difficulty distribution count in Redis.
 */
export const INCR_DIFFICULTY_DISTRIBUTION_SCRIPT = `
local distributionKey = KEYS[1]
local difficultyBits = ARGV[1]
local maxKeys = tonumber(ARGV[2])

local exists = redis.call('HEXISTS', distributionKey, difficultyBits) == 1
local hasCapacity = redis.call('HLEN', distributionKey) < maxKeys

if exists or hasCapacity then
  return redis.call('HINCRBY', distributionKey, difficultyBits, 1)
end

return 0
`;
