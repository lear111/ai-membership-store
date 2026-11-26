-- Run as the DBA on the dedicated production MySQL instance.
CREATE DATABASE IF NOT EXISTS `membership_production`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
FROM information_schema.SCHEMATA
WHERE SCHEMA_NAME = 'membership_production';
