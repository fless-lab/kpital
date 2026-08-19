-- Runs once on first cluster init. Creates the dedicated test database
-- used by the api integration tests (TEST_DATABASE_URL).
CREATE DATABASE kpital_test OWNER kpital;
