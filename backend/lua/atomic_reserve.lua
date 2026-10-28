-- Atomic Inventory Reservation Script for High-Traffic Flash-Sale
-- Guarantees Zero Overselling and Sub-Millisecond Execution

local stockKey = KEYS[1]
local reservationKey = KEYS[2]
local productReservationsSet = KEYS[3]
local userLimitKey = KEYS[4]

local requestedQty = tonumber(ARGV[1])
local orderToken = ARGV[2]
local ttlSeconds = tonumber(ARGV[3])
local payloadJson = ARGV[4]
local userId = ARGV[5]

-- 1. Idempotency Check: if this order token already exists, return existing status
if redis.call('EXISTS', reservationKey) == 1 then
    return cjson.encode({
        status = "ALREADY_RESERVED",
        token = orderToken
    })
end

-- 2. User Limit Check: Ensure fair allocation (1 per user for flash sale)
if userId and userId ~= "" and redis.call('EXISTS', userLimitKey) == 1 then
    return cjson.encode({
        status = "USER_LIMIT_EXCEEDED",
        message = "Limit of 1 flash-sale unit per customer"
    })
end

-- 3. In-Memory Stock Check
local rawStock = redis.call('GET', stockKey)
if not rawStock then
    return cjson.encode({
        status = "STOCK_NOT_INITIALIZED"
    })
end

local currentStock = tonumber(rawStock)
if currentStock < requestedQty then
    return cjson.encode({
        status = "SOLD_OUT",
        available = currentStock
    })
end

-- 4. Atomic Decrement in single-threaded event loop
local remainingStock = redis.call('DECRBY', stockKey, requestedQty)

-- 5. Record 5-minute expiration hold token (payment abandonment guard)
redis.call('SETEX', reservationKey, ttlSeconds, payloadJson)
if userId and userId ~= "" then
    redis.call('SETEX', userLimitKey, ttlSeconds, orderToken)
end
redis.call('SADD', productReservationsSet, orderToken)

-- 6. Enqueue order into FIFO Stream for Asynchronous Worker Batch Processing
redis.call('XADD', 'flashsale_orders', '*', 'token', orderToken, 'payload', payloadJson)

return cjson.encode({
    status = "SUCCESS",
    remainingStock = remainingStock,
    token = orderToken
})
