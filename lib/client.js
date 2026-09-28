/**
 * dsh-agents-md-switch — client half (web).
 *
 * Two entry points for one setting:
 *
 *   1. `settings.general.item` — a row in Settings → General that is itself the switch.
 *   2. `plugins.row.config`    — the configuration page of this bundle's own row under
 *                                Settings → Plugins.
 *
 * This file is a **pre-built artifact**: `dsh-client-modules` serves `lib/client.js`
 * verbatim and never compiles it, so it is hand-written in the lazy-CJS shape the host
 * expects (`window.__ModuleLoader__.load({ id, factory })`). The cost is no JSX, so
 * components are built with `React.createElement`; the benefit is that this bundle
 * needs no bundler step and `lib/client.js` is directly publishable.
 *
 * ## The inject face — the contract that is easy to get wrong
 *
 * `ctx.slots.register(options, Component)` takes an `options.inject` function whose
 * return value becomes the component props, but it is **not spread verbatim**.
 * `dsh-client-ui-renderer`'s `bindInjectSources` does two things:
 *
 *   - every entry under `hooks` is **lifted to the top level**, renamed by
 *     `standardHookPropName(name)` to `use<Capitalised>`, and wrapped by
 *     `observableHook` into a React selector Hook;
 *   - every other key stays at the top level untouched.
 *
 * So `inject: () => ({ hooks: { agentsMd: form }, setAgentsMd })` hands the component
 * `props.useAgentsMd` and `props.setAgentsMd` — there is **no** `props.hooks`. The
 * shipped `DeveloperToolsRow({ useDeveloperTools, setEnabled, t })` is the reference.
 *
 * The failure mode is vicious: reading the wrong prop yields `undefined`, and clicking
 * the switch then throws **synchronously inside the event handler**, which React
 * swallows — the UI sticks on "Saving…" forever while nothing is ever written. Every
 * exit of the write path below therefore lands on visible text: synchronous throw,
 * refusal, and timeout.
 *
 * ## Writes need no custom RPC
 *
 *   - the General row uses the `ConfigFormController` behind `ctx.configForms.get(ns)`
 *     (`getSnapshot` / `subscribe` / `set`);
 *   - the plugin row uses the `form` owner prop, `{ state, mutate }`.
 *
 * Both end up in `ctx.remote.settings.mutate`, which `dsh-config-editor` persists into
 * the profile's `cordis.patch.yml`. The form only exists while the host produces a
 * configuration descriptor for the entry, and a descriptor requires the `Config` field
 * to be marked volatile — see `index.js`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agents-md-switch',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** This bundle's package name, matching package.json; the first half of the row key. */
    const BUNDLE = 'dsh-agents-md-switch';
    /** The row id declared in cordis.patch.yml: row key suffix and settings namespace. */
    const NS = 'inject-agents-md';
    /** Cell key of the General row. */
    const GENERAL_ITEM_ID = 'agents-md-injection';
    /** Position in the General section: after developer-tools (15), before shortcuts (20). */
    const GENERAL_ITEM_ORDER = 16;
    /** Config field name, matching the host half. */
    const FIELD = 'injectAgentsMd';
    /** A write with no answer within this window is reported instead of spinning forever. */
    const WRITE_TIMEOUT_MS = 12000;
    const TIMEOUT_SECONDS = WRITE_TIMEOUT_MS / 1000;

    /**
     * Dictionaries keyed by the ids the shipped settings plugins use (`{ zh, en }` in
     * `ui-settings-general`). Every locale declares the same key set, because lookup
     * falls back to the key itself when a dictionary is missing one.
     */
    const DICTS = {
      zh: {
        title: '关闭 AGENTS.md 注入',
        hint: 'DSH 默认会注入 AGENTS.md / CLAUDE.md；打开此项后，它们不再进入模型上下文。',
        valueOn: '关闭 AGENTS.md 注入：开',
        valueOff: '关闭 AGENTS.md 注入：关',
        unavailable: '宿主没有为该行提供配置表单：插件未激活，或 Config 字段未标记为 volatile。',
        pending: '正在读取宿主当前值…',
        saving: '正在写入…',
        timeout: `宿主 ${TIMEOUT_SECONDS} 秒内没有回应这次写入。`,
        refused: '宿主拒绝了这次写入。',
        failed: '写入失败',
      },
      en: {
        title: 'Disable AGENTS.md injection',
        hint: 'DSH injects AGENTS.md / CLAUDE.md by default; turn this on to keep them out of the model context.',
        valueOn: 'Disable AGENTS.md injection: on',
        valueOff: 'Disable AGENTS.md injection: off',
        unavailable: 'The host offers no configuration form for this row: the plugin is inactive, or its Config field is not marked volatile.',
        pending: 'Reading the current host value…',
        saving: 'Saving…',
        timeout: `The host did not answer this write within ${TIMEOUT_SECONDS} seconds.`,
        refused: 'The host refused this write.',
        failed: 'Write failed',
      },
    };

    const STYLE_LABEL = { fontSize: '14px', lineHeight: '22px' };
    const STYLE_ROW = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
    };
    const STYLE_NOTE = {
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '12px',
      lineHeight: '18px',
      margin: 0,
    };
    const STYLE_ERROR = {
      color: 'var(--dsw-alias-state-error-primary)',
      fontSize: '12px',
      lineHeight: '18px',
      margin: 0,
    };

    /**
     * The base switch control, with a native checkbox fallback so a rename of that
     * export cannot take the whole row down.
     */
    const SwitchControl = typeof primitives?.Switch === 'function' ? primitives.Switch : null;

    /** Selector Hook used when no inject face arrived, keeping Hook order stable. */
    function useNothing() {
      return undefined;
    }

    /** Last-resort translator, used only if the locale service or inject face is absent. */
    function fallbackTranslate(key) {
      return DICTS.en[key] ?? key;
    }

    /**
     * Read whether this row's switch is on.
     *
     * The row is the **suppress** switch, while the persisted field is the positive
     * `injectAgentsMd`; the two are exact inverses, so an on switch means injection is
     * off. A missing value means injection is on — the host default — so the switch is
     * off. Every write below therefore stores `!next`; this function is the read half of
     * that translation, and the two write sites are the other half.
     */
    function readSuppressed(value) {
      if (value === null || typeof value !== 'object') return false;
      return value[FIELD] === false;
    }

    /** Collapse anything thrown into one readable line. */
    function describeError(error) {
      if (error === null || error === undefined) return String(error);
      if (typeof error === 'string') return error;
      return String(error.message ?? error);
    }

    /** Subscribe to one `ConfigFormController` snapshot (used by the plugin-row surface). */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form?.getSnapshot());
      React.useEffect(() => {
        if (form === undefined) return undefined;
        setSnapshot(form.getSnapshot());
        return form.subscribe(() => setSnapshot(form.getSnapshot()));
      }, [form]);
      return snapshot;
    }

    /**
     * UI state for one field write.
     *
     * All three exits must reach the user: a synchronous throw, an async refusal or
     * rejection, and a host that simply never answers.
     *
     * @param write - performs the write and returns a promise resolving to `false`
     *   when the host refused it; `undefined` when there is no write path at all.
     * @param t - translator.
     * @returns busy flag, problem text (or null), and the change handler.
     */
    function useWrite(write, t) {
      const [busy, setBusy] = React.useState(false);
      const [problem, setProblem] = React.useState(null);
      const timer = React.useRef(undefined);
      React.useEffect(
        () => () => {
          if (timer.current !== undefined) clearTimeout(timer.current);
        },
        [],
      );
      const onChange = (next) => {
        setProblem(null);
        setBusy(true);
        if (timer.current !== undefined) clearTimeout(timer.current);
        const settle = (message) => {
          if (timer.current !== undefined) {
            clearTimeout(timer.current);
            timer.current = undefined;
          }
          setBusy(false);
          if (message !== null) setProblem(message);
        };
        timer.current = setTimeout(() => settle(t('timeout')), WRITE_TIMEOUT_MS);
        let pending;
        try {
          pending = write === undefined ? undefined : write(next);
        } catch (error) {
          settle(`${t('failed')}: ${describeError(error)}`);
          return;
        }
        if (pending === undefined) {
          settle(t('unavailable'));
          return;
        }
        Promise.resolve(pending).then(
          (accepted) => settle(accepted === false ? t('refused') : null),
          (error) => settle(`${t('failed')}: ${describeError(error)}`),
        );
      };
      return { busy, problem, onChange };
    }

    /** The switch itself; disabled while a write is in flight. */
    function Toggle(props) {
      const { checked, busy, onChange, label } = props;
      if (SwitchControl === null) {
        return React.createElement('input', {
          type: 'checkbox',
          checked,
          disabled: busy,
          'aria-label': label,
          onChange: (event) => onChange(event.target.checked),
        });
      }
      return React.createElement(SwitchControl, {
        checked,
        disabled: busy,
        label,
        onChange,
      });
    }

    /** Copy and write feedback below the switch. */
    function Notes(props) {
      const { healthy, problem, pending, hint } = props;
      if (healthy === true) return React.createElement('p', { style: STYLE_NOTE }, hint);
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        React.createElement('p', { style: STYLE_NOTE }, pending ?? hint),
        problem === null ? null : React.createElement('p', { style: STYLE_ERROR }, problem),
      );
    }

    /**
     * The Settings → General row.
     *
     * Props come from the inject face: `hooks: { agentsMd: form }` is rewritten into
     * `useAgentsMd` (a selector Hook), while `setAgentsMd` and `t` pass through. Note
     * that `setAgentsMd` stores the *inverse* of the switch position, because this row
     * asks "suppress injection?" while the persisted field is the positive
     * `injectAgentsMd` — see `readSuppressed`.
     */
    function GeneralRow(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      const useAgentsMd = typeof props.useAgentsMd === 'function' ? props.useAgentsMd : useNothing;
      const snapshot = useAgentsMd((value) => value);
      const suppressed = readSuppressed(snapshot?.value);
      const { busy, problem, onChange } = useWrite(props.setAgentsMd, t);
      const healthy = problem === null && snapshot?.status === 'ready';
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        React.createElement(
          'div',
          { style: STYLE_ROW },
          React.createElement('span', { style: STYLE_LABEL }, t('title')),
          React.createElement(Toggle, { checked: suppressed, busy, onChange, label: t('title') }),
        ),
        busy ? React.createElement('p', { style: STYLE_NOTE }, t('saving')) : null,
        React.createElement(Notes, {
          healthy,
          problem,
          hint: t('hint'),
          pending: snapshot === undefined ? t('unavailable') : t('pending'),
        }),
      );
    }

    /**
     * This bundle's row configuration page (`plugins.row.config`).
     *
     * The owner renders the same component in two views: `summary` is the one-line
     * text beside the row, `page` is the form. Here `view` and `form` come from the
     * slot owner props and are not rewritten by the inject face.
     */
    function RowConfigCell(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      const { view } = props;
      const form = props.form;
      const suppressed = readSuppressed(form?.state?.value);
      const { busy, problem, onChange } = useWrite(
        form === undefined
          ? undefined
          // The switch asks "suppress injection?", so the stored positive field is its inverse.
          : (next) => form.mutate([{ op: 'set', path: [FIELD], value: !next }]),
        t,
      );

      if (view === 'summary') {
        return React.createElement('span', null, suppressed ? t('valueOn') : t('valueOff'));
      }
      if (form === undefined) {
        return React.createElement('p', { style: STYLE_NOTE }, t('unavailable'));
      }
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        React.createElement(
          'div',
          { style: STYLE_ROW },
          React.createElement('span', { style: STYLE_LABEL }, t('title')),
          React.createElement(Toggle, { checked: suppressed, busy, onChange, label: t('title') }),
        ),
        busy ? React.createElement('p', { style: STYLE_NOTE }, t('saving')) : null,
        problem === null
          ? React.createElement('p', { style: STYLE_NOTE }, t('hint'))
          : React.createElement('p', { style: STYLE_ERROR }, problem),
      );
    }

    /** Client services this half needs: slot registration, settings forms, dictionaries. */
    const inject = ['slots', 'configForms', 'locale'];

    /**
     * Register the dictionaries and both surfaces.
     *
     * Both cells are registered only while the host actually serves the namespace: with
     * no descriptor there is no switch, and a control that cannot be operated is worse
     * than no control at all.
     */
    function apply(ctx) {
      const form = ctx.configForms.get(NS);
      const t = ctx.locale.bind(NS);
      ctx.effect(() => {
        const disposers = [];
        for (const [id, dict] of Object.entries(DICTS)) {
          try {
            disposers.push(ctx.locale.register(NS, id, dict));
          } catch (error) {
            // A rejected dictionary must not take the plugin down; keys then show as-is.
            ctx.logger?.warn?.(`${BUNDLE}: locale ${id} registration failed: %o`, error);
          }
        }
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, `${BUNDLE}: dictionaries`);
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () => {
            const offRow = ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.row.config',
                  key: `${BUNDLE}#${NS}`,
                  locale: NS,
                  inject: () => ({ t }),
                },
                RowConfigCell,
              ));
            const offGeneral = ctx.slots.inject('settings.general.item', () =>
              ctx.slots.register(
                {
                  name: 'settings.general.item',
                  id: GENERAL_ITEM_ID,
                  order: GENERAL_ITEM_ORDER,
                  locale: NS,
                  // The renderer lifts `hooks` to the top level: agentsMd -> props.useAgentsMd.
                  // `next` is the suppress switch position, so the stored positive field is
                  // its inverse; `readSuppressed` is the matching read half.
                  inject: () => ({
                    hooks: { agentsMd: form },
                    setAgentsMd: (next) => form.set(FIELD, !next),
                    t,
                  }),
                },
                GeneralRow,
              ));
            return () => {
              offRow();
              offGeneral();
            };
          }),
        `${BUNDLE}: configuration surfaces`,
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
