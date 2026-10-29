import Redis from 'ioredis';
import pg from 'pg';
import os from 'os';
import { connectConsumer, ORDERS_QUEUE } from './rabbitmq.js';

const { Pool } = pg;

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/flashsale';
const WORKER_ID = process.env.WORKER_ID || `worker_${os.hostname()}_${process.pid}`;

const BATCH_SIZE = Math.max(1, parseInt(process.env.BATCH_SIZE || '25', 10));
const BATCH_WINDOW_MS = Math.max(10, parseInt(process.env.BATCH_WINDOW_MS || '50', 10));
const MAX_DB_RETRY_DELAY_MS = 5000;

const redisPub = new Redis(REDIS_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 15,
  idleTimeoutMillis: 30000,
});

let channel = null;
let connection = null;
let shuttingDown = false;
let buffer = [];
let flushTimer = null;
let flushChain = Promise.resolve();

function publishEvent(event) {
  return new Promise((resolve) => {
    redisPub.publish('order_events', JSON.stringify(event), (err) => {
      if (err) console.error('[Worker] Failed to publish SSE event:', err.message);
      resolve();
    });
  });
}

async function processOrderBatch(messages) {
  if (!messages || messages.length === 0) return;

  const ackMessages = [];
  const deadLetterMessages = [];
  const pendingEvents = [];
  let client = null;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    for (const msg of messages) {
      let order;
      try {
        order = JSON.parse(msg.content.toString());
      } catch {
        console.error(`[Worker ${WORKER_ID}] Dead-lettering unparseable message ${msg.properties.messageId || ''}`);
        deadLetterMessages.push(msg);
        continue;
      }

      const {
        orderToken,
        productId,
        userId = 'guest',
        quantity = 1,
        unitPrice = 399.99,
        totalPrice = '399.99',
        expiresAt = new Date(Date.now() + 300000).toISOString(),
      } = order || {};

      if (!orderToken || !Number.isInteger(productId) || !Number.isInteger(quantity) || quantity <= 0) {
        console.error(`[Worker ${WORKER_ID}] Dead-lettering invalid order payload`);
        deadLetterMessages.push(msg);
        continue;
      }

      // Savepoint makes each message idempotent. If a duplicate delivery hits
      // the unique order_token constraint, its stock decrement is rolled back
      // without affecting the rest of the batch.
      await client.query('SAVEPOINT order_msg');

      const updateResult = await client.query(
        `UPDATE products
         SET available_stock = available_stock - $1,
             updated_at = NOW()
         WHERE id = $2 AND available_stock >= $1
         RETURNING available_stock`,
        [quantity, productId]
      );

      if (updateResult.rowCount === 0) {
        await client.query('RELEASE SAVEPOINT order_msg');
        ackMessages.push(msg);
        pendingEvents.push({
          orderToken,
          status: 'SOLD_OUT',
          message: 'Physical stock depleted in database ledger',
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      const remainingDbStock = updateResult.rows[0].available_stock;

      const orderInsert = await client.query(
        `INSERT INTO orders (order_token, user_id, product_id, quantity, unit_price, total_price, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'CONFIRMED', $7)
         ON CONFLICT (order_token) DO NOTHING
         RETURNING id, order_token, status, expires_at`,
        [orderToken, userId, productId, quantity, unitPrice, totalPrice, expiresAt]
      );

      if (orderInsert.rowCount === 0) {
        // Already persisted by an earlier delivery: undo this decrement.
        await client.query('ROLLBACK TO SAVEPOINT order_msg');
        await client.query('RELEASE SAVEPOINT order_msg');
        ackMessages.push(msg);
        continue;
      }

      const orderId = orderInsert.rows[0].id;

      await client.query(
        `INSERT INTO order_ledger (order_id, order_token, product_id, change_type, delta_stock, stock_after)
         VALUES ($1, $2, $3, 'FLASH_SALE_RESERVE', $4, $5)`,
        [orderId, orderToken, productId, quantity, remainingDbStock]
      );

      await client.query('RELEASE SAVEPOINT order_msg');
      ackMessages.push(msg);
      pendingEvents.push({
        orderToken,
        orderId,
        status: 'CONFIRMED',
        productId,
        userId,
        remainingStock: remainingDbStock,
        expiresAt,
        timestamp: new Date().toISOString(),
      });
    }

    await client.query('COMMIT');

    // Status events are emitted only after the batch commits, so clients never
    // observe CONFIRMED for a transaction that later rolls back.
    for (const event of pendingEvents) {
      await publishEvent(event);
    }

    for (const msg of ackMessages) {
      channel.ack(msg);
    }
    for (const msg of deadLetterMessages) {
      // requeue=false routes poison messages to flashsale.orders.dead.
      channel.nack(msg, false, false);
    }

    if (messages.length > 0) {
      console.log(
        `[Worker ${WORKER_ID}] Committed batch of ${messages.length} message(s) (${pendingEvents.length} status event(s))`
      );
    }
  } catch (err) {
    try {
      if (client) await client.query('ROLLBACK');
    } catch {
      // connection may already be gone
    }
    console.error(`[Worker ${WORKER_ID}] Batch rolled back, requeueing:`, err.message);

    // Back off briefly so a database outage does not create a hot redelivery loop.
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 + messages.length * 20, MAX_DB_RETRY_DELAY_MS)));

    for (const msg of messages) {
      try {
        channel.nack(msg, false, true);
      } catch (nackErr) {
        console.error(`[Worker ${WORKER_ID}] Failed to requeue message:`, nackErr.message);
      }
    }
  } finally {
    if (client) client.release();
  }
}

