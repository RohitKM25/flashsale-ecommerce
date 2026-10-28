import { redisSub, redis } from './redis.js';
import { query } from './db.js';

// Map of orderToken -> Set of express Response objects
const activeClients = new Map();

// Initialize Redis Pub/Sub listener for cross-replica SSE broadcast
export function initSseListener() {
  redisSub.subscribe('order_events', (err) => {
    if (err) console.error('[SSE] Failed to subscribe to order_events:', err);
    else console.log('[SSE] Subscribed to order_events channel for live order updates');
  });

  redisSub.on('message', (channel, message) => {
    if (channel === 'order_events') {
      try {
        const data = JSON.parse(message);
        const { orderToken } = data;
        if (orderToken && activeClients.has(orderToken)) {
          const clientSet = activeClients.get(orderToken);
          const ssePayload = `event: order_update\ndata: ${message}\n\n`;
          for (const res of clientSet) {
            res.write(ssePayload);
          }
          console.log(`[SSE] Broadcasted status update to ${clientSet.size} client(s) for token ${orderToken}`);
        }
      } catch (err) {
        console.error('[SSE] Error handling PubSub message:', err);
      }
    }
  });

  // Heartbeat interval to prevent socket timeout
  setInterval(() => {
    for (const [token, clientSet] of activeClients.entries()) {
      for (const res of clientSet) {
        res.write(': keepalive\n\n');
      }
    }
  }, 15000);
}

export async function handleSseConnection(req, res) {
  const { token } = req.params;

  if (!token) {
    return res.status(400).json({ error: 'Order token is required' });
  }

  // Set standard SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Critical for Nginx proxy_buffering off
    'Access-Control-Allow-Origin': '*',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ orderToken: token, timestamp: Date.now() })}\n\n`);

  // Add to active set
  if (!activeClients.has(token)) {
    activeClients.set(token, new Set());
  }
  activeClients.get(token).add(res);

  // Check current status in DB or Redis reservation
  try {
    const dbOrder = await query('SELECT * FROM orders WHERE order_token = $1', [token]);
    if (dbOrder.rows.length > 0) {
      const order = dbOrder.rows[0];
      res.write(`event: order_update\ndata: ${JSON.stringify({
        orderToken: token,
        status: order.status,
        expiresAt: order.expires_at,
        source: 'database',
      })}\n\n`);
    } else {
      const reservation = await redis.get(`reservation:${token}`);
      if (reservation) {
        res.write(`event: order_update\ndata: ${JSON.stringify({
          orderToken: token,
          status: 'QUEUED_FOR_CONFIRMATION',
          source: 'redis_reservation',
        })}\n\n`);
      }
    }
  } catch (err) {
    console.error('[SSE] Error checking existing order:', err.message);
  }

  req.on('close', () => {
    if (activeClients.has(token)) {
      const set = activeClients.get(token);
      set.delete(res);
      if (set.size === 0) {
        activeClients.delete(token);
      }
    }
  });
}
