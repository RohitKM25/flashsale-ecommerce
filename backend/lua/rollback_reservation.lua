-- Compensating rollback if a confirmed RabbitMQ publish cannot be completed.
-- Restores the stock that atomic_reserve.lua decremented and clears the hold
-- keys so the customer can safely retry.

local stockKey = KEYS[1]
local reservationKey = KEYS[2]
local productReservationsSet = KEYS[3]
local userLimitKey = KEYS[4]

local requestedQty = tonumber(ARGV[1])
local orderToken = ARGV[2]
local userId = ARGV[3]

-- Only roll back a reservation that still exists. This also prevents rolling
-- back the same token twice after a redelivery.
if redis.call('EXISTS', reservationKey) == 0 then
    return 0
end

redis.call('INCRBY', stockKey, requestedQty)
redis.call('DEL', reservationKey)
redis.call('SREM', productReservationsSet, orderToken)

if userId and userId ~= "" then
    local current = redis.call('GET', userLimitKey)
    if current == orderToken then
        redis.call('DEL', userLimitKey)
    end
end

return 1
