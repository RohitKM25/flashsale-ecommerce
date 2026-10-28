import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import { pool, query } from './db.js';
import { redis, atomicReserve, getRedisStock, setRedisStock, resetProductState, initRedisScripts } from './redis.js';
import { initSseListener, handleSseConnection } from './sse.js';

const app = express();
const PORT = process.env.PORT || 3000;
const REPLICA_ID = process.env.REPLICA_ID || os.hostname();

app.use(cors());
app.use(express.json());

// Ingress / Health Route
app.get('/api/health', async (req, res) => {
  try {
    const dbTest = await query('SELECT 1 as healthy');
    const redisPing = await redis.ping();
    res.json({
      status: 'UP',
      replicaId: REPLICA_ID,
      uptimeSeconds: Math.floor(process.uptime()),
      database: dbTest.rows[0].healthy === 1 ? 'CONNECTED' : 'DEGRADED',
      redis: redisPing === 'PONG' ? 'CONNECTED' : 'DEGRADED',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message, replicaId: REPLICA_ID });
  }
});

// Products Catalog List with Search, Filter & Live Flash-Sale Stock
app.get('/api/products', async (req, res) => {
  try {
    const { category, search, sort } = req.query;
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    if (category && category !== 'All') {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }

    if (search && search.trim() !== '') {
      params.push(`%${search.trim()}%`);
      sql += ` AND (title ILIKE $${params.length} OR description ILIKE $${params.length})`;
    }

    if (sort === 'price_asc') {
      sql += ' ORDER BY COALESCE(flash_price, price) ASC';
    } else if (sort === 'price_desc') {
      sql += ' ORDER BY COALESCE(flash_price, price) DESC';
    } else {
      sql += ' ORDER BY is_flash_sale DESC, id ASC';
    }

    const { rows } = await query(sql, params);

    // Sync live in-memory stock for flash sale items
    const enriched = await Promise.all(
      rows.map(async (p) => {
        if (p.is_flash_sale) {
          const redisStock = await getRedisStock(p.id);
          return {
            ...p,
            live_stock: redisStock !== null ? redisStock : p.available_stock,
          };
        }
        return {
          ...p,
          live_stock: p.available_stock,
        };
      })
    );

    res.json({
      success: true,
      count: enriched.length,
      replicaId: REPLICA_ID,
      products: enriched,
    });
  } catch (err) {
    console.error('[API] Error fetching products:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch product catalog' });
  }
});

// Product Details
app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query('SELECT * FROM products WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const product = rows[0];
    if (product.is_flash_sale) {
      const redisStock = await getRedisStock(product.id);
      product.live_stock = redisStock !== null ? redisStock : product.available_stock;
    } else {
      product.live_stock = product.available_stock;
    }

    res.json({ success: true, product, replicaId: REPLICA_ID });
  } catch (err) {
    console.error('[API] Error fetching product details:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch product' });
  }
});

