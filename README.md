# dep-cooldown

**Audit the dependency cooldown of a JavaScript project from its lockfile.**

A *dependency cooldown* (npm calls it `min-release-age`) tells your package
manager to ignore versions published less than N days ago. Almost every recent
npm supply-chain campaign was detected and pulled within hours — the malicious
`debug` and `chalk` versions were live for **two hours** — so a modest delay
takes you out of the exposure window entirely.

All four managers support it natively now. `dep-cooldown` answers the two
questions you have once you know that:

1. **Would it have helped?** Read the lockfile you already have, look up when
   every resolved version was actually published, and show what a 3-, 7- or
   30-day cooldown would have blocked — including, with `--as-of`, on the day
   you installed rather than today.
2. **How do I turn it on?** Print the paste-ready configuration block for npm,
   pnpm, Yarn or Bun — with the unit conversion done for you, because the four
   managers measure the same idea in **days, minutes, minutes and seconds**.

```bash
npx dep-cooldown                      # audit, 7-day threshold, exit 1 if anything is younger
npx dep-cooldown --min-age 3 --json   # machine-readable
npx dep-cooldown --config all         # the config blocks for all four managers
```

Zero-config, one runtime dependency (`yaml`), Node ≥ 20, MIT.

---

## Real output

Both examples run against a public repository at a pinned commit, so you can
reproduce them. Ages measured *today* drift; ages measured `--as-of` a commit
do not.

### A pnpm project: `unjs/h3`

```
$ git clone https://github.com/unjs/h3 && cd h3 && git checkout -q a5fdc86
$ npx dep-cooldown

dep-cooldown · pnpm-lock.yaml v9 · 437 packages
registry https://registry.npmjs.org · threshold 7d · ages as of 2026-09-14 (today)

All 437 audited package versions are at least 7 day(s) old as of 2026-09-14, none deprecated; the 1 skipped entry was not checked.

437 packages (45 direct) · 0 younger than 7d · 0 deprecated · 189 with provenance
1 skipped (1 workspace) - no registry publish date, not checked; --all lists them.
```

Nothing is young on 2026-09-14, because that commit is ten days old. The
interesting question is what the lockfile looked like the moment it was
written. A fresh clone stamps every file with the clone date, so ask git:

```
$ git log -1 --format=%cI -- pnpm-lock.yaml
2026-09-04T16:12:01+00:00

$ npx dep-cooldown --min-age 1 --as-of 2026-09-04T16:12:01+00:00

dep-cooldown · pnpm-lock.yaml v9 · 437 packages
registry https://registry.npmjs.org · threshold 1d · ages as of 2026-09-04 (--as-of)

PACKAGE                     VERSION      PUBLISHED   AGE  DEP     PROV  FLAGS
pnpm                        12.3.4       2026-09-04   1h  direct  yes   YOUNG
@pnpm/exe.darwin-arm64      12.3.4       2026-09-04   1h  trans.  yes   YOUNG
@pnpm/exe.darwin-x64        12.3.4       2026-09-04   1h  trans.  yes   YOUNG
@pnpm/exe.linux-arm64       12.3.4       2026-09-04   1h  trans.  yes   YOUNG
@pnpm/exe.linux-arm64-musl  12.3.4       2026-09-04   1h  trans.  yes   YOUNG
@pnpm/exe.linux-x64         12.3.4       2026-09-04   1h  trans.  yes   YOUNG
@pnpm/exe.linux-x64-musl    12.3.4       2026-09-04   1h  trans.  yes   YOUNG
@pnpm/exe.win32-arm64       12.3.4       2026-09-04   1h  trans.  yes   YOUNG
@pnpm/exe.win32-x64         12.3.4       2026-09-04   1h  trans.  yes   YOUNG
srvx                        1.0.3        2026-09-03  17h  direct  no    YOUNG
h3                          2.0.1-rc.31  2026-09-03  17h  direct  no    YOUNG
426 package(s) passed and are not listed; --all shows everything.

437 packages (45 direct) · 11 younger than 1d · 0 deprecated · 189 with provenance
1 skipped (1 workspace) - no registry publish date, not checked; --all lists them.
```

