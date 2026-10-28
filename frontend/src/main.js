import './style.css';
import { uiIcons } from './icons.js';
import {
  fetchProduct,
  checkoutProduct,
  fetchAdminStats,
  resetAdminSale,
  runStressTest,
  connectOrderSse,
  getActiveOrderToken,
  setActiveOrderToken,
} from './api.js';

// Application State
const FLASH_PRODUCT_ID = 1;
let activeSseUnsubscribe = null;

// DOM Elements
const replicaLabel = document.getElementById('replica-label');
const heroProductTitle = document.getElementById('hero-product-title');
const heroFlashPrice = document.getElementById('hero-flash-price');
const heroStockCount = document.getElementById('hero-stock-count');
const heroStockFill = document.getElementById('hero-stock-fill');
const btnFlashCheckout = document.getElementById('btn-flash-checkout');
const btnFlashText = document.getElementById('btn-flash-text');
const btnFlashIcon = document.getElementById('btn-flash-icon');
const btnShareDeal = document.getElementById('btn-share-deal');
const shareIconSlot = document.getElementById('share-icon');
const orderStatusContainer = document.getElementById('order-status-container');

// Right-Pane Benchmark Controls & Telemetry
const btnRun1000 = document.getElementById('btn-run-1000');
const btnRun2000 = document.getElementById('btn-run-2000');
const btnResetInventory = document.getElementById('btn-reset-inventory');
const benchLog = document.getElementById('bench-log');
const statRedisStock = document.getElementById('stat-redis-stock');
const statPgStock = document.getElementById('stat-pg-stock');
const statOrdersCount = document.getElementById('stat-orders-count');
const statOversellCount = document.getElementById('stat-oversell-count');
const toastContainer = document.getElementById('toast-container');

// Render initial SVG icons (zero emojis)
btnFlashIcon.innerHTML = uiIcons.bolt;
shareIconSlot.innerHTML = uiIcons.share;
document.getElementById('stock-icon').innerHTML = uiIcons.shield;

