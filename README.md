# Flash‑Sale E‑Commerce Demo  

UI
<img width="1524" height="1089" alt="image" src="https://github.com/user-attachments/assets/78a60f69-489d-4b62-9a91-6fa70dc17693" />

RabbitMQ
<img width="1326" height="828" alt="image" src="https://github.com/user-attachments/assets/815456ee-2993-4077-812e-bbd364cc09da" />

---  

# Table of Contents  

1. [Case Scenario](#case-scenario) 
2. [Requirement Analysis](#requirement-analysis)
3. [Solution](#solution)
4. [Tech Stack](#tech-stack)  
5. [Repository Structure](#repository-structure)  
6. [Setup & Installation](#setup--installation)  
7. [Running the Application](#running-the-application)  
8. [Implementation Details](#implementation-details)  
   - [Frontend](#frontend)  
   - [Backend (API & SSE)](#backend)  
   - [Redis Atomic Reservation & RabbitMQ](#redis-atomic-reservation)  
   - [Worker & PostgreSQL Ledger](#worker)  
9. [Data Flow Diagram](#data-flow-diagram)  
10. [Testing & Verification](#testing--verification)  
11. [Cleanup](#cleanup) 
12. [Conclusion](#conclusion) 
---  

# Case Scenario
Your company is launching an urgent flash-sale feature for an e-commerce platform during a major festival. A limited batch of 500 high-demand smartphones will go live at exactly 8:00 PM. Based on marketing analytics, the platform expects a massive traffic spike of over 100,000 concurrent user requests hitting the checkout endpoint in the first 10 seconds of the sale launch.
## Problem Statement
During previous trial runs, the platform suffered from high latency, database row locks, and severe API request timeouts. Worse, a critical consistency bug occurred: the system oversold the inventory, resulting in 540 successful checkouts despite only having 500 physical devices in stock. As a Full-Stack Candidate, you are tasked with re-architecting both the client-facing interface and the backend processing pipeline to ensure absolute data consistency, zero overselling, and a smooth user experience under high load. 

---  

# Requirement Analysis
## Functional Requirements
- View items and status of flash sale items (limited batch of 500 smartphones).

- Users can initiate checkouts for flash sale items, at exactly 8:00.

- User receives real-time order status updates

- User product reviews, ratings, sharing.

- General e-commerce product catalogue search and navigation
## Non-Functional Requirements
- Scalability: 

  - Handle 100,000 concurrent user requests hitting in the first 10 seconds.

  - Distribute load across backend replicas

- Performance: 

  - Frontend/Client Bundle Size < 200KB.

  - Client Time-To-Interactive < 1.5s.

  - Decouple heavy database writes from HTTP request-response cycles.

- Availability: 0% dropped user requests.

- Reliability: ACID compliance, Atomic Decrements.

- Consistency: Guarantee consistent inventory management, exactly 500 items. Zero overselling. Avoid application-level double counters and row lock timeouts.

---

# Solution
## Frontend Strategy (Client Optimisation)
### Bundle Optimisation
1. Frontend built using lightweight SPA frameworks to maintain bundle footprint below 200KB and TTI less than 1.5s

2. Minification & Compression: Strips whitespaces, variable name mangling, asset compression to reduce bundle size

3. **Tree Shaking & ES6**

  - Use of ES Modules to allow bundlers (Webpack, Rollup, etc) to analyse required and unused code.

  - Bundlers use ES Module static imports to remove dead/unused code, minimising sizes of heavy utility libraries, this is called tree shaking

4. **Code Splitting & Lazy Loading**

  - Code Splitting: Break monolithic code into smaller logical chunks to enable dynamic module loading. For multipage applications use route-based code splitting.

  - Use lazy loading libraries to load modules on demand. Improves Total Blocking Time (total time the main thread was block by JS tasks)
### Asset Hosting (CDN)
1. Static Assets such as JS bundles, stylesheets, thumbnails, etc., are distributed globally using Content Delivery Networks.

2. CDNs store copies of these assets in regional edge servers.

3. It directs requests to the nearest edge server via DNS (Proximity Routing).

4. The assets are cached, i.e., files available in the edge server are served immediately (cache hit). If not, they are fetched from the origin server and saved in the edge server (cache miss).

5. Usage of CDNs significantly improve Time-To-Interactive times and reduce/distribute overall server load.
### UI Optimisations
1. Debouncing: Client disables action button (Checkout) immediately upon first click and updates UI to indicate request processing status.

2. Duplicate clicks are rejected at the client, preventing repetitive API requests caused by user spamming clicks.

3. Ongoing checkout request stored with unique token to ensure it is acknowledged on subsequent visits.
### Status Tracking
1. Dynamic Polling: Client requests server for status updates at exponentially increasing intervals.

2. Web Sockets: Bidirectional persistent connection to exchange status messages.

3. **Architectural Strategy** **(Server-Sent Events):**

   1. Using Server-Sent Event (SSE), combining advantages of both dynamic polling and web sockets.

   2. Dynamic Polling uses standard HTTP protocol for each request incurring high overheads for simple status updates.

   3. Web Sockets involves high overheads for session management. The complexity of a full duplex connection is redundant.

   4. Server-Sent Events (SSE): A unidirectional (server pushes) open HTTP stream, persistent and incurs minimal overhead while having native reconnection.
### Optimistic UI
1. With real-time status updates from server using SSE, the UI can optimistically track order status by assuming next state (Checkout => Order in Queue => Order Success/Failed)

2. On checkout button click, instead of an unresponsive UI waiting for update, the client assumes the next state “Order in Queue”, before the acknowledgement of a successful order placement.

3. On receiving update, the UI can either change to the next pre-emptive state “Order Success” (Success) or gracefully rollback with an error message (Failure).
## Backend & Middleware Architecture
### Ingress & Traffic Distribution (Clustering & Load Balancing):
1. Load Balancer distributes incoming traffic across multiple backend servers.

2. Enables scaling, by allowing backend instance management, i.e., maintenance, fault recovery, horizontally scaling instances to accommodate 100,000 concurrent users during flash sales.

3. Clustering: Connected collection of multiple independent isolated devices (node), acting as a single unified compute system.

4. Load Balancer distributes network traffic to suitable servers in the cluster, also handling health checks
### Atomic Reservation (Redis Caching):
1. Traditional databases handle multiple requests concurrently causing a race condition, two requests at the same time, successfully placing an order for the same item, leading to an oversell.

2. However, Redis handles commands sequentially in a single-threaded event loop, hence incoming requests are pushed into a queue processed one by one, preventing race conditions.

3. Redis supports scripting, locking the single thread on execution, making inventory checks and decrementing stock atomic per request (impossible for more than one data modification to happen at the exact same time).

4. On request,

   1. With stock available, the stock is decremented and a 5-minute expiration token using Redis’ in-built Time-To-Live support. Returns Acknowledgement and sends event to asynchronous messaging queue.

   2. With empty stock, it immediately sends failure response back.

5. The expiration token ensures payment abandonment, i.e., user drops within 5 minutes.

6. Redis handles stock consistency over high traffic, protecting database from traffic spikes.
### Asynchronous Message Queue (Decoupling & Throttling,RabbitMQ):
1. The asynchronous message broker acts as a buffer, a FIFO queue, enabling syncing services with varying response times.

2. Decoupling: the queue separates fast Redis reservations events from slow database writes. 

3. Throttling: It buffers the spike of 100,000 users' requests into a steady stream that the relational database can handle.

4. Here, the Redis order placements are queued, and the database appends records onto an immutable log like a ledger or WAL. To maintain ACID compliance.

5. The Queue retains messages until an ACK is received; hence the data is safe on database crashes.
## Data Component (Database Consistency & Concurrency Control)
### Message Consumption & Batching
1. Asynchronous workers are configured to fetch a fixed number of messages, a batch. The message queue broker will not assign additional messages unless the batch is acknowledged (ACK)

2. This enables throttling to prevent queue dumping messages into workers at once.

3. Throttling and proper batch size ensures maximum database write throughput without affecting performance.
### Conditional SQL Execution
1. Atomic Decrement: on receiving message, workers run conditional Update query if stock not empty.

2. Although this is concurrent, it is executed at a controlled rate, and the update query takes insignificant run time compared to heavy database writes directly without caching and queueing.
### Ledger & Transactions
1. On successful, the update query results in a Rows Affected = 1, the worker Inserts the order details and token into an immutable, append only table.

2. The worker task, from Update to ledger Insert is enclosed in a transaction and commit to ensure ACID compliance per batch, improving performance compared to per request transactions.
### Acknowledgement & Status Propagation:
1. On successful execution of batch, the worker sends ACK, thus clearing batch’s messages from queue

2. The worker sends a Successful Order Reservation event back to client (though SSE or Redis Pub/Sub)

3. The client on receiving the event, updates UI with success message and order tracking.

---

# Tech Stack  

| Layer | Technology | Purpose |
|------|------------|---------|
| **Frontend** | Vanilla HTML / CSS / JavaScript (Vite build) | UI, split‑screen layout, real‑time stock meter, benchmark panel |
| **API** | Node + Express | REST endpoints (`/api/products/:id`, `/api/checkout`, `/api/admin/reset`) |
| **Realtime** | Server‑Sent Events | Push order status (`QUEUED_FOR_CONFIRMATION`, `CONFIRMED`) |
| **Cache** | Redis 7 (Lua script + TTL reservations) | Atomic stock decrement and 5‑minute reservation holds |
| **Message Queue** | RabbitMQ 3.13 (durable queue + publisher confirms) | Durable buffer between Redis reservations and PostgreSQL writes |
| **Persistence** | PostgreSQL 16 | Product catalog, orders, immutable ledger |
| **Worker** | Node worker process | Consumes RabbitMQ batches, writes conditional SQL + ledger |
| **Ingress** | Nginx (least‑conn) | Load‑balances API traffic across backend replicas |
| **Containerisation** | Docker Compose | One‑click dev/prod environment |

---  

# Repository Structure  

```
flashsale-ecommerce/
├── backend/                # Express API + SSE server
│   ├── src/
│   │   ├── server.js
│   │   ├── redis.js
│   │   ├── rabbitmq.js     # Durable queue publisher (publisher confirms)
│   │   └── sse.js
│   ├── lua/
│   │   ├── atomic_reserve.lua
│   │   └── rollback_reservation.lua
│   └── Dockerfile
├── worker/                 # RabbitMQ consumer / order‑processing worker
│   ├── src/
│   │   ├── worker.js
│   │   └── rabbitmq.js
│   └── Dockerfile
├── frontend/               # SPA source (Vite)
│   ├── index.html
│   ├── src/
│   │   ├── main.js
│   │   ├── api.js
│   │   └── icons.js
│   └── Dockerfile
├── database/               # SQL schema & seed data
│   └── init.sql
├── nginx/                  # Ingress configuration
│   └── nginx.conf
├── docker-compose.yml      # Orchestration
└── README.md               # ← **this file**
```

---  
###
# Setup & Installation  

> **Prerequisites**  
> - Docker Engine ≥ 20.10 and Docker Compose v2  
> - A Unix‑like shell (Linux/macOS) – the repo is developed on Linux  

1. **Clone the repository**  

   ```bash
   git clone https://github.com/yourorg/flashsale-ecommerce.git
   cd flashsale-ecommerce
   ```

2. **Copy environment files (if any)** – the current setup uses defaults, no extra `.env` required.  

3. **Build the containers**  

   ```bash
   docker compose build
   ```

4. **Start the stack**  

   ```bash
   docker compose up -d
   ```

   This spins up:  

   - `flashsale-postgres` (listening on `5432`)  
   - `flashsale-redis` (listening on `6379`)  
   - `flashsale-rabbitmq` (AMQP on `5672`, management UI on `15672`)  
   - `flashsale-backend-1` & `flashsale-backend-2` (API, port 3000)  
   - `flashsale-worker` (RabbitMQ consumer)  
   - `flashsale-nginx` (exposes port 80 → `http://localhost`)  

   RabbitMQ management UI: **http://localhost:15672** (`flashsale` / `flashsale`). The durable queue is `flashsale.orders` and failed messages dead‑letter to `flashsale.orders.dead`.

5. **Verify DB seed**  

   ```bash
   docker compose exec postgres psql -U postgres -d flashsale -c "SELECT id, title, flash_price, available_stock FROM products;"
   ```

   You should see a single row for **Smartphone X** with `available_stock = 500`.  

6. **Access the UI**  

   Open a browser at **http://localhost**. The split‑screen UI shows the flash‑sale card on the left and the benchmark panel on the right.  

---  

## Running the Application  

| Command | Effect |
|--------|--------|
| `docker compose up -d` | Starts the full stack (containers keep running). |
| `docker compose down` | Stops and removes containers, networks, volumes. |
| `docker compose logs -f <service>` | Tail logs for a specific service (`backend-1`, `worker`, `nginx`, …). |
| `docker compose exec backend-1 npm run lint` | Run linter inside a backend container (if added). |
| `docker compose exec frontend npm run build` | Re‑build the SPA bundle (useful after UI changes). |

**Hot‑reloading** – the frontend uses Vite’s dev server (`npm run dev`) inside the container; changes to `frontend/src` are reflected instantly.  

---
###
# Implementation Details  

### Frontend  

* **`index.html`** – lightweight split‑screen layout with no placeholders, *Smartphone X* as the sole product.  
* **`main.js`** – loads product data via `/api/products/:id`, updates the real‑time stock meter, debounces the *Reserve* button, and establishes an SSE channel for order status.  
* **Benchmark panel** – triggers 1 k / 2 k concurrent requests via the stress‑test endpoint, displays Redis / Postgres stock, committed orders, oversell count, and live RabbitMQ queue depth, consumers, and connection status.

### Backend  

* **`server.js`** – REST API exposing product info, checkout, admin reset, and a health endpoint.  
* **`redis.js`** – Lua script (`atomic_reserve.lua`) runs a single‑threaded atomic `DECRBY` only if enough stock remains, returning the new stock and a reservation token.  
* **`rabbitmq.js`** – publishes each reservation to the durable `flashsale.orders` queue using a confirm channel; failed publishes compensate the Redis reservation.  
* **`sse.js`** – publishes order‑status events (`QUEUED_FOR_CONFIRMATION`, `CONFIRMED`, `SOLD_OUT`) on a per‑token channel; the client subscribes via `/api/orders/:token/stream`.  

### Redis Atomic Reservation & RabbitMQ  

1. **Checkout request** → backend invokes the Redis Lua script and first reads product metadata from PostgreSQL.  
2. If stock is sufficient, the script atomically:  
   - Decrements `product:stock:<id>`.  
   - Writes the 5‑minute reservation hold and per‑user limit keys.  
   - Returns the token + remaining stock.  
3. The backend publishes the reservation payload to RabbitMQ with **publisher confirms** and `persistent: true`.  
4. The HTTP request returns `202 QUEUED_FOR_CONFIRMATION` immediately; database work is fully decoupled.  
5. If RabbitMQ cannot confirm the publish, `rollback_reservation.lua` restores the stock and clears the hold, and the API returns `503` so no request is silently dropped or oversold.

The script guarantees **no two concurrent reservations can exceed the original stock** because Redis commands are executed sequentially. RabbitMQ makes the hand‑off durable: messages survive broker restarts and are only removed after the worker ACKs them.

### Worker  

* Connects to RabbitMQ with a **prefetch of 25** (`BATCH_SIZE`), so the broker will not deliver more unacknowledged messages than the worker can handle.  
* Buffers deliveries into a batch and flushes when the batch is full or after `BATCH_WINDOW_MS` (50 ms).  
* For the whole batch it opens one PostgreSQL transaction and performs a **conditional UPDATE**:  

  ```sql
  UPDATE products
  SET available_stock = available_stock - $1
  WHERE id = $2 AND available_stock >= $1
  RETURNING available_stock;
  ```

* On success, inserts the order and appends to `order_ledger` (immutable audit trail), then publishes a **SSE `CONFIRMED`** event via Redis Pub/Sub.  
* On stock mismatch, publishes a **SSE `SOLD_OUT`** event.  
* Uses a `SAVEPOINT` per message and `ON CONFLICT (order_token) DO NOTHING` so redelivered messages are idempotent.  
* ACKs all messages only after `COMMIT`; on any database error the transaction rolls back and all messages are NACKed for redelivery. Poison/unparseable messages are rejected without requeue and land in the `flashsale.orders.dead` queue.

### Database (Minimal Schema)  

Only three tables are required:

| Table | Columns (relevant) |
|------|--------------------|
| `products` | `id`, `title`, `flash_price`, `is_flash_sale`, `initial_stock`, `available_stock` |
| `orders` | `id`, `order_token`, `user_id`, `product_id`, `quantity`, `unit_price`, `total_price`, `status`, `created_at`, `expires_at` |
| `order_ledger` | `id`, `order_id`, `order_token`, `product_id`, `change_type`, `delta_stock`, `stock_after`, `created_at` |

Indexes on `is_flash_sale`, `order_token`, and `order_ledger.order_token` boost read/write performance under load.  

---  
###
# Data Flow Diagram  

```mermaid
flowchart TD
    UI[Browser UI] -->|GET /api/products/1| API[Backend API]
    UI -->|POST /api/checkout| API
    API -->|Lua script (atomic reserve)| Redis[Redis]
    API -->|Publish persistent order<br/>publisher confirm| Rabbit[RabbitMQ<br/>flashsale.orders]
    Rabbit -->|Prefetch 25 / manual ACK| Worker[Worker Process]
    Worker -->|Conditional UPDATE (PG) & INSERT ledger| PG[PostgreSQL]
    Worker -->|Publish SSE| SSE[Server‑Sent Events]
    SSE -->|EventSource| UI
    UI -->|Benchmark actions| API
    API -->|Read stats + queue depth| Redis & PG & Rabbit
```

---  

## Testing & Verification  

* **Concurrent stress test** – click **“Launch 1,000 Concurrent Requests Blitz”**, or run `node scripts/verify_concurrency.js`.  
* Observe:  
  * `stat-redis-stock` → should match `available_stock` in Redis.  
  * `stat-pg-stock` → same value from PostgreSQL.  
  * `stat-orders-count` → number of rows inserted into `orders`.  
  * `stat-oversell-count` → always `0 (Guaranteed)`.  
* RabbitMQ management UI → **http://localhost:15672** (`flashsale` / `flashsale`) shows the durable `flashsale.orders` queue, its consumer, and the dead‑letter queue.

---  

## Cleanup  

When you’re done testing, bring down the stack and optionally prune Docker artifacts:  

```bash
docker compose down --volumes   # removes containers + attached volumes (including DB data)
docker system prune -f          # removes dangling images, networks, etc.
```

---

###
# Conclusion


| **Feature** | **Legacy System** | **Proposed Solution** |
| :--- | --- | :--- |
| **Request** **Flow** | Synchronous, blocking database calls. | Asynchronous, decoupled queue processing. |
| **Stock** **Validation** | Soley based on Relational DB Atomicity. | In-Memory Redis + Atomic Scripting + Atomic DB Queries. |
| **Overselling Vulnerability** | Highly vulnerable, concurrent DB operations lead to race condition. | Atomic Redis Reservation + Conditional SQL. Secure against overselling. |
| **Peak Throughput Limit** | Restricted by database lock bottlenecks. | High scalability (Gateway & Redis tier) |
| **User Experience** | Blocking page render, duplicate clicks, poor status updates. | Optimised load times, debounced UI, optimistic SSE status tracking. |
---
