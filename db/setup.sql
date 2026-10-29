-- One-time setup for Cosmonym on the MariaDB / Galera cluster.
-- Run as an admin. Replace both passwords with long random values first
-- (e.g. `openssl rand -base64 33`), and put them only in the Portainer stack env.
--
-- Connections arrive from the Docker host E-Docker01 (10.10.20.199), so both
-- accounts are restricted to that address.

CREATE DATABASE IF NOT EXISTS cosmonym CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The app: reads and writes rows in its own database, nothing else.
-- No schema changes, no FILE, no GRANT, no access to any other database.
CREATE USER IF NOT EXISTS 'cosmonym'@'10.10.20.199' IDENTIFIED BY 'CHANGE_ME_APP_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE ON cosmonym.* TO 'cosmonym'@'10.10.20.199';

-- Schema changes: used briefly at startup to apply migrations, then disconnected.
-- Can change tables in this one database only.
CREATE USER IF NOT EXISTS 'cosmonym_migrate'@'10.10.20.199' IDENTIFIED BY 'CHANGE_ME_MIGRATE_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP ON cosmonym.* TO 'cosmonym_migrate'@'10.10.20.199';

FLUSH PRIVILEGES;
