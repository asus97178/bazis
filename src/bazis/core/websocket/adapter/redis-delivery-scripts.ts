// Shared key encoding matches encodeURIComponent used by the session adapter.
export const KEYS = `
local function escape(value)
  return (value:gsub("[^%w%-_%.!~*'()]", function(c) return string.format('%%%02X', string.byte(c)) end))
end
local function sessionKey(prefix, sid) return prefix .. ':session:' .. escape(sid) end
local function queueKey(prefix, sid) return prefix .. ':delivery:' .. escape(sid) end
local function roomKey(prefix, ns, room) return prefix .. ':room:' .. ns .. string.char(0) .. room end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
`;

// Called only after a successful session revision/identity check.
export const UPDATE_ROOMS = `
local previous = raw and cjson.decode(raw) or nil
local old = previous and previous.state and cjson.decode(previous.state) or nil
if old then
  for _, room in ipairs(old.rooms or {}) do redis.call('ZREM', roomKey(ARGV[4], old.namespace, room), old.sid) end
end
for _, room in ipairs(next.rooms or {}) do
  local key = roomKey(ARGV[4], next.namespace, room)
  local remaining = redis.call('PTTL', key)
  redis.call('ZADD', key, next.expiresAt, next.sid)
  redis.call('PEXPIREAT', key, math.max(next.expiresAt, now + math.max(0, remaining)))
end
redis.call('PEXPIREAT', queueKey(ARGV[4], next.sid), next.expiresAt)
`;

export const DELETE_ROOMS = `
if current and current.state then
  local old = cjson.decode(current.state)
  for _, room in ipairs(old.rooms or {}) do redis.call('ZREM', roomKey(ARGV[3], old.namespace, room), old.sid) end
end
redis.call('DEL', queueKey(ARGV[3], ARGV[4]))
`;

export const PUBLISH = KEYS + `
local prefix = ARGV[1]
local request = cjson.decode(ARGV[2])
local limits = cjson.decode(ARGV[3])
local op = prefix .. ':operation:' .. request.messageId
local previous = redis.call('GET', op)
if previous then
  local record = cjson.decode(previous)
  if record.fingerprint ~= ARGV[4] then return {'MESSAGE_ID_CONFLICT'} end
  return {'OK', tostring(record.recipients), '1'}
end
if request.expiresAt <= now or request.expiresAt > now + 60000 then return {'EXPIRED_PUBLICATION'} end
local ops = prefix .. ':operations'
redis.call('ZREMRANGEBYSCORE', ops, '-inf', now)
if redis.call('ZCARD', ops) >= limits.maxOperations then return {'OPERATION_CAPACITY'} end
local room = roomKey(prefix, request.namespace, request.room)
redis.call('ZREMRANGEBYSCORE', room, '-inf', now)
local members = redis.call('ZRANGE', room, 0, limits.maxRecipients + 1)
local recipients = {}
local packet = ARGV[5]
local queues = {}
for _, sid in ipairs(members) do
  if sid ~= request.excludeSid then
    local raw = redis.call('GET', sessionKey(prefix, sid))
    local record = raw and cjson.decode(raw) or nil
    local state = record and record.state and cjson.decode(record.state) or nil
    if state and state.expiresAt > now then
      if state.replayDelivery ~= 'client-ack' then return {'RECIPIENT_REQUIRES_ACK'} end
      table.insert(recipients, sid)
      if #recipients > limits.maxRecipients or #recipients * #packet > limits.maxFanoutBytes then return {'FANOUT_CAPACITY'} end
      local key = queueKey(prefix, sid)
      local items = redis.call('LRANGE', key, 0, limits.maxQueueMessages)
      local bytes = #packet
      for _, item in ipairs(items) do bytes = bytes + #item end
      if #items >= limits.maxQueueMessages or bytes > limits.maxQueueBytes then return {'QUEUE_CAPACITY'} end
      table.insert(queues, { key=key, expiresAt=state.expiresAt })
    end
  end
end
-- All admission checks precede writes. Once submitted, an I/O failure has an
-- indeterminate outcome; retry the identical operation, never a fresh ID.
for _, queue in ipairs(queues) do
  redis.call('RPUSH', queue.key, packet)
  redis.call('PEXPIREAT', queue.key, queue.expiresAt)
end
redis.call('SET', op, cjson.encode({fingerprint=ARGV[4], recipients=#recipients}), 'PX', request.expiresAt - now)
redis.call('ZADD', ops, request.expiresAt, request.messageId)
redis.call('PEXPIRE', ops, 60000)
if #recipients > 0 then
  redis.call('PUBLISH', prefix .. ':broadcast', cjson.encode({kind='deliveries', sids=recipients}))
end
return {'OK', tostring(#recipients), '0'}
`;

const OWNER = `
local function owned(prefix, owner)
  local raw = redis.call('GET', sessionKey(prefix, owner.sid))
  local record = raw and cjson.decode(raw) or nil
  local state = record and record.state and cjson.decode(record.state) or nil
  return state and state.expiresAt > now and state.activeLeaseExpiresAt and state.activeLeaseExpiresAt > now
    and state.ownerInstanceId == owner.ownerInstanceId and state.activeConnId == owner.connId
end
`;

export const READ = KEYS + OWNER + `
local result = {}
local bytes = 0
local limit = tonumber(ARGV[3])
for _, owner in ipairs(cjson.decode(ARGV[2])) do
  if owned(ARGV[1], owner) then
    local items = redis.call('LRANGE', queueKey(ARGV[1], owner.sid), 0, tonumber(ARGV[4]) - 1)
    local row = {owner.sid}
    local issued = {}
    for _, id in ipairs(owner.issuedIds or {}) do issued[id] = true end
    for _, item in ipairs(items) do
      if not issued[cjson.decode(item).deliveryId] then
        if bytes + #item > limit then break end
        bytes = bytes + #item
        table.insert(row, item)
      end
    end
    table.insert(result, row)
  end
end
return result
`;

export const ACK = KEYS + OWNER + `
local owner = cjson.decode(ARGV[2])
if not owned(ARGV[1], owner) then return -1 end
local ids = {}
for _, id in ipairs(cjson.decode(ARGV[3])) do ids[id] = true end
local key = queueKey(ARGV[1], owner.sid)
local removed = 0
for _, item in ipairs(redis.call('LRANGE', key, 0, tonumber(ARGV[4]) - 1)) do
  if ids[cjson.decode(item).deliveryId] then removed = removed + redis.call('LREM', key, 1, item) end
end
return removed
`;