// Atomic Flash Sale Checkout Endpoint
// High-throughput, non-blocking Redis reservation with asynchronous DB queue dispatch
app.post('/api/products/:id/checkout', async (req, res) => {
  const startTime = Date.now();
  const productId = parseInt(req.params.id, 10);
  const { quantity = 1, userId = `user_${uuidv4().slice(0, 8)}`, idempotencyKey } = req.body;

  const orderToken = idempotencyKey || `FS-${Date.now().toString(36).toUpperCase()}-${uuidv4().slice(0, 6).toUpperCase()}`;

  try {
    // 1. Fetch product metadata
    const prodRes = await query('SELECT * FROM products WHERE id = $1', [productId]);
    if (prodRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    const product = prodRes.rows[0];
    const unitPrice = product.flash_price || product.price;
    const totalPrice = (Number(unitPrice) * quantity).toFixed(2);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const orderPayload = {
      orderToken,
      userId,
      productId,
      quantity,
      unitPrice,
      totalPrice,
      expiresAt,
      createdAt: new Date().toISOString(),
      replicaId: REPLICA_ID,
    };

    if (product.is_flash_sale) {
      // Execute Atomic Lua Script in Redis Single-Threaded Event Loop
      const result = await atomicReserve({
        productId,
        quantity,
        orderToken,
        ttlSeconds: 300,
        payload: orderPayload,
        userId,
      });

      const latencyMs = Date.now() - startTime;

      if (result.status === 'SOLD_OUT') {
        return res.status(409).json({
          success: false,
          status: 'SOLD_OUT',
          message: 'All 500 flash sale units have been reserved! Sold out.',
          available: result.available || 0,
          latencyMs,
          replicaId: REPLICA_ID,
        });
      }

      if (result.status === 'USER_LIMIT_EXCEEDED') {
        return res.status(403).json({
          success: false,
          status: 'USER_LIMIT_EXCEEDED',
          message: 'Fair allocation rule: Limit of 1 flash-sale smartphone per customer.',
          latencyMs,
          replicaId: REPLICA_ID,
        });
      }

      if (result.status === 'ALREADY_RESERVED') {
        return res.status(200).json({
          success: true,
          status: 'ALREADY_RESERVED',
          message: 'This order was already received and reserved.',
          orderToken,
          expiresAt,
          latencyMs,
          replicaId: REPLICA_ID,
        });
      }

      // Successful Atomic Reservation -> Status 202 Accepted (Order in Queue)
      return res.status(202).json({
        success: true,
        status: 'QUEUED_FOR_CONFIRMATION',
        message: 'Order reservation successful! Stock decremented atomically in Redis. Confirming order in database...',
        orderToken,
        remainingStock: result.remainingStock,
        unitPrice,
        totalPrice,
        expiresAt,
        latencyMs,
        replicaId: REPLICA_ID,
      });
    } else {
      // Standard non-flash sale checkout with conditional SQL
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updateRes = await client.query(
          'UPDATE products SET available_stock = available_stock - $1 WHERE id = $2 AND available_stock >= $1 RETURNING available_stock',
          [quantity, productId]
        );

        if (updateRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ success: false, message: 'Item is out of stock' });
        }

        const insOrder = await client.query(
          `INSERT INTO orders (order_token, user_id, product_id, quantity, unit_price, total_price, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'CONFIRMED', $7) RETURNING id`,
          [orderToken, userId, productId, quantity, unitPrice, totalPrice, expiresAt]
        );

        await client.query(
          `INSERT INTO order_ledger (order_id, order_token, product_id, change_type, delta_stock, stock_after)
           VALUES ($1, $2, $3, 'STANDARD_PURCHASE', $4, $5)`,
          [insOrder.rows[0].id, orderToken, productId, quantity, updateRes.rows[0].available_stock]
        );

        await client.query('COMMIT');

        return res.status(200).json({
          success: true,
          status: 'CONFIRMED',
          orderToken,
          message: 'Order placed successfully',
          remainingStock: updateRes.rows[0].available_stock,
          replicaId: REPLICA_ID,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error('[API] Checkout error:', err);
    res.status(500).json({ success: false, error: 'Checkout processing failed' });
  }
});

// SSE Stream for Real-time Order Updates
app.get('/api/orders/:token/stream', handleSseConnection);

// Order Status Check
app.get('/api/orders/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { rows } = await query('SELECT * FROM orders WHERE order_token = $1', [token]);
    if (rows.length > 0) {
      return res.json({ success: true, order: rows[0], source: 'database' });
    }

    // Check Redis in-memory reservation
    const reservation = await redis.get(`reservation:${token}`);
    if (reservation) {
      return res.json({
        success: true,
        order: JSON.parse(reservation),
        status: 'QUEUED_FOR_CONFIRMATION',
        source: 'redis_cache',
      });
    }

    res.status(404).json({ success: false, error: 'Order not found or expired' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reviews Endpoints
app.get('/api/reviews/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { rows } = await query(
      'SELECT * FROM reviews WHERE product_id = $1 ORDER BY created_at DESC',
      [productId]
    );

    // Calculate rating breakdown
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let sum = 0;
    rows.forEach((r) => {
      distribution[r.rating] = (distribution[r.rating] || 0) + 1;
      sum += r.rating;
    });
    const avgRating = rows.length > 0 ? (sum / rows.length).toFixed(1) : 0;

    res.json({
      success: true,
      reviews: rows,
      total: rows.length,
      average: Number(avgRating),
      distribution,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/reviews/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { userName, rating, comment } = req.body;

    if (!userName || !rating || !comment) {
      return res.status(400).json({ success: false, error: 'Missing required review fields' });
    }

    const { rows } = await query(
      `INSERT INTO reviews (product_id, user_name, rating, comment, verified_purchase)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
      [productId, userName, Math.min(5, Math.max(1, rating)), comment]
    );

    // Update product rating summary
    await query(
      `UPDATE products p
       SET review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = p.id),
           rating = (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE product_id = p.id)
       WHERE p.id = $1`,
      [productId]
    );

    res.status(201).json({ success: true, review: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Administrative & Concurrency Testing Endpoints
app.get('/api/admin/stats', async (req, res) => {
  try {
    const redisStock = await getRedisStock(1);
    const dbProduct = await query('SELECT available_stock, initial_stock FROM products WHERE id = 1');
    const orderCountRes = await query('SELECT COUNT(*) as count FROM orders WHERE product_id = 1');
    const ledgerCountRes = await query('SELECT COUNT(*) as count FROM order_ledger WHERE product_id = 1');

    const totalOrders = parseInt(orderCountRes.rows[0].count, 10);
    const totalLedger = parseInt(ledgerCountRes.rows[0].count, 10);
    const postgresStock = dbProduct.rows.length > 0 ? dbProduct.rows[0].available_stock : 0;
    const initialStock = dbProduct.rows.length > 0 ? dbProduct.rows[0].initial_stock : 500;

    // Check oversell: total orders must NEVER exceed initialStock (500)
    const oversellCount = Math.max(0, totalOrders - initialStock);

    // Get stream length
    let streamLen = 0;
    try {
      streamLen = await redis.xlen('flashsale_orders');
    } catch {
      streamLen = 0;
    }

    res.json({
      success: true,
      productId: 1,
      initialStock,
      redisStock: redisStock !== null ? redisStock : postgresStock,
      postgresStock,
      totalOrdersCommitted: totalOrders,
      totalLedgerEntries: totalLedger,
      oversellCount,
      streamPendingMessages: streamLen,
      zeroOversellGuaranteed: oversellCount === 0,
      timestamp: new Date().toISOString(),
      replicaId: REPLICA_ID,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/reset', async (req, res) => {
  try {
    const initialStock = 500;
    // 1. Reset PostgreSQL database tables
    await query('UPDATE products SET available_stock = $1, initial_stock = $1 WHERE id = 1', [initialStock]);
    await query('DELETE FROM order_ledger WHERE product_id = 1');
    await query('DELETE FROM orders WHERE product_id = 1');

    // 2. Reset Redis stock and clear stream
    await resetProductState(1, initialStock);

    console.log(`[Admin] Reset flash sale inventory to ${initialStock} across DB & Redis`);
    res.json({
      success: true,
      message: `Successfully reset flash sale stock to ${initialStock}. Orders and ledger cleared.`,
      initialStock,
      availableStock: initialStock,
    });
  } catch (err) {
    console.error('[Admin] Reset error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// High-Concurrency Flash Sale Stress Test Runner
app.post('/api/admin/simulate-rush', async (req, res) => {
  const { totalRequests = 1000, concurrency = 50 } = req.body;
  const targetTotal = Math.min(Math.max(totalRequests, 50), 5000);
  const targetConcurrency = Math.min(Math.max(concurrency, 10), 100);

  const startBenchmark = Date.now();
  let reservedCount = 0;
  let soldOutCount = 0;
  let alreadyReservedCount = 0;
  let errorCount = 0;

  console.log(`[Benchmark] Starting blitz test: ${targetTotal} requests with concurrency ${targetConcurrency}`);

  const queue = Array.from({ length: targetTotal }, (_, i) => i + 1);

  async function worker() {
    while (queue.length > 0) {
      const idx = queue.shift();
      if (idx === undefined) break;

      const userToken = `bench_usr_${idx}_${Math.random().toString(36).slice(2, 6)}`;
      const orderToken = `FS-BENCH-${idx}-${uuidv4().slice(0, 6).toUpperCase()}`;

      try {
        const result = await atomicReserve({
          productId: 1,
          quantity: 1,
          orderToken,
          ttlSeconds: 300,
          payload: {
            orderToken,
            userId: userToken,
            productId: 1,
            quantity: 1,
            unitPrice: 399.99,
            totalPrice: '399.99',
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            createdAt: new Date().toISOString(),
            replicaId: REPLICA_ID,
          },
          userId: userToken,
        });

        if (result.status === 'SUCCESS') reservedCount++;
        else if (result.status === 'SOLD_OUT') soldOutCount++;
        else if (result.status === 'ALREADY_RESERVED') alreadyReservedCount++;
      } catch (err) {
        errorCount++;
      }
    }
  }

  // Run concurrent workers
  const workers = Array.from({ length: targetConcurrency }, () => worker());
  await Promise.all(workers);

  const totalTimeMs = Date.now() - startBenchmark;
  const rps = Math.round((targetTotal / (totalTimeMs / 1000)));

  const currentRedisStock = await getRedisStock(1);

  res.json({
    success: true,
    benchmark: {
      totalRequests: targetTotal,
      concurrency: targetConcurrency,
      durationMs: totalTimeMs,
      requestsPerSecond: rps,
      reservedCount,
      soldOutCount,
      alreadyReservedCount,
      errorCount,
      finalRedisStock: currentRedisStock,
      oversellDetected: reservedCount > 500,
    },
  });
});

// Initialize server and Redis state
async function startServer() {
  try {
    await initRedisScripts();
    initSseListener();

    // Check if flash sale stock is initialized in Redis; if not, sync from DB
    const currentStock = await getRedisStock(1);
    if (currentStock === null) {
      const { rows } = await query('SELECT available_stock FROM products WHERE id = 1');
      const initialStock = rows.length > 0 ? rows[0].available_stock : 500;
      await setRedisStock(1, initialStock);
      console.log(`[Init] Synced initial Redis stock for Product 1: ${initialStock}`);
    } else {
      console.log(`[Init] Redis stock for Product 1 is currently: ${currentStock}`);
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Backend ${REPLICA_ID}] Server listening on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('[Init] Fatal startup error:', err);
    setTimeout(startServer, 3000);
  }
}

startServer();
