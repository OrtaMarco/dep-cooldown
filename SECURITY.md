# Security policy

`dep-cooldown` runs against lockfiles, `.npmrc` files and registries you may not
control, so a flaw in it is a supply-chain flaw. Please report one privately.

## Reporting

Use **[Report a vulnerability](https://github.com/OrtaMarco/dep-cooldown/security/advisories/new)**
(GitHub private vulnerability reporting). If that is not available to you,
write to contacto@ortamarco.me.

Include the version (`dep-cooldown --version`), the command you ran, and the
smallest lockfile, `.npmrc` or registry response that reproduces it. You should
get an answer within a week.

## In scope

- The tool reporting a version as old enough, or exiting `0`, when it did not
  check it.
- Credentials from `.npmrc` or the environment being sent anywhere or printed.
- A lockfile, `.npmrc` or registry response that can write outside the cache
  directory, drive the terminal, hang the tool or exhaust its memory.
- The published package not matching this repository (releases are built and
  published from a tag by `.github/workflows/publish.yml` with npm provenance).

## Out of scope

What a cooldown does not protect against is documented in the README: a
compromised build runner, malicious lifecycle scripts, and campaigns that last
longer than your threshold.

## Supported versions

Only the latest release receives fixes.
