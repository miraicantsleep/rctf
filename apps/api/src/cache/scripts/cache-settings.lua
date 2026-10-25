local current = redis.call('GET', KEYS[1])
-- The revision is a top-level integer in the server-generated JSON envelope.
local revision = current and tonumber(string.match(current, '"revision"%s*:%s*(%d+)'))
if revision and revision > tonumber(ARGV[1]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
