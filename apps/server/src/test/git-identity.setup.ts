/**
 * Tests run git with `GIT_CONFIG_GLOBAL=/dev/null`, so git has no email and falls back to a
 * host-name lookup for the reflog, which hangs where name lookups are blocked (P11-11). `EMAIL`
 * is git's last resort, below any configured `user.email`, so it changes no test's identity.
 */
process.env.EMAIL ??= 'test@galactic.invalid';