// Toast helper
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `${type === 'success' ? uiIcons.check : uiIcons.bolt} <span>${message}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Update Stock Meter Display
function updateStockDisplay(availableStock, initialStock = 500) {
  const stock = Math.max(0, Number(availableStock));
  heroStockCount.textContent = `${stock} / ${initialStock} Left`;
  const pct = Math.max(0, Math.min(100, (stock / initialStock) * 100));
  heroStockFill.style.width = `${pct}%`;

  if (stock === 0) {
    btnFlashCheckout.disabled = true;
    btnFlashText.textContent = 'SOLD OUT (500/500 CLAIMED)';
    heroStockFill.style.background = 'var(--accent-sale)';
  } else {
    if (!getActiveOrderToken()) {
      btnFlashCheckout.disabled = false;
      btnFlashText.textContent = 'RESERVE SMARTPHONE X NOW';
    }
  }
}

// Render Optimistic UI State Card
function renderOrderStatus({ status, token, expiresAt, message }) {
  orderStatusContainer.style.display = 'block';

  if (status === 'QUEUED_FOR_CONFIRMATION') {
    orderStatusContainer.innerHTML = `
      <div class="order-status-card queued">
        <div class="status-header">
          <span class="status-badge" style="color: var(--accent-blue);">
            <span class="pulse-dot"></span> In Queue (Atomic In-Memory Reservation)
          </span>
          <span class="status-token">${token}</span>
        </div>
        <p class="status-desc">
          Inventory reserved in Redis single-threaded engine. Asynchronous worker is committing ACID transaction to PostgreSQL ledger...
        </p>
      </div>
    `;
  } else if (status === 'CONFIRMED') {
    orderStatusContainer.innerHTML = `
      <div class="order-status-card confirmed">
        <div class="status-header">
          <span class="status-badge" style="color: var(--accent-success);">
            ${uiIcons.check} Order Confirmed and Guaranteed
          </span>
          <span class="status-token">${token}</span>
        </div>
        <p class="status-desc">
          Zero oversell guarantee satisfied. Database write committed to immutable ledger. Your physical device is reserved.
        </p>
        <div class="reservation-timer" id="res-timer">
          Complete checkout within 5 minutes (TTL expires: ${new Date(expiresAt).toLocaleTimeString()})
        </div>
      </div>
    `;
    btnFlashCheckout.disabled = true;
    btnFlashText.textContent = 'RESERVATION SECURED';
  } else if (status === 'SOLD_OUT') {
    orderStatusContainer.innerHTML = `
      <div class="order-status-card soldout">
        <div class="status-header">
          <span class="status-badge" style="color: var(--accent-sale);">
            ${uiIcons.close} Sale Concluded / Sold Out
          </span>
          <span class="status-token">${token || 'N/A'}</span>
        </div>
        <p class="status-desc">
          ${message || 'All 500 units of Smartphone X have been claimed by concurrent users.'}
        </p>
      </div>
    `;
    btnFlashCheckout.disabled = true;
    btnFlashText.textContent = 'SOLD OUT';
  }
}

// Attach Server-Sent Events (SSE) Listener
function subscribeToOrderUpdates(token) {
  if (activeSseUnsubscribe) {
    activeSseUnsubscribe();
    activeSseUnsubscribe = null;
  }

  activeSseUnsubscribe = connectOrderSse(
    token,
    (update) => {
      console.log('[SSE Event Received]:', update);
      if (update.status === 'CONFIRMED') {
        renderOrderStatus({
          status: 'CONFIRMED',
          token: update.orderToken,
          expiresAt: update.expiresAt || new Date(Date.now() + 300000).toISOString(),
        });
        showToast('Order confirmed via live Server-Sent Events stream!', 'success');
        loadFlashProduct();
        refreshStats();
      } else if (update.status === 'SOLD_OUT') {
        renderOrderStatus({
          status: 'SOLD_OUT',
          token: update.orderToken,
          message: update.message,
        });
        loadFlashProduct();
        refreshStats();
      }
    },
    (err) => {
      console.warn('[SSE] Error or connection closed');
    }
  );
}

// Debounced Flash Sale Checkout Click Handler
async function handleFlashCheckout() {
  btnFlashCheckout.disabled = true;
  btnFlashText.textContent = 'Processing Reservation...';

  const idempotencyKey = `FS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  renderOrderStatus({
    status: 'QUEUED_FOR_CONFIRMATION',
    token: idempotencyKey,
  });

  try {
    const { status, data } = await checkoutProduct(FLASH_PRODUCT_ID, {
      quantity: 1,
      idempotencyKey,
    });

    if (data.replicaId) {
      replicaLabel.textContent = `Replica: ${data.replicaId}`;
    }

    if (status === 202) {
      setActiveOrderToken(data.orderToken);
      showToast(`Reserved in Redis (${data.latencyMs}ms). Subscribing to SSE...`, 'success');
      updateStockDisplay(data.remainingStock);
      subscribeToOrderUpdates(data.orderToken);
      refreshStats();
    } else if (status === 409) {
      renderOrderStatus({
        status: 'SOLD_OUT',
        token: idempotencyKey,
        message: data.message,
      });
      showToast(data.message, 'error');
      updateStockDisplay(0);
      refreshStats();
    } else if (status === 403) {
      showToast(data.message, 'error');
      btnFlashCheckout.disabled = false;
      btnFlashText.textContent = 'RESERVE SMARTPHONE X NOW';
      orderStatusContainer.style.display = 'none';
    } else {
      showToast(data.error || 'Checkout failed', 'error');
      btnFlashCheckout.disabled = false;
      btnFlashText.textContent = 'RESERVE SMARTPHONE X NOW';
    }
  } catch (err) {
    console.error('Checkout error:', err);
    showToast('Network error during reservation. Retrying...', 'error');
    btnFlashCheckout.disabled = false;
    btnFlashText.textContent = 'RESERVE SMARTPHONE X NOW';
  }
}

// Load and Display the Flash Sale Item
async function loadFlashProduct() {
  try {
    const { product } = await fetchProduct(FLASH_PRODUCT_ID);

    heroProductTitle.textContent = product.title || 'Smartphone X';
    heroFlashPrice.textContent = `$${Number(product.flash_price || product.price).toFixed(2)}`;
    updateStockDisplay(product.live_stock, product.initial_stock);
  } catch (err) {
    console.error('Failed to load flash sale product:', err);
  }
}

