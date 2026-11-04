/**
 * The exit run (P2-18) drives the real server with real git and `GIT_CONFIG_GLOBAL=/dev/null`, so
 * git has no email and falls back to a host-name lookup that hangs where name lookups are blocked
 * (P11-11). `EMAIL` is git's last resort, below any configured `user.email`.
 */
process.env.EMAIL ??= 'test@galactic.invalid';
