BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended('user:u1', 0));
INSERT INTO v SELECT 'A' WHERE (SELECT count(*) FROM v) < 1;
SELECT pg_sleep(1);
COMMIT;
