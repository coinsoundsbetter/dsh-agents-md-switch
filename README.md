# dsh-agents-md-switch

One global switch for one question: **should the workspace instruction files
(`AGENTS.md` / `CLAUDE.md`) be injected into the model context?**

A bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a host
half and a client half, no build step. 中文说明见 [README.zh.md](./README.zh.md).

## The gap this fills

DSH delivers the workspace instruction files from `@deepseek-ai/dsh-agent-instructions`.
That plugin does **not** go through `ctx.systemPrompt`: it appends a user message tagged
`source.kind === 'agent-instructions'` to the batch inside the `agent/pre-step`
waterfall, and it is mounted **per agent preset**.

So without this plugin there are only two native ways to switch injection off:

1. delete that plugin's row from every preset you use;
2. set its `maxBytes` to `0` in a profile patch.

Both mean maintaining a copy of a whole preset, and neither is a toggle you can flip
while you are working.

## What it does

This plugin intercepts at the step boundary instead. While the switch is on, the
instruction messages are removed from the batch that is about to enter the model
context, and the entries the instruction plugin parked in the agent's inbox are cleared
so the files are not re-read on every step.

| Property | Behaviour |
| --- | --- |
| Preset independent | `standard`, `ptc`, `cordis` and any custom preset obey the same switch. |
| Live | Takes effect from the **next step of the current session**. No restart, no new session needed. |
| Non-destructive | Session history on disk is never rewritten, and nothing is deleted from your repository. |
| Order independent | The listener registers with `{ prepend: true }`, so it stays outermost in the waterfall regardless of plugin mount order or hot-reload re-registration. |
| Default off | The switch starts off, so injection stays on until you ask for it to stop. Only an explicit `false` in the config — which is what turning the switch on writes — intercepts, so a missing value or a schema change can never alter existing behaviour by accident. |

What it is **not**: it does not stop the instruction plugin from discovering and reading
the files, and it cannot suppress instruction-like content injected by some other plugin
under its own source kind. Suppressing means "not injected into the context", not "not read".

## Install

From the plugin manager: sidebar **Plugins** → **Add plugin** → type
`dsh-agents-md-switch` (a bare name, a name with a version, a Git URL, a tarball or an
absolute path are all accepted) → **Install** → **Enable now**.

On a build that ships the CLI, the equivalent command is:

```bash
dsh plugin add dsh-agents-md-switch
```

The install source defaults to whatever registry pnpm itself points at; on first use the
host probes the official npm registry and the mainland mirror and keeps whichever
answers first. The declared DSH peer range is checked **before** pnpm runs, so an
unsupported DSH release fails the install without downloading anything.

Requires DSH `0.1.7-rc.2` or newer, and Node `^22.19.0 || >=24.0.0`.

## Use

There are two entry points, and they are the same setting:

- **Settings → General** — a row titled *Disable AGENTS.md injection*. This one is the
  switch: click it and you are done.
- **Settings → Plugins → dsh-agents-md-switch → the row → Configure** — the bundle's own
  configuration page, which also shows a one-line summary on the card.

The value is persisted by DSH's config editor into your profile's `cordis.patch.yml` as
an override row for `inject-agents-md`, so it survives restarts and applies to every
session in that profile.

## Compatibility and risk

This plugin is coupled to two internal contracts: the `agent/pre-step` waterfall and the
`source.kind === 'agent-instructions'` tag. It was verified against DSH `0.1.7-rc.2`, and
`package.json` declares `"@deepseek-ai/dsh-settings": ">=0.1.7-rc.2"` so that the host's
own compatibility check warns you if you install it on an older runtime. If a future
release renames the event or the source kind, the switch would silently stop
intercepting — check `CHANGELOG.md` for the verified release before upgrading DSH.

## Implementation notes

Four things worth knowing if you write a plugin like this one. Each of them cost real
debugging time here.

1. **The config field must be `.volatile()`.** `dsh-settings`'s `volatileForm()` only
   projects volatile fields; an unmarked field yields no descriptor, and with no
   descriptor the settings UI has no control for the row at all. Marking it volatile also
   makes writes update the config in place instead of remounting the plugin, so the
   `config` object captured by `apply` stays valid.

