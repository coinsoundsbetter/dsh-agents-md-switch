/**
 * dsh-agents-md-switch — host half.
 *
 * A single global switch for one question: should the workspace instruction files
 * (AGENTS.md / CLAUDE.md and their `.local.md` variants) be injected into the model
 * context?
 *
 * Why this needs to be a plugin: the injection belongs to
 * `@deepseek-ai/dsh-agent-instructions`, which does not go through
 * `ctx.systemPrompt`. It inserts a user message with
 * `source.kind === 'agent-instructions'` into the step's message batch inside the
 * `agent/pre-step` waterfall. That plugin is mounted per agent preset, so the only
 * native ways to switch injection off are to delete its row from a preset or to set
 * its `maxBytes` to 0 — both of which require maintaining a copy of the whole preset.
 *
 * This plugin intercepts at the step boundary instead:
 *   - preset independent: standard / ptc / cordis and any custom preset all obey it;
 *   - flipping the switch needs no restart and no per-preset duplicate;
 *   - it only affects the batch about to enter the model context; session history
 *     already on disk is never rewritten.
 *
 * The listener registers with `{ prepend: true }` so it stays outermost in the
 * waterfall: inner layers (including dsh-agent-instructions) compute their decision
 * first, then the injected instruction messages are dropped. That makes the outcome
 * independent of plugin mount order and of re-registration after a hot config reload.
 *
 * The config field is marked `volatile`: `dsh-settings`'s `volatileForm()` only
 * projects volatile fields, so an unmarked field produces no descriptor and the row
 * would have no configuration control in the settings UI. Marking it volatile also
 * makes writes update the config in place instead of remounting the plugin, so the
 * `config` object captured by `apply` stays valid for the whole lifetime.
 *
 * @module dsh-agents-md-switch
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package label used in diagnostics. */
const LABEL = 'dsh-agents-md-switch';
/** The switch field name; the client half reads and writes the same name. */
const FIELD = 'injectAgentsMd';
/** Producer source tag of the instruction messages, shared with dsh-agent-instructions. */
const INSTRUCTION_SOURCE_KIND = 'agent-instructions';
/** Schema library used to validate this row's `config`. */
const SCHEMA_SPECIFIER = '@deepseek-ai/schemastery';
/** Probe specifier used to prove that an anchor points into a Harness installation. */
const PROBE_SPECIFIER = '@deepseek-ai/dsh-agent-instructions';

/**
 * Debug tracing is opt-in.
 *
 * An earlier revision appended to an `activation.log` next to this module. A
 * published plugin must never write into its own installation directory: it is
 * frequently read-only or shared, and the file is pure litter for everyone else.
 */
const DEBUG_ENABLED = process.env.DSH_AGENTS_MD_SWITCH_DEBUG === '1';

/** Emit one debug line. Silent unless `DSH_AGENTS_MD_SWITCH_DEBUG=1`. */
function trace(message) {
  if (DEBUG_ENABLED) console.error(`[${LABEL}] ${message}`);
}

/**
 * Candidate anchors that may point into a Harness installation.
 *
 * Every candidate is validated by resolving the probe specifier from it, so a wrong
 * guess costs one failed resolution and is skipped. Several bases are collected
 * because the layout differs per platform and per launch mode: a packaged Electron app
 * exposes `process.resourcesPath`, a macOS bundle keeps `Resources` beside the
 * executable, and some launchers only reveal the application path through `argv`.
 *
 * @returns deduplicated absolute anchor paths.
 */
function installAnchors() {
  const bases = [];
  // `process.resourcesPath` is the one a packaged Electron host always defines, so it
  // is probed first; the rest only matter for other launch modes.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    bases.push(process.resourcesPath);
  }
  const execDir = dirname(process.execPath ?? '');
  if (execDir.length > 0) {
    bases.push(execDir);
    bases.push(join(execDir, '..', 'Resources'));
  }
  for (const argument of (process.argv ?? []).slice(1)) {
    if (typeof argument !== 'string' || argument.length === 0 || argument.startsWith('-')) continue;
    let entry = argument;
    if (entry.startsWith('file://')) {
      try {
        entry = fileURLToPath(entry);
      } catch {
        continue;
      }
    }
    // Only filesystem-looking arguments are useful; flags and bare words are not.
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(entry) === false) continue;
    const base = dirname(entry);
    bases.push(base);
    bases.push(join(base, '..'));
  }
  const anchors = [];
  const add = (candidate) => {
    if (anchors.includes(candidate) === false) anchors.push(candidate);
  };
  // No single spelling covers every layout, so each candidate directory is probed in
  // the three shapes an installation actually uses, plus a few ancestors: `argv` may
  // point straight at the Harness entry, at the `dsh` directory, or at its parent.
  for (const base of bases) {
    for (const directory of ancestors(base, 3)) {
      add(join(directory, 'dsh', 'index.js'));
      add(join(directory, 'app.asar', 'dsh', 'index.js'));
      add(join(directory, 'index.js'));
    }
  }
  return anchors;
}

/**
 * One directory and its ancestors.
 *
 * @param directory - starting directory.
 * @param levels - how many parents to include.
 * @returns the directory followed by its ancestors.
 */