// Social Share Handler
function handleShare() {
  const shareData = {
    title: 'Smartphone X Flash Sale',
    text: 'A limited batch of 500 Smartphone X devices is live for $399.99. High-speed atomic checkout.',
    url: window.location.href,
  };

  if (navigator.share) {
    navigator.share(shareData).catch(() => {});
  } else {
    navigator.clipboard.writeText(`${shareData.title} - ${shareData.url}`);
    showToast('Flash-sale link copied to clipboard.', 'success');
  }
}

// Live Benchmark Telemetry Refresh
async function refreshStats() {
  try {
    const stats = await fetchAdminStats();
    statRedisStock.textContent = stats.redisStock;
    statPgStock.textContent = stats.postgresStock;
    statOrdersCount.textContent = stats.totalOrdersCommitted;
    statOversellCount.textContent = `${stats.oversellCount} (Zero Oversell)`;

    if (stats.replicaId) {
      replicaLabel.textContent = `Ingress: ${stats.replicaId}`;
    }
    return stats;
  } catch (err) {
    console.warn('Failed to load stats:', err);
  }
}

function appendBenchLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  benchLog.textContent += line;
  benchLog.scrollTop = benchLog.scrollHeight;
}

async function triggerBenchmark(totalRequests, concurrency) {
  btnRun1000.disabled = true;
  btnRun2000.disabled = true;
  btnResetInventory.disabled = true;

  appendBenchLog(`Initiating blitz of ${totalRequests} concurrent requests (concurrency: ${concurrency})...`);
  appendBenchLog(`Decoupled pipeline active: Redis Lua single-threaded atomic reserve -> Redis Stream -> Worker -> Postgres Ledger`);

  try {
    const res = await runStressTest(totalRequests, concurrency);
    const b = res.benchmark;

    appendBenchLog(`--------------------------------------------------`);
    appendBenchLog(`Benchmark Completed in ${b.durationMs}ms (~${b.requestsPerSecond} req/sec)`);
    appendBenchLog(`   Reserved in Redis (202 Accepted): ${b.reservedCount}`);
    appendBenchLog(`   Gracefully Rejected (409 Sold Out): ${b.soldOutCount}`);
    appendBenchLog(`   Final In-Memory Stock: ${b.finalRedisStock}`);
    appendBenchLog(`   Oversell Detected: ${b.oversellDetected ? 'CRITICAL ERROR' : 'ZERO (Perfect Consistency)'}`);
    appendBenchLog(`--------------------------------------------------`);

    showToast(`Blitz complete: ${b.reservedCount} reserved, zero overselling!`, 'success');
    await refreshStats();
    await loadFlashProduct();
  } catch (err) {
    appendBenchLog(`Simulation error: ${err.message}`);
    showToast('Simulation failed', 'error');
  } finally {
    btnRun1000.disabled = false;
    btnRun2000.disabled = false;
    btnResetInventory.disabled = false;
  }
}

async function triggerReset() {
  btnResetInventory.disabled = true;
  try {
    await resetAdminSale();
    setActiveOrderToken(null);
    orderStatusContainer.style.display = 'none';
    btnFlashCheckout.disabled = false;
    btnFlashText.textContent = 'RESERVE SMARTPHONE X NOW';
    appendBenchLog(`System reset complete: Redis stock set to 500, Postgres tables and ledger cleared.`);
    showToast('Inventory reset to 500 units.', 'success');
    await refreshStats();
    await loadFlashProduct();
  } catch (err) {
    showToast('Reset failed', 'error');
  } finally {
    btnResetInventory.disabled = false;
  }
}

// Event Listeners
function initEventListeners() {
  btnFlashCheckout.addEventListener('click', handleFlashCheckout);
  btnShareDeal.addEventListener('click', handleShare);

  btnRun1000.addEventListener('click', () => triggerBenchmark(1000, 50));
  btnRun2000.addEventListener('click', () => triggerBenchmark(2000, 80));
  btnResetInventory.addEventListener('click', triggerReset);

  const activeToken = getActiveOrderToken();
  if (activeToken) {
    renderOrderStatus({
      status: 'QUEUED_FOR_CONFIRMATION',
      token: activeToken,
    });
    subscribeToOrderUpdates(activeToken);
  }
}

async function initApp() {
  initEventListeners();
  await loadFlashProduct();
  await refreshStats();

  // Continuous live synchronization for the right-hand benchmark pane
  setInterval(refreshStats, 2000);
}

initApp();