2. **The `inject` face is not spread verbatim.** `ctx.slots.register(options, Comp)`
   takes `options.inject`, whose return value becomes the component props — but
   `dsh-client-ui-renderer` first lifts every entry of `hooks` to the top level, renaming
   `name` to `use<Capitalised>` and wrapping it as a selector Hook. So
   `inject: () => ({ hooks: { agentsMd: form } })` gives the component
   `props.useAgentsMd`, and there is **no** `props.hooks`. The failure is nasty: reading
   the wrong prop gives `undefined`, the click throws synchronously inside the React
   event handler, React swallows it, and the UI hangs on "Saving…" while nothing is ever
   written. Every exit of the write path here therefore reaches visible text —
   synchronous throw, refusal, and a 12-second timeout.

3. **The client half is a pre-built artifact.** `dsh-client-modules` serves
   `lib/client.js` verbatim and never compiles it, so the file is hand-written in the
   lazy-CJS shape `window.__ModuleLoader__.load({ id, factory })`. The cost is no JSX, so
   components use `React.createElement`; the benefit is that this repository needs no
   bundler and `lib/client.js` is publishable as-is. Only `react` and the static
   primitives library are required, both of which the shell already provides.

4. **Writes need no custom RPC.** The General row goes through the
   `ConfigFormController` obtained from `ctx.configForms.get(ns)`
   (`getSnapshot` / `subscribe` / `set`); the plugin row uses the `form` owner prop
   (`{ state, mutate }`). Both land in `ctx.remote.settings.mutate`, which the host's
   config editor persists. Both surfaces are registered only while the host actually
   serves the namespace (`ctx.configForms.whileServed`), because a control that cannot be
   operated is worse than no control.

## Development

```bash
node scripts/check-release.mjs   # preflight: placeholders, declared files, locale key parity
DSH_AGENTS_MD_SWITCH_DEBUG=1 ... # opt-in host-side tracing on stderr
```

- Editing `lib/client.js` only needs the bundle to be recomposed; the client bundle
  revision is derived from its file metadata and HMR picks it up live.
- Editing `index.js` or `package.json` needs a host restart (or a new package name and
  directory), because Node's ESM cache and the client module metadata are cached for the
  process lifetime.
- The host half deliberately writes **no files**. Release the log habit before publishing.

## Publishing

Every release needs a new version, because npm refuses to publish a version that already
exists. One command does the preflight, bumps `package.json`, and publishes:

```bash
npm run release -- patch        # patch | minor | major | an exact x.y.z
npm run release -- patch --dry-run   # rehearse: preflight only, change nothing
git add -A && git commit -m "release: vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags
```

Finalize `CHANGELOG.md` **before** you publish — `npm run release` does not touch it, and
the file ships inside the tarball, so a section still headed `Unreleased` would appear that
way on the package page:

1. Rename `## [Unreleased]` to `## [x.y.z]` and add the release date.
2. Retarget the reference link to the new tag (`…/compare/v1.0.0...v1.1.0`), and add a fresh
   `[Unreleased]: …/compare/v1.1.0...HEAD` if you want to keep collecting changes.
3. Run `npm run release` with the bump that yields that same version — from `1.0.0`, `minor`
   gives `1.1.0`.

`npm run release` deliberately does not run git: it bumps `package.json` with
`--no-git-tag-version`, and prints the commit, tag and push commands for you to run.

On an account whose second factor is a security key, the CLI cannot answer npm's OTP
challenge, so publishing needs a **granular access token with “bypass 2FA” enabled**
(npmjs.com → Access Tokens → Generate New Token → Granular Access Token → *Read and
write* → *Allow this token to bypass 2FA*):

```bash
export NPM_TOKEN=npm_...        # PowerShell: $env:NPM_TOKEN = 'npm_...'
npm run release -- patch
```

The token is read from the environment only — never written to `package.json`, `.npmrc`,
or this repository. Revoke it when you no longer need it.

`.github/workflows/publish.yml` publishes on a GitHub release through npm trusted
publishing (OIDC, no long-lived token). Configure the trusted publisher once — package →
Settings → Trusted publishing → GitHub Actions → this repository, workflow `publish.yml`,
environment blank — and afterwards releases need neither a token nor a second factor. A
brand-new package still needs one token-based `npm publish` first, because a trusted
publisher can only be attached to a package that already exists. See the comments in that
workflow.

The identity fields used to be placeholders and are filled once, before the first
publish, with `npm run fill-identity`.

## License

[MIT](./LICENSE)
