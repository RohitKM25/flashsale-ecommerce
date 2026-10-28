import Redis from 'ioredis';
import pg from 'pg';
import os from 'os';

const { Pool } = pg;

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/flashsale';
const WORKER_ID = process.env.WORKER_ID || `worker_${os.hostname()}_${process.pid}`;

const STREAM_KEY = 'flashsale_orders';
const GROUP_NAME = 'flashsale_workers_group';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '25', 10);
const BLOCK_TIMEOUT_MS = 2000;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const redisPub = new Redis(REDIS_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 15,
  idleTimeoutMillis: 30000,
});

async function initConsumerGroup() {
  try {
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM');
    console.log(`[Worker ${WORKER_ID}] Created consumer group '${GROUP_NAME}' on stream '${STREAM_KEY}'`);
  } catch (err) {
    if (err.message && err.message.includes('BUSYGROUP')) {
      console.log(`[Worker ${WORKER_ID}] Consumer group '${GROUP_NAME}' already registered`);
    } else {
      console.error(`[Worker ${WORKER_ID}] Error initializing consumer group:`, err.message);
    }
  }
}

async function processOrderBatch(messages) {
  if (!messages || messages.length === 0) return 0;

  const client = await pool.connect();
  const ackIds = [];

  try {
    await client.query('BEGIN');

    for (const [messageId, fields] of messages) {
      // fields is an array of key-value pairs: ['token', '...', 'payload', '{...}']
      let payloadObj = null;
      let orderToken = null;

      for (let i = 0; i < fields.length; i += 2) {
        if (fields[i] === 'token') orderToken = fields[i + 1];
        if (fields[i] === 'payload') {
          try {
            payloadObj = JSON.parse(fields[i + 1]);
          } catch (e) {
            console.error('[Worker] JSON parse error in payload:', e);
          }
        }
      }

      if (!payloadObj) {
        ackIds.push(messageId);
        continue;
      }

      const {
        productId = 1,
        userId = 'guest',
        quantity = 1,
        unitPrice = 399.99,
        totalPrice = '399.99',
        expiresAt = new Date(Date.now() + 300000).toISOString(),
      } = payloadObj;

      // 1. Conditional SQL Execution for atomic DB stock decrement
      const updateResult = await client.query(
        `UPDATE products 
         SET available_stock = available_stock - $1,
             updated_at = NOW()
         WHERE id = $2 AND available_stock >= $1
         RETURNING available_stock`,
        [quantity, productId]
      );

      if (updateResult.rowCount === 1) {
        const remainingDbStock = updateResult.rows[0].available_stock;

        // 2. Insert into orders table
        const orderInsert = await client.query(
          `INSERT INTO orders (order_token, user_id, product_id, quantity, unit_price, total_price, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'CONFIRMED', $7)
           ON CONFLICT (order_token) DO UPDATE SET status = 'CONFIRMED'
           RETURNING id, order_token, status, expires_at`,
          [orderToken, userId, productId, quantity, unitPrice, totalPrice, expiresAt]
        );

        const orderId = orderInsert.rows[0].id;

        // 3. Append to Immutable Order Ledger (ACID audit trail)
        await client.query(
          `INSERT INTO order_ledger (order_id, order_token, product_id, change_type, delta_stock, stock_after)
           VALUES ($1, $2, $3, 'FLASH_SALE_RESERVE', $4, $5)`,
          [orderId, orderToken, productId, quantity, remainingDbStock]
        );

        ackIds.push(messageId);

        // Publish live status event via Redis Pub/Sub for SSE client broadcast
        redisPub.publish(
          'order_events',
          JSON.stringify({
            orderToken,
            orderId,
            status: 'CONFIRMED',
            productId,
            userId,
            remainingStock: remainingDbStock,
            expiresAt,
            timestamp: new Date().toISOString(),
          })
        );
      } else {
        // Database stock was depleted (Zero Oversell protection in DB layer)
        console.warn(`[Worker] DB Stock was depleted for order ${orderToken}. Stock could not decrement.`);
        ackIds.push(messageId);

        redisPub.publish(
          'order_events',
          JSON.stringify({
            orderToken,
            status: 'SOLD_OUT',
            message: 'Physical stock depleted in DB ledger',
            timestamp: new Date().toISOString(),
          })
        );
      }
    }

    // Commit transaction for this batch
    await client.query('COMMIT');

    // Acknowledge all processed messages from Redis Stream
    if (ackIds.length > 0) {
      await redis.xack(STREAM_KEY, GROUP_NAME, ...ackIds);
    }

    return ackIds.length;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Worker ${WORKER_ID}] Transaction rolled back:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function runWorkerLoop() {
  console.log(`[Worker ${WORKER_ID}] Worker started. Listening for order batches on stream '${STREAM_KEY}'...`);

  await initConsumerGroup();

  let isRunning = true;

  process.on('SIGINT', () => { isRunning = false; });
  process.on('SIGTERM', () => { isRunning = false; });

  while (isRunning) {
    try {
      // 1. First process any pending/unacknowledged messages from past crashes
      const pendingData = await redis.xreadgroup(
        'GROUP', GROUP_NAME, WORKER_ID,
        'COUNT', BATCH_SIZE,
        'STREAMS', STREAM_KEY, '0'
      );

      if (pendingData && pendingData.length > 0) {
        const [stream, messages] = pendingData[0];
        if (messages.length > 0) {
          console.log(`[Worker ${WORKER_ID}] Reclaiming ${messages.length} pending message(s)`);
          await processOrderBatch(messages);
          continue;
        }
      }

      // 2. Read new messages with blocking throttle
      const streamData = await redis.xreadgroup(
        'GROUP', GROUP_NAME, WORKER_ID,
        'BLOCK', BLOCK_TIMEOUT_MS,
        'COUNT', BATCH_SIZE,
        'STREAMS', STREAM_KEY, '>'
      );

      if (streamData && streamData.length > 0) {
        const [stream, messages] = streamData[0];
        if (messages && messages.length > 0) {
          const processed = await processOrderBatch(messages);
          console.log(`[Worker ${WORKER_ID}] Processed batch of ${processed} orders into PostgreSQL ledger`);
        }
      }
    } catch (err) {
      console.error(`[Worker ${WORKER_ID}] Loop error:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(`[Worker ${WORKER_ID}] Worker shutting down gracefully`);
  process.exit(0);
}

runWorkerLoop();
