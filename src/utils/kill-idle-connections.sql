-- Kill all idle connections to megatron_v2 database
-- Run this as postgres superuser

SELECT 
    pg_terminate_backend(pid),
    pid,
    usename,
    application_name,
    state
FROM pg_stat_activity
WHERE datname = 'megatron_v2'
  AND state = 'idle'
  AND pid <> pg_backend_pid(); -- Don't kill current connection

-- Also kill connections idle in transaction
SELECT 
    pg_terminate_backend(pid),
    pid,
    usename,
    application_name,
    state
FROM pg_stat_activity
WHERE datname = 'megatron_v2'
  AND state = 'idle in transaction'
  AND pid <> pg_backend_pid();