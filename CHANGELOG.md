# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/coinsoundsbetter/dsh-agents-md-switch/releases/tag/v1.0.0