function ancestors(directory, levels) {
  const chain = [directory];
  let current = directory;
  for (let level = 0; level < levels; level += 1) {
    const parent = dirname(current);
    if (parent === current) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** A `require` anchored inside a Harness installation, or `undefined` when none works. */
function resolveInstallRequire() {
  const attempts = [];
  for (const anchor of installAnchors()) {
    try {
      const require = createRequire(anchor);
      require.resolve(PROBE_SPECIFIER);
      return { require, resolved: anchor, attempts };
    } catch (error) {
      attempts.push(`${anchor}: ${error?.code ?? error?.message ?? String(error)}`);
    }
  }
  return { require: undefined, resolved: undefined, attempts };
}

/**
 * Load the schema library.
 *
 * Normal package resolution first: `@deepseek-ai/schemastery` is a peer dependency,
 * which is how the wider plugin ecosystem declares it. The installation anchor is the
 * fallback for setups where the plugin tree cannot reach the packages shipped inside
 * the Harness application archive (for example a `link:`-ed development bundle).
 *
 * Using a second copy is safe: volatile references are recognised by duck typing on
 * `Symbol.for('cosmokit.volatile.write')` (see cosmokit's `src/volatile.ts`), not by
 * `instanceof`, so a plugin copy and a host copy interoperate.
 *
 * @returns the schema namespace, callable as `Schema.object(...)`.
 * @throws when neither resolution path can load it.
 */
function loadSchema() {
  const sources = [{ origin: 'plugin tree', require: createRequire(import.meta.url) }];
  const anchor = resolveInstallRequire();
  if (anchor.require !== undefined) sources.push({ origin: `install anchor ${anchor.resolved}`, require: anchor.require });
  const failures = [...anchor.attempts];
  for (const source of sources) {
    try {
      const resolved = source.require.resolve(SCHEMA_SPECIFIER);
      const loaded = source.require(SCHEMA_SPECIFIER);
      const schema = loaded?.default ?? loaded;
      if (typeof schema?.object !== 'function') throw new TypeError('module has no object()');
      trace(`${SCHEMA_SPECIFIER} loaded from ${source.origin}: ${resolved}`);
      return schema;
    } catch (error) {
      failures.push(`${source.origin}: ${error?.code ?? error?.message ?? String(error)}`);
    }
  }
  const shown = failures.slice(0, 5);
  const hidden = failures.length - shown.length;
  throw new Error(
    `${LABEL}: cannot load ${SCHEMA_SPECIFIER}; tried ${shown.join(' | ')}`
    + (hidden > 0 ? ` | +${hidden} more candidate path(s)` : ''),
  );
}

const Schema = loadSchema();

/** Plugin name; kept in sync with the patch row id and the profile row identity. */
export const name = 'inject-agents-md';

/**
 * The settings form is generated from this schema.
 *
 * `volatile` is required — see the module doc. The description is bilingual on
 * purpose: the settings form renders the schema description verbatim, so it cannot
 * follow the interface language, and this plugin is published for a global audience.
 */
export const Config = Schema.object({
  [FIELD]: Schema.boolean()
    .default(true)
    .description(
      'Inject workspace instruction files (AGENTS.md / CLAUDE.md and their .local.md variants) into the model context. '
      + '｜ 是否把工作区指令文件（AGENTS.md / CLAUDE.md 及其 .local.md 变体）注入模型上下文。',
    )
    .volatile(),
});

/**
 * Read the real boolean out of a volatile field.
 *
 * At runtime a volatile field may be a `Volatile` wrapper rather than a bare value
 * (the host's own `plainConfig()` tests `isVolatile` and calls `.get()` first), so the
 * wrapper is unwrapped hop by hop; bare values, `undefined` and failed unwraps are
 * returned as-is.
 *
 * @param value - raw field value.
 * @returns the unwrapped value.
 */
function unwrapFlag(value) {
  let current = value;
  for (let hop = 0; hop < 4; hop += 1) {
    if (current === null || typeof current !== 'object' || typeof current.get !== 'function') break;
    try {
      current = current.get();
    } catch {
      break;
    }
  }
  return current;
}

/**
 * Normalise to a boolean.
 *
 * @param value - raw or wrapped field value.
 * @returns `true` / `false`, or `undefined` when absent so the caller can fall through.
 */
function readFlag(value) {
  const raw = unwrapFlag(value);
  if (raw === undefined || raw === null) return undefined;
  return raw !== false;
}

/**
 * Decide whether injection is currently switched off.
 *
 * The live config on the current fiber is read first (a volatile write updates it in
 * place), then the config captured by `apply`. The default is "on": only an explicit
 * `false` intercepts, so a missing value, an old config or a schema change can never
 * accidentally change existing injection behaviour.
 *
 * @param ctx - plugin context.
 * @param config - config captured at apply time.
 * @returns whether the injected instruction messages should be dropped.
 */
function isDisabled(ctx, config) {
  const live = readFlag(ctx?.fiber?.config?.[FIELD]);
  if (live !== undefined) return live === false;
  const captured = readFlag(config?.[FIELD]);
  if (captured !== undefined) return captured === false;
  return false;
}

/** Whether a message is a workspace-instruction injection. */
function isInjectedMessage(message) {
  return message?.source?.kind === INSTRUCTION_SOURCE_KIND;
}

/**
 * Drop the instruction messages from the batch about to enter the step.
 *
 * The `enter` branch carries a frozen message batch, so a new object is returned
 * rather than mutating in place. When there is nothing to drop the input is returned
 * unchanged, so downstream reuse of the same object is not disturbed.
 *
 * @param decision - the downstream waterfall decision.
 * @returns the decision without instruction messages.
 */
function stripInjected(decision) {
  if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
  const kept = decision.messages.filter((message) => !isInjectedMessage(message));
  if (kept.length === decision.messages.length) return decision;
  return { ...decision, messages: kept };
}

/**
 * Clear instruction messages still waiting in the agent's inbox.
 *
 * The instruction plugin also parks pending content in `inbox.nextStep` and retries
 * it on the next step. Leaving it alone still produces a correct result (it is
 * dropped again once claimed), but every step would redo the file discovery and read
 * for nothing.
 *
 * @param agent - the stepping agent, when the payload exposes one.
 */
function clearPendingInbox(agent) {
  const inbox = agent?.inbox;
  if (inbox === undefined || !Array.isArray(inbox.nextStep)) return;
  for (const message of [...inbox.nextStep]) {
    if (isInjectedMessage(message)) inbox.remove(message.id);
  }
}

/**
 * Mount the step-boundary interceptor.
 *
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  trace(`applied | ${FIELD}=${String(unwrapFlag(config?.[FIELD]))}`);
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next();
      if (!isDisabled(ctx, config)) return decision;
      try {
        clearPendingInbox(payload?.agent);
      } catch (error) {
        ctx.logger?.warn?.(`${LABEL}: clearing the instruction inbox failed: %o`, error);
      }
      const stripped = stripInjected(decision);
      if (stripped !== decision) trace(`stripped injected instructions | step=${String(payload?.step)}`);
      return stripped;
    },
    { prepend: true },
  );
}
