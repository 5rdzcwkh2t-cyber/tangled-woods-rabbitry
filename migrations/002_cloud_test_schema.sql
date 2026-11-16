-- Schema used by the existing isolated Cloudflare test endpoints.
-- Rabbit/litter/breeding relationships remain inside the JSON documents
-- because the current endpoints do not expose relational columns for them.

CREATE TABLE IF NOT EXISTS test_environment (
    marker TEXT PRIMARY KEY
        CHECK (marker = 'tangled-woods-dev-v2')
);

INSERT OR IGNORE INTO test_environment (marker)
VALUES ('tangled-woods-dev-v2');

CREATE TABLE IF NOT EXISTS rabbits (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sex TEXT NOT NULL CHECK (sex IN ('Buck', 'Doe')),
    data TEXT NOT NULL
        CHECK (json_valid(data) AND json_type(data) = 'object')
);

CREATE TABLE IF NOT EXISTS litters (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
        CHECK (json_valid(data) AND json_type(data) = 'object')
);

CREATE TABLE IF NOT EXISTS breedings (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
        CHECK (json_valid(data) AND json_type(data) = 'object')
);

