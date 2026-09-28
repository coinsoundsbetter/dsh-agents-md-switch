# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The settings row is now titled **"Disable AGENTS.md injection"** (「关闭 AGENTS.md 注入」)
  rather than "Enable AGENTS.md injection". DSH injects the workspace instruction files by
  default, so the switch is phrased as the action a user actually performs, and a default
  profile now shows it **off**; turning it on is what suppresses injection.
- The row's explanation states that default explicitly instead of describing what happens
  once it is switched off, and the bundle row's one-line summary follows the new wording.
- The host half's `Config` description now presents the field as the positive form of the
  setting and notes that the settings switch stores its inverse.

### Notes

- **No migration is needed.** This is a presentation change only. The persisted field is
  still `injectAgentsMd` and still positive, so an existing
  `config: { injectAgentsMd: false }` override keeps meaning "do not inject"; only its
  representation in the settings UI is inverted. A profile that already suppressed
  injection shows the switch as **on** after upgrading — the same state, drawn the other
  way round.

## [1.0.0]

First public release.

### Added

- Global switch `injectAgentsMd` (default `true`) that suppresses workspace instruction
  injection for every agent preset, live and without a restart.
- Settings → General row, registered through `dsh.client` slots at order 16.
- Configuration page on this bundle's own row under Settings → Plugins.
- Chinese and English interface text, following the active interface language.

### Verified against

- DSH `0.1.7-rc.2` (the switch was confirmed live: with it off, no
  `source.kind === 'agent-instructions'` message reached the step batch, and with it on
  the message reappeared on the next step of the same session).

[Unreleased]: https://github.com/coinsoundsbetter/dsh-agents-md-switch/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/coinsoundsbetter/dsh-agents-md-switch/releases/tag/v1.0.0