One day is pnpm's own default `minimumReleaseAge` since pnpm 11. Of the eleven
packages under it, `h3` and `srvx` sit on the project's
`minimumReleaseAgeExclude` list. The other nine are **pnpm 12.3.4 itself**,
pinned through `devEngines.packageManager` and committed at most two hours
after it was published — pnpm 11+ writes it into a separate YAML document at
the top of the lockfile, which is easy to miss when reading one. At a 7-day threshold the same
commit has **109** packages under the line. Exit code `1` either way.

### An npm project: `OrtaMarco/mx-fiscal-mcp-server`

The commit where this MCP server switched `mx-identifiers` from a local `file:`
path to the version just published on npm — by the same author:

```
$ git clone https://github.com/OrtaMarco/mx-fiscal-mcp-server && cd mx-fiscal-mcp-server && git checkout -q 32c6e8c
$ npx dep-cooldown --as-of 2026-09-10T10:47:13-06:00

dep-cooldown · package-lock.json v3 · 131 packages
registry https://registry.npmjs.org · threshold 7d · ages as of 2026-09-10 (--as-of)

PACKAGE         VERSION  PUBLISHED   AGE  DEP     PROV  FLAGS
mx-identifiers  1.0.0    2026-09-10   0h  direct  yes   YOUNG
zod             4.6.1    2026-09-09  18h  direct  yes   YOUNG
@types/node     22.20.2  2026-09-09  22h  direct  no    YOUNG
body-parser     1.20.8   2026-09-08  2.2  trans.  yes   YOUNG
jose            6.2.12   2026-09-05  5.3  trans.  yes   YOUNG
hono            4.13.7   2026-09-04  5.8  trans.  yes   YOUNG
125 package(s) passed and are not listed; --all shows everything.

131 packages (11 direct) · 6 younger than 7d · 0 deprecated · 40 with provenance
```

`mx-identifiers@1.0.0` was **at most nine minutes old** when that lockfile was
committed (published 16:37:54 UTC, committed 16:47:13 UTC).
A 7-day cooldown would have refused the author's own release — which is what
the exclusion keys are for: exempt what you publish yourself, and let the
cooldown hold back everything else. The day you install is the day the risk is
highest, which is precisely the day a cooldown is worth having.

## What the columns mean

| Column | Meaning |
|---|---|
| `PUBLISHED` | The registry's `time[version]`, i.e. when that exact version went live |
| `AGE` | Days between publication and the reference date (`--as-of`, or today), **truncated, never rounded up**: 6.96 days shows `6.9`. Under a day it shows hours. The threshold itself compares exact milliseconds |
| `DEP` | `direct` if the root `package.json` lists it, `trans.` otherwise |
| `PROV` | Whether the version carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements) (`dist.attestations`) |
| `FLAGS` | `YOUNG` = below `--min-age`; `FUTURE` = published after `--as-of`, so it did not exist that day (also counts as young); `DEPRECATED` = the registry marks this version deprecated |

By default only rows that need attention are printed. `--all` lists everything,
including the skipped lockfile entries; `--json` gives you the whole structure
with per-row `error` fields.

A row with no usable date — the registry returned an error, the version or its
date is missing or unreadable, or the lockfile's `resolved` URL is not the
registry tarball for that name and version — is **unknown**, and unknown is
never reported as passing. The `All N audited package versions are at least…`
line only appears when every audited row has a real date.

## Turning the cooldown on

The four managers agree on the idea and disagree on everything else. Every key,
unit and default below was read from the manager's own documentation on
**2026-09-09**:

| Manager | File | Key | Unit | Default | Exclusion key | Source |
|---|---|---|---|---|---|---|
| **npm** (CLI 11.10.0+) | `.npmrc` | `min-release-age` | **days** | `null` (off) | `min-release-age-exclude` (globs) | [docs.npmjs.com](https://docs.npmjs.com/cli/v11/using-npm/config#min-release-age) |
| **pnpm** (10.16+) | `pnpm-workspace.yaml` | `minimumReleaseAge` | **minutes** | `1440` from pnpm 11, `0` before | `minimumReleaseAgeExclude` | [pnpm.io](https://pnpm.io/settings/dependency-resolution#minimumreleaseage) |
| **Yarn** (Berry) | `.yarnrc.yml` | `npmMinimalAgeGate` | **minutes** (a bare number); a duration string like `7d` or `1w` also parses | `1d` | `npmPreapprovedPackages` | [yarnpkg.com](https://yarnpkg.com/configuration/yarnrc#npmMinimalAgeGate) |
| **Bun** | `bunfig.toml` `[install]` | `minimumReleaseAge` | **seconds** | unset (off) | `minimumReleaseAgeExcludes` | [bun.com](https://bun.com/docs/pm/cli/install#minimum-release-age) |

So a seven-day cooldown is `7`, `10080`, `10080` and `604800` depending on who
you ask. `--config` does that arithmetic:

```bash
$ npx dep-cooldown --config all --min-age 7

# A 7-day cooldown, in each manager's own unit:
#   npm   min-release-age          7 days
#   pnpm  minimumReleaseAge    10080 minutes
#   yarn  npmMinimalAgeGate    10080 minutes
#   bun   minimumReleaseAge   604800 seconds
...
```

`--config npm`, `--config pnpm`, `--config yarn` and `--config bun` print just
one block, each carrying the documentation URL as a comment.

Three details worth knowing, none of which are obvious from the key names:

- **Yarn's exclusion list is not named after the age gate.** It is
  `npmPreapprovedPackages`, and it exempts a package from *every* package gate,
  not only this one. Yarn's setting is also scopable through `npmScopes`.
- **pnpm turned it on by default in v11** (`minimumReleaseAge: 1440`). If you
  are on pnpm 11 you already have a one-day cooldown whether you asked or not.
- **The cooldown is enforced at install time, not at update-suggestion time.**
  Your dependency bot will happily open the PR and `npm ci` will fail afterwards.
  Set the same threshold in both places.

## Use in CI

```yaml
# .github/workflows/cooldown.yml
name: Dependency cooldown

on: [push, pull_request]

permissions:
  contents: read

jobs:
  cooldown:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22

      # No install step needed: dep-cooldown reads the lockfile, not node_modules.
      - name: Audit dependency cooldown
        run: npx --yes dep-cooldown --min-age 7
```

Because it never installs anything, no third-party lifecycle script runs in
that job. The exit code is the verdict:

| Code | Meaning |
|---|---|
| `0` | Every audited version is at least `--min-age` days old. Entries with no registry date (git, `file:`, `link:`, workspaces, remote tarballs) are listed as skipped, not checked |
| `1` | At least one version is younger than `--min-age`, or published after `--as-of` |
| `2` | Usage or tool error: a bad flag, no readable lockfile, or `--only-direct` / `--prod` leaving nothing to audit |
| `3` | Nothing is young, but some versions **could not be checked**: registry errors, `--offline` cache misses, missing or unreadable dates, or a `resolved` URL that is not the registry's tarball |

Exit `3` fails the job on purpose: a check that could not run is not a pass.
If you audit against a private registry that needs authentication —
`dep-cooldown` never sends tokens — every package comes back unknown, and
`--allow-unknown` turns that `3` into `0`. If the lockfile was resolved against
a mirror, the tool says so once per host; pass that mirror as `--registry`.

To report without blocking, add `continue-on-error: true`, or pipe `--json`
into whatever you use for annotations.

## Options

```
--min-age <days>      Flag versions younger than this, a plain decimal such as
                      7 or 0.5. Default: 7. Exits 1 when anything is flagged.
--allow-unknown       Exit 0 instead of 3 when nothing is flagged but some
                      versions could not be checked.
--as-of <date>        Measure ages against an ISO 8601 date instead of now:
                      2026-09-01, 2026-09-01T16:12:01Z or …+02:00. When omitted,
                      the report suggests your lockfile's own mtime.
--only-direct         Only packages listed in package.json.
--prod                Skip dependencies the lockfile marks development-only.
--top <n>             Show at most n rows, n >= 1 (sorted youngest first).
--all                 List every package and every skipped lockfile entry.
--json                Machine-readable output.
--config <target>     npm | pnpm | yarn | bun | all. Prints config, does not audit.
--offline             Never touch the network; use the cache and say what is missing.
--no-cache            Ignore and do not write the on-disk cache.
--clear-cache         Delete dep-cooldown's cache files and exit.
--registry <url>      Override the registry. Otherwise .npmrc is honoured.
--cwd <dir>           Run against another directory.
--lockfile <name>     Force a specific lockfile instead of detecting one.
--concurrency <n>     Parallel registry requests, n >= 1. Default: 8.
--no-color            Disable colour (already off when stdout is not a TTY).
```

An empty or malformed value is an error, never a default: `--min-age ""` from an
unset CI variable exits `2` instead of auditing with a threshold of zero.

### Lockfiles

| Format | Versions read | How direct dependencies are identified |
|---|---|---|
| `package-lock.json`, `npm-shrinkwrap.json` | v3, v2 (v1 via the legacy tree); the shrinkwrap wins when both exist, as it does for npm | the root entry's dependency fields |
| `pnpm-lock.yaml` | v9, v6 and v5.x (peer suffixes included), plus the environment document pnpm 11+ writes first | `importers`, or the top-level blocks on v5/v6; the pinned pnpm counts as direct |
| `yarn.lock` | Berry (v2+) and classic (v1) | your `package.json` and its workspace manifests — neither format records it |
| `bun.lock` | the text format, v0/v1 | the `workspaces` block |

With several lockfiles in one directory, the manifest's `packageManager` (or
`devEngines.packageManager`) decides which one is read, then the fixed order
bun, pnpm, Yarn, npm; a warning on stderr names the ones left unread.

**The lockfile's own `resolved` URL is checked, not just its `version` field.**
`npm ci` installs whatever `resolved` points to, so a lockfile that says
`4.17.21` but resolves to the `4.17.22` tarball would otherwise be dated as
`4.17.21`. When the URL is not the registry tarball for that name and version,
or comes from a host other than the registry being asked, the row is unknown
(exit `3`). `registry.npmjs.org` and `registry.yarnpkg.com` count as the same
registry, and a tarball on the public registry is accepted whatever registry
you audit against, because npm rewrites that host to the configured one at
install time (`replace-registry-host`). Aliases (`foo@npm:bar@1`) are looked up under the published name.

Entries with no registry publish date are **listed, never dropped silently**:
the summary line counts them and `--all` prints each one with its reason —
`git` (git dependencies, codeload), `file` (`file:` and local tarballs), `link`
(`link:`, `portal:`), `workspace` (workspace members), `tarball` (a URL that is
not a registry tarball) and `other` (a name or version no registry could serve).
A Yarn `patch:` over a registry package audits the base package.

### Network, cache and registries

The publish dates only exist in the **full** packument — the abbreviated one
npm's installer uses (`application/vnd.npm.install-v1+json`) has no `time`
field — so `dep-cooldown` fetches `https://registry.npmjs.org/<pkg>`, at most 8
at a time, and caches a trimmed record (dates, provenance flag, deprecation) for
24 hours under `~/.cache/dep-cooldown/` (created `0700`; `DEP_COOLDOWN_CACHE_DIR`
moves it). An entry that is corrupt, belongs to another package or claims to
have been fetched in the future counts as absent. `--clear-cache` removes only
its own files and never follows symlinks.

**Which registry.** `--registry`, then `npm_config_registry` (any casing; an
empty value is ignored), then the project `.npmrc`, then your user config
(`NPM_CONFIG_USERCONFIG`, which is where `actions/setup-node` writes it, or
`~/.npmrc`), then the public registry. `@scope:registry=` follows the same
order. `${VAR}` expands the way npm 11 expands it: `${VAR?}` gives an empty
string, `\${` escapes, and an unset variable stays literal.

**What it never does.** It never sends a token, a password or URL userinfo to
any registry, so a private registry that needs authentication answers with an
error and those rows are unknown. Reports show the registry with userinfo as
`***` and `${VAR}` as written, never its value. Note that, exactly as with
`npm ci`, a hostile project `.npmrc` can still put an environment variable into
the request *path*; audit untrusted checkouts with `--registry`.

**Limits.** 30 s per attempt, 60 s per package, three attempts, and 128 MiB per
packument — twice the largest on npm today (`renovate`, 66 MiB in September
2026). Redirects are followed only within the same origin, plus `http` to
`https` on the same host. A name that is not a valid npm package name is an
error for that package and never becomes a request. Error messages carry status
codes and the tool's own words, never bytes from the server.

A registry that returns no `time` data leaves those rows unknown rather than
guessing. `--offline` works entirely from the cache and tells you what it could
not find.

## What this does *not* protect you from

A cooldown buys time against a compromised **publish**. It is not a general
supply-chain defence, and this section exists so nobody deploys it thinking it
is one:

- **A compromised build runner.** The May 2026 Shai-Hulud wave against TanStack
  entered through trusted publishing itself: the payload ran inside the
  project's own GitHub Actions runner, requested an OIDC token with the
  workflow's `id-token: write`, and minted a **genuine** Sigstore bundle through
  Fulcio and Rekor. Provenance answers "was this built where it says?", and the
  answer was yes. So the `PROV` column here is information, **not a safety
  rating** — a compromised release can carry perfectly valid provenance.
- **Malicious lifecycle scripts.** A cooldown decides *which* version you
  install, not what happens during installation. Use `npm ci --ignore-scripts`
  in every CI job that does not need hooks.
- **A campaign that outlives your threshold.** Seven days covers most known
  incidents, not all of them, and the number is a bet, not a proof.
- **Anything already in your lockfile.** The gate applies when resolving; a
  version pinned last month is installed regardless.

The complementary measures — splitting the install runner from the publish
runner, `--ignore-scripts`, auditing `pull_request_target` — are covered in
[npm Supply Chain: The Worm That Walked In Through Trusted Publishing](https://ortamarco.me/en/blog/npm-supply-chain-trusted-publishing-not-enough/).

This project also practises what it audits: its own `.npmrc` carries
`min-release-age=7`, and CI runs `dep-cooldown` against its own lockfile.

## Prior art

There is real work in this space already. `dep-cooldown` is not the first tool
to look at release ages; what is new is the **combination** — a lockfile audit
(all four formats), a retrospective `--as-of` simulation, provenance and
deprecation in the same table, and config generation for all four managers.
Here is where the others actually stand, checked against their published code
on 2026-09-14:

| | Reads a lockfile | Retrospective `--as-of` | Provenance | Emits PM config | What it is for |
|---|---|---|---|---|---|
| [`pkg-age`](https://www.npmjs.com/package/pkg-age) | no (`package.json`) | no | no | no | Is this dependency **stale or abandoned** — age of `latest`, major drift, deprecation, risk score |
| [`pmsec`](https://github.com/HikaruEgashira/pmsec) | no | no | no | **writes it for you**, 9 managers | Applies a whole hardening bundle (cooldown is one row of ~45) to your **user-global** configs |
| [`Zwyx/npm-cooldown`](https://github.com/Zwyx/npm-cooldown) | npm only (`package-lock.json`), opt-in: `--paranoid` blocks the install if any locked version is under N days | no — fixed at *now − N days* | no | no | An `npm install` **wrapper** that installs the tree as it was N days ago |
| [`@jagreehal/screen-node`](https://github.com/jagreehal/screen-node) | partially, with `--deep` — npm v2/v3, pnpm v9, Yarn classic; pnpm v6, Yarn Berry and Bun fall back to direct deps, and a multi-document pnpm lockfile yields only its pnpm self-install section | no — always *now* | partially — flags a *provenance regression*, direct deps only | no | An install **wrapper** for all four managers that blocks too-fresh, deprecated or malware-flagged versions; `delta` gates only what a PR adds |
| [`@moneytree/supply-chain-guard`](https://github.com/moneytree/supply-chain-guard) | partially — npm and Yarn classic (Berry only at lockfile version 9); no pnpm or Bun, which pass silently | no — always *now* | no | no | A multi-ecosystem **CI gate** that fails when a committed lockfile holds a version younger than N days; by default it skips lockfiles untouched in that window |
| [`getjerry/npm-cooldown`](https://github.com/getjerry/npm-cooldown) | yes (npm, yarn, pnpm) | no — diffs git revisions | no | no | CI gate on **added or changed** packages between two revisions |
| [`check-outdated --min-age`](https://github.com/jens-duttke/check-outdated) | no (wraps `npm outdated`) | no | no | no | An `npm outdated` replacement that **recommends** an age-qualified upgrade |
| [`npm-check-updates --cooldown`](https://github.com/raineorshine/npm-check-updates) | no (`package.json`) | no | no | no — but it **reads** your existing npm/pnpm/Yarn cooldown config | Finds upgrades, skipping ones that are too fresh |
| **`dep-cooldown`** | **yes — npm, pnpm, Yarn, Bun** | **yes** | **yes** | **yes, all four** | Auditing what you already resolved, and switching the gate on |

Honest notes on those:

- **`npm-cooldown` is two different projects.** Only [Zwyx's](https://github.com/Zwyx/npm-cooldown)
  owns the npm name; [getjerry's](https://github.com/getjerry/npm-cooldown) has
  never been published (`0.0.0-development`, last commit November 2025), so its
  README's `npm install -g npm-cooldown` would fetch the *other* tool.
- **`pmsec` is the complement of this tool, not a rival.** It never inspects
  your dependencies; it writes hardened configuration. Note the maintained
  package is unscoped `pmsec` — `@hikae/pmsec` is a stale mirror.
- **`check-outdated --min-age` is subtler than a threshold.** It picks the
  highest Major.Minor line with a qualifying version, then the newest patch in
  that line (`--min-age-patch`, default 0), on the reasoning that patches are
  low-risk fixes.
- **`npm-check-updates` is by far the most used** (~3M downloads/month) and its
  `--cooldown` will read your manager's native config when you do not pass one.
  If you only want upgrade suggestions to respect a cooldown, use ncu; this tool
  answers a different question about a lockfile that already exists.
- **Only `screen-node` looks at npm provenance**, and only to flag a direct
  dependency whose new version dropped it; none reports provenance across the
  resolved tree. None of the eight does a retrospective simulation against an
  arbitrary date — `screen-node`'s library accepts a `now`, but ignores versions
  published after it, so it cannot replay an install.
- **Two of them read a lockfile and still miss formats without saying so.**
  Against real lockfiles, `supply-chain-guard` exits `0` with "Scanned 0
  manifest files" on a pnpm project, and `screen-node --deep` on a pnpm 12
  lockfile only checks the pnpm binary in its first YAML document. This is not a
  dig: `dep-cooldown` crashed on that same multi-document lockfile until
  2026-09-14.

## API

The pieces are exported if you want to build on them:

```ts
import { detectAndParse, createRegistryClient, buildAudit, resolveRegistry } from 'dep-cooldown';

const lock = await detectAndParse(process.cwd());
const config = resolveRegistry(process.cwd());
const client = createRegistryClient({ config });
const meta = await client.fetchAll(lock.entries.map((e) => e.name));

const result = buildAudit(lock, meta, {
  minAgeDays: 7,
  asOf: new Date('2026-08-23'),
  registry: config.default,
});
console.log(result.totals);
```

`createRegistryClient` takes a `fetchImpl`, which is how the test suite runs
without a network.

## Development

```bash
npm install
npm run build        # tsup -> ESM in dist/
npm test             # builds, then node --test over test/*.test.js
npm run test:network # also runs the opt-in tests that hit the real registry
npm run typecheck
```

The fixtures in `test/fixtures/` are seven lockfiles — npm v2 and v3, pnpm v6
and v9, Yarn classic and Berry, and `bun.lock` — all generated from the *same*
`package.json`, so every parser must agree on the same 14 packages. A
format-specific bug shows up as a disagreement between siblings. The registry is
mocked from `test/fixtures/registry/*.json`; only `test/network.test.js` leaves
the machine, and only with `DEP_COOLDOWN_NETWORK=1`.

## Licence

MIT © [Marco Orta](https://ortamarco.me)

---

## En español

**`dep-cooldown` audita el enfriamiento de dependencias de un proyecto
JavaScript leyendo su lockfile.**

Un *cooldown* (npm lo llama `min-release-age`) le dice a tu gestor de paquetes
que ignore las versiones publicadas hace menos de N días. Casi todas las
campañas recientes contra npm se detectaron y retiraron en horas — las versiones
maliciosas de `debug` y `chalk` estuvieron vivas **dos horas** — así que un
retraso modesto te saca por completo de la ventana de exposición.

```bash
npx dep-cooldown                      # audita con umbral de 7 días; sale con 1 si algo es más joven
npx dep-cooldown --as-of 2026-08-23   # ¿qué habría bloqueado el día que instalé?
npx dep-cooldown --config all         # el bloque de configuración de los cuatro gestores
```

Qué hace, en concreto:

1. **Detecta y lee el lockfile** — `package-lock.json` (v2 y v3),
   `pnpm-lock.yaml` (v6 y v9), `yarn.lock` (classic y Berry) y `bun.lock`.
2. **Consulta la fecha de publicación** de cada versión resuelta en el registro,
   con concurrencia limitada a 8, caché en disco de 24 h en
   `~/.cache/dep-cooldown/` y respeto por el `registry=` de tu `.npmrc`. Nunca
   envía tokens, y comprueba que el `resolved` del lockfile sea de verdad el
   tarball del registro para esa versión.
3. **Informa** en tabla o `--json`: paquete, versión, fecha, edad en días,
   directa o transitiva, si trae **procedencia** (`dist.attestations`) y si está
   **deprecada**. Lo que no tiene fecha de registro (git, `file:`, workspaces)
   se lista como omitido, nunca desaparece en silencio.
4. **Sale con un código que es el veredicto**: `0` todo tiene la edad mínima,
   `1` algo es más joven, `2` error de uso, y `3` nada es joven pero algo **no
   se pudo comprobar** — que no es lo mismo que aprobar. `--allow-unknown`
   convierte ese `3` en `0`.
5. **`--as-of <fecha>`** calcula la edad respecto a esa fecha en lugar de hoy.
   Es lo que permite responder «¿qué habría bloqueado un cooldown de 3 o 7 días
   el día que instalé esto?». Cuando no la pasas, el informe te sugiere la fecha
   de modificación de tu propio lockfile.
6. **`--config`** imprime la configuración lista para pegar, **con la trampa de
   las unidades resuelta**.

### La trampa de las unidades

Los cuatro gestores están de acuerdo en la idea y en desacuerdo en todo lo
demás. Cada clave, unidad y valor por defecto se verificó en la documentación
oficial de cada gestor el **9-sep-2026** (los enlaces están en la tabla inglesa
de arriba):

| Gestor | Archivo | Clave | Unidad | Por defecto | Clave de exclusión |
|---|---|---|---|---|---|
| npm (CLI 11.10.0+) | `.npmrc` | `min-release-age` | **días** | `null` (apagado) | `min-release-age-exclude` |
| pnpm (10.16+) | `pnpm-workspace.yaml` | `minimumReleaseAge` | **minutos** | `1440` desde pnpm 11 | `minimumReleaseAgeExclude` |
| Yarn (Berry) | `.yarnrc.yml` | `npmMinimalAgeGate` | **minutos** (número suelto); también acepta `7d` o `1w` | `1d` | `npmPreapprovedPackages` |
| Bun | `bunfig.toml` `[install]` | `minimumReleaseAge` | **segundos** | sin valor (apagado) | `minimumReleaseAgeExcludes` |

Siete días son `7`, `10080`, `10080` y `604800` según a quién le preguntes.
Tres detalles que las claves no dejan ver:

- **La lista de exclusión de Yarn no lleva el nombre de la puerta de edad.** Es
  `npmPreapprovedPackages`, y exime al paquete de *todas* las puertas, no solo
  de esta.
- **pnpm 11 lo trae encendido por defecto** (`minimumReleaseAge: 1440`).
- **El cooldown se aplica al instalar, no al sugerir actualizaciones.** Tu bot
  de dependencias abrirá el PR igual y el `npm ci` fallará después: pon el mismo
  umbral en los dos sitios.

### Lo que un cooldown NO te protege

Esto importa más que la lista de funciones. Un cooldown compra tiempo contra una
**publicación** comprometida, y nada más:

- **No protege contra un runner de CI comprometido.** La oleada de Shai-Hulud
  contra TanStack de mayo de 2026 entró por el propio trusted publishing: el
  payload corrió dentro del runner del proyecto, pidió un token OIDC con el
  `id-token: write` del workflow y generó una procedencia Sigstore **auténtica**
  vía Fulcio y Rekor. Por eso la columna `PROV` es información, **no una nota de
  seguridad**.
- **No protege contra un `postinstall` malicioso.** El cooldown decide *qué*
  versión instalas, no qué pasa durante la instalación. Usa
  `npm ci --ignore-scripts` en todo job de CI que no necesite hooks.
- **No protege contra una campaña que dure más que tu umbral**, ni contra lo que
  ya está fijado en tu lockfile.

El resto de medidas está en el artículo
[«npm y el trusted publishing»](https://ortamarco.me/blog/npm-trusted-publishing-no-basta/).

### Licencia

MIT © [Marco Orta](https://ortamarco.me)