async function drainBuffer() {
  while (!shuttingDown && buffer.length > 0) {
    const batch = buffer.splice(0, BATCH_SIZE);
    await processOrderBatch(batch);
  }
}

function enqueueFlush() {
  flushChain = flushChain.then(drainBuffer).catch((err) => {
    console.error(`[Worker ${WORKER_ID}] Flush error:`, err.message);
  });
}

function scheduleFlush(delayMs) {
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    enqueueFlush();
  }, delayMs);
}

function onMessage(msg) {
  if (!msg) {
    console.warn(`[Worker ${WORKER_ID}] Consumer cancelled by broker`);
    process.exit(1);
  }

  buffer.push(msg);

  if (buffer.length >= BATCH_SIZE) {
    scheduleFlush(0);
  } else if (!flushTimer) {
    scheduleFlush(BATCH_WINDOW_MS);
  }
}

async function start() {
  console.log(
    `[Worker ${WORKER_ID}] Starting RabbitMQ consumer. Queue=${ORDERS_QUEUE} Prefetch/Batch=${BATCH_SIZE}`
  );

  const consumer = await connectConsumer({ prefetch: BATCH_SIZE });
  connection = consumer.connection;
  channel = consumer.channel;

  connection.on('close', () => {
    if (!shuttingDown) {
      console.error(`[Worker ${WORKER_ID}] RabbitMQ connection closed. Exiting for restart...`);
      process.exit(1);
    }
  });

  await channel.consume(ORDERS_QUEUE, onMessage, { noAck: false });
  console.log(`[Worker ${WORKER_ID}] Waiting for order messages...`);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Worker ${WORKER_ID}] ${signal} received. Draining batch and shutting down...`);

  if (flushTimer) clearTimeout(flushTimer);
  await flushChain.catch(() => {});

  try {
    if (channel) await channel.close();
  } catch {
    // ignore
  }
  try {
    if (connection) await connection.close();
  } catch {
    // ignore
  }

  await redisPub.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function startWithRetry() {
  while (!shuttingDown) {
    try {
      await start();
      return;
    } catch (err) {
      console.error(`[Worker ${WORKER_ID}] Startup connection failed: ${err.message}. Retrying in 2s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

startWithRetry().catch((err) => {
  console.error(`[Worker ${WORKER_ID}] Fatal startup error:`, err.message);
  process.exit(1);
});
