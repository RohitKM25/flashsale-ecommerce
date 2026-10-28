-- Flash-Sale High Concurrency E-Commerce Database Schema
-- ACID-Compliant with Immutable Ledger Table

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    specs JSONB,
    price NUMERIC(10, 2) NOT NULL,
    flash_price NUMERIC(10, 2),
    is_flash_sale BOOLEAN DEFAULT FALSE,
    initial_stock INT NOT NULL DEFAULT 0,
    available_stock INT NOT NULL DEFAULT 0,
    image_svg TEXT,
    rating NUMERIC(3, 2) DEFAULT 4.9,
    review_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    order_token VARCHAR(64) UNIQUE NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    product_id INT NOT NULL REFERENCES products(id),
    quantity INT NOT NULL DEFAULT 1,
    unit_price NUMERIC(10, 2) NOT NULL,
    total_price NUMERIC(10, 2) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'CONFIRMED',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Immutable Append-Only Ledger for Audit & Write-Ahead-Log
CREATE TABLE IF NOT EXISTS order_ledger (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(id),
    order_token VARCHAR(64) NOT NULL,
    product_id INT NOT NULL REFERENCES products(id),
    change_type VARCHAR(32) NOT NULL,
    delta_stock INT NOT NULL,
    stock_after INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(id),
    user_name VARCHAR(100) NOT NULL,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT NOT NULL,
    verified_purchase BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for ultra-fast query execution under load
CREATE INDEX IF NOT EXISTS idx_products_flash_sale ON products(is_flash_sale);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(order_token);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_token ON order_ledger(order_token);
CREATE INDEX IF NOT EXISTS idx_ledger_product ON order_ledger(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);

-- Seed Data: 500 Flash Sale Flagship Smartphones & General Catalog
INSERT INTO products (id, title, slug, category, description, specs, price, flash_price, is_flash_sale, initial_stock, available_stock, image_svg, rating, review_count)
VALUES 
(
    1,
    'Smartphone X',
    'smartphone-x',
    'Smartphones',
    'Fast Charge, USB-C, Audio-Jack 3mm',
    '{"display": "6.8 inch 144Hz 2K AMOLED", "processor": "Snapdragon 8 Gen 3 (3nm)", "ram": "16GB LPDDR5X", "storage": "512GB UFS 4.0", "battery": "5400mAh, 120W FastCharge", "network": "5G Dual SIM, Wi-Fi 7"}',
    1199.99,
    399.99,
    TRUE,
    500,
    500,
    'smartphone',
    4.95,
    148
)
ON CONFLICT (id) DO UPDATE SET 
    initial_stock = EXCLUDED.initial_stock,
    available_stock = EXCLUDED.available_stock;

-- Seed Initial Reviews for the Flagship Smartphone
INSERT INTO reviews (product_id, user_name, rating, comment, verified_purchase)
VALUES
(1, 'Marcus Vance', 5, 'Got early media access to the Titan 5G. The build quality in hand is astounding, and 120W charging hits 100% in 18 minutes flat.', TRUE),
(1, 'Elena Rostova', 5, 'The 200MP sensor with optical image stabilization produces cinema-grade photos even in pitch darkness. Insane festival price!', TRUE),
(1, 'David K.', 5, 'Super fluid 144Hz screen. The thermal cooling chamber keeps temperatures chill during heavy gaming sessions. Cannot wait for 8:00 PM drop.', TRUE),
(1, 'Priya Sharma', 4, 'Stunning titanium frame, very lightweight for a 6.8 inch device. Highly recommend picking this up during the flash sale.', TRUE);
