// Client API & SSE Client for High-Traffic Flash-Sale Architecture

const BASE_URL = '/api';

export function getUserId() {
  let uid = localStorage.getItem('fs_user_id');
  if (!uid) {
    uid = 'usr_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem('fs_user_id', uid);
  }
  return uid;
}

export function getActiveOrderToken() {
  return localStorage.getItem('fs_active_order_token');
}

export function setActiveOrderToken(token) {
  if (token) localStorage.setItem('fs_active_order_token', token);
  else localStorage.removeItem('fs_active_order_token');
}

export async function fetchProducts(params = {}) {
  const query = new URLSearchParams();
  if (params.category && params.category !== 'All') query.set('category', params.category);
  if (params.search) query.set('search', params.search);
  if (params.sort) query.set('sort', params.sort);

  const res = await fetch(`${BASE_URL}/products?${query.toString()}`);
  if (!res.ok) throw new Error('Failed to load products');
  return res.json();
}

export async function fetchProduct(id) {
  const res = await fetch(`${BASE_URL}/products/${id}`);
  if (!res.ok) throw new Error('Failed to load product');
  return res.json();
}

export async function checkoutProduct(id, { quantity = 1, idempotencyKey } = {}) {
  const userId = getUserId();
  const res = await fetch(`${BASE_URL}/products/${id}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity,
      userId,
      idempotencyKey,
    }),
  });

  const data = await res.json();
  return { status: res.status, data };
}

export async function fetchReviews(productId) {
  const res = await fetch(`${BASE_URL}/reviews/${productId}`);
  if (!res.ok) throw new Error('Failed to load reviews');
  return res.json();
}

export async function submitReview(productId, { userName, rating, comment }) {
  const res = await fetch(`${BASE_URL}/reviews/${productId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName, rating, comment }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Review submission failed');
  }
  return res.json();
}

export async function fetchAdminStats() {
  const res = await fetch(`${BASE_URL}/admin/stats`);
  if (!res.ok) throw new Error('Failed to load system stats');
  return res.json();
}

export async function resetAdminSale() {
  const res = await fetch(`${BASE_URL}/admin/reset`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to reset inventory');
  return res.json();
}

export async function runStressTest(totalRequests = 1000, concurrency = 50) {
  const res = await fetch(`${BASE_URL}/admin/simulate-rush`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ totalRequests, concurrency }),
  });
  if (!res.ok) throw new Error('Simulation failed');
  return res.json();
}

// Server-Sent Events (SSE) Listener for Order Confirmation
export function connectOrderSse(orderToken, onUpdate, onError) {
  const url = `${BASE_URL}/orders/${orderToken}/stream`;
  const eventSource = new EventSource(url);

  eventSource.addEventListener('connected', (e) => {
    console.log('[SSE] Stream connected for token:', orderToken);
  });

  eventSource.addEventListener('order_update', (e) => {
    try {
      const data = JSON.parse(e.data);
      onUpdate(data);
    } catch (err) {
      console.error('[SSE] Failed to parse update:', err);
    }
  });

  eventSource.onerror = (err) => {
    console.warn('[SSE] EventSource error or closed:', err);
    if (onError) onError(err);
  };

  return () => {
    eventSource.close();
  };
}
