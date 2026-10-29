import amqp from 'amqplib';

const AMQP_URL = process.env.AMQP_URL || 'amqp://flashsale:flashsale@localhost:5672';

export const ORDERS_QUEUE = process.env.ORDERS_QUEUE || 'flashsale.orders';
export const ORDERS_DLQ = process.env.ORDERS_DLQ || 'flashsale.orders.dead';
export const DEAD_LETTER_EXCHANGE = 'flashsale.dlx';

export async function connectConsumer({ prefetch }) {
  const connection = await amqp.connect(AMQP_URL);
  connection.on('error', (err) => {
    console.error('[RabbitMQ] Connection error:', err.message);
  });

  const channel = await connection.createChannel();
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(ORDERS_DLQ, { durable: true });
  await channel.bindQueue(ORDERS_DLQ, DEAD_LETTER_EXCHANGE, ORDERS_QUEUE);
  await channel.assertQueue(ORDERS_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': ORDERS_QUEUE,
    },
  });

  // RabbitMQ will not push more than `prefetch` unacknowledged messages to
  // this worker. The worker also groups those deliveries into DB batches.
  await channel.prefetch(prefetch);

  return { connection, channel };
}
