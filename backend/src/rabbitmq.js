import amqp from 'amqplib';

const AMQP_URL = process.env.AMQP_URL || 'amqp://flashsale:flashsale@localhost:5672';

export const ORDERS_QUEUE = process.env.ORDERS_QUEUE || 'flashsale.orders';
export const ORDERS_DLQ = process.env.ORDERS_DLQ || 'flashsale.orders.dead';
export const DEAD_LETTER_EXCHANGE = 'flashsale.dlx';

let connection = null;
let channel = null;
let connecting = null;
let shuttingDown = false;
let reconnectTimer = null;

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await ensureChannel();
    } catch (err) {
      console.warn('[RabbitMQ] Reconnect attempt failed:', err.message);
      scheduleReconnect();
    }
  }, 2000);
}

async function connect() {
  const conn = await amqp.connect(AMQP_URL);
  conn.on('error', (err) => {
    console.error('[RabbitMQ] Connection error:', err.message);
  });
  conn.on('close', () => {
    connection = null;
    channel = null;
    if (!shuttingDown) {
      console.warn('[RabbitMQ] Connection closed. Reconnecting in 2s...');
      scheduleReconnect();
    }
  });

  const ch = await conn.createConfirmChannel();
  await ch.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
  await ch.assertQueue(ORDERS_DLQ, { durable: true });
  await ch.bindQueue(ORDERS_DLQ, DEAD_LETTER_EXCHANGE, ORDERS_QUEUE);
  await ch.assertQueue(ORDERS_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': ORDERS_QUEUE,
    },
  });

  connection = conn;
  channel = ch;
  console.log(`[RabbitMQ] Connected. Publishing to durable queue '${ORDERS_QUEUE}'`);
  return channel;
}

async function ensureChannel() {
  if (channel) return channel;
  if (!connecting) {
    connecting = connect().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

export async function initRabbitMQ() {
  await ensureChannel();
}

export function isRabbitConnected() {
  return Boolean(connection && channel);
}

export async function publishOrder(order) {
  const ch = await ensureChannel();
  const content = Buffer.from(JSON.stringify(order));

  return new Promise((resolve, reject) => {
    try {
      ch.sendToQueue(
        ORDERS_QUEUE,
        content,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: order.orderToken,
          timestamp: Date.now(),
          type: 'ORDER_RESERVED',
        },
        (err) => {
          if (err) reject(err);
          else resolve(true);
        }
      );
    } catch (err) {
      reject(err);
    }
  });
}

export async function getQueueStatus() {
  const ch = await ensureChannel();
  const status = await ch.checkQueue(ORDERS_QUEUE);
  return {
    queue: ORDERS_QUEUE,
    messages: status.messageCount,
    consumers: status.consumerCount,
  };
}

export async function purgeOrdersQueue() {
  const ch = await ensureChannel();
  const result = await ch.purgeQueue(ORDERS_QUEUE);
  const dead = await ch.purgeQueue(ORDERS_DLQ);
  return { ordersPurged: result.messageCount, deadLettersPurged: dead.messageCount };
}

export async function closeRabbitMQ() {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (channel) await channel.close();
  } catch {
    // ignore shutdown errors
  }
  try {
    if (connection) await connection.close();
  } catch {
    // ignore shutdown errors
  }
  channel = null;
  connection = null;
}
