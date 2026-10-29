import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 2000);
    return delay;
  },
});

export const redisSub = new Redis(REDIS_URL);
export const redisPub = new Redis(REDIS_URL);

redis.on('connect', () => console.log('[Redis] Client connected'));
redis.on('error', (err) => console.error('[Redis] Connection error:', err.message));

// Load Lua scripts
const luaPath = path.join(__dirname, '../lua/atomic_reserve.lua');
const rollbackLuaPath = path.join(__dirname, '../lua/rollback_reservation.lua');
const luaScript = fs.readFileSync(luaPath, 'utf8');
const rollbackLuaScript = fs.readFileSync(rollbackLuaPath, 'utf8');

let scriptSha = null;
let rollbackScriptSha = null;

export async function initRedisScripts() {
  try {
    scriptSha = await redis.script('LOAD', luaScript);
    rollbackScriptSha = await redis.script('LOAD', rollbackLuaScript);
    console.log('[Redis] Atomic reserve & rollback Lua scripts loaded');
  } catch (err) {
    console.error('[Redis] Error loading Lua scripts:', err);
  }
}

export async function atomicReserve({ productId, quantity = 1, orderToken, ttlSeconds = 300, payload, userId }) {
  const stockKey = `product:stock:${productId}`;
  const reservationKey = `reservation:${orderToken}`;
  const productReservationsSet = `product:reservations:${productId}`;
  const userLimitKey = `user:reserved:${userId || 'guest'}:${productId}`;
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  try {
    let resultRaw;
    if (scriptSha) {
      resultRaw = await redis.evalsha(
        scriptSha,
        4,
        stockKey,
        reservationKey,
        productReservationsSet,
        userLimitKey,
        quantity,
        orderToken,
        ttlSeconds,
        payloadStr,
        userId || ''
      );
    } else {
      resultRaw = await redis.eval(
        luaScript,
        4,
        stockKey,
        reservationKey,
        productReservationsSet,
        userLimitKey,
        quantity,
        orderToken,
        ttlSeconds,
        payloadStr,
        userId || ''
      );
    }
    return JSON.parse(resultRaw);
  } catch (err) {
    if (err.message && err.message.includes('NOSCRIPT')) {
      // Re-load and retry
      scriptSha = await redis.script('LOAD', luaScript);
      return atomicReserve({ productId, quantity, orderToken, ttlSeconds, payload, userId });
    }
    throw err;
  }
}

export async function rollbackReservation({ productId, quantity = 1, orderToken, userId }) {
  const stockKey = `product:stock:${productId}`;
  const reservationKey = `reservation:${orderToken}`;
  const productReservationsSet = `product:reservations:${productId}`;
  const userLimitKey = `user:reserved:${userId || 'guest'}:${productId}`;

  try {
    if (rollbackScriptSha) {
      return await redis.evalsha(
        rollbackScriptSha,
        4,
        stockKey,
        reservationKey,
        productReservationsSet,
        userLimitKey,
        quantity,
        orderToken,
        userId || ''
      );
    }
    return await redis.eval(
      rollbackLuaScript,
      4,
      stockKey,
      reservationKey,
      productReservationsSet,
      userLimitKey,
      quantity,
      orderToken,
      userId || ''
    );
  } catch (err) {
    if (err.message && err.message.includes('NOSCRIPT')) {
      rollbackScriptSha = await redis.script('LOAD', rollbackLuaScript);
      return rollbackReservation({ productId, quantity, orderToken, userId });
    }
    throw err;
  }
}

export async function getRedisStock(productId) {
  const stock = await redis.get(`product:stock:${productId}`);
  return stock !== null ? parseInt(stock, 10) : null;
}

export async function setRedisStock(productId, stock) {
  await redis.set(`product:stock:${productId}`, stock);
}

export async function resetProductState(productId, targetStock = 500) {
  await redis.set(`product:stock:${productId}`, targetStock);
  await redis.del(`product:reservations:${productId}`);
  // Remove legacy Redis Stream from older versions of the pipeline.
  await redis.del('flashsale_orders');
  console.log(`[Redis] Product ${productId} reset to stock: ${targetStock}`);
}
