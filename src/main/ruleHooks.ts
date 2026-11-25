import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import vm from 'node:vm';
import { watchFiles } from './watchFiles';

export interface RuleResult<T = unknown> {
  ok: boolean;
  reason?: string;
  data?: T;
}

export type RuleFn = (...args: any[]) => RuleResult | any;

export interface RuleErrorEvent {
  type: 'rule-error';
  hook: string;
  file: string;
  phase: 'load' | 'run';
  message: string;
}

export interface RuleHookHostOptions {
  rulesDir: string;
  defaults: Record<string, RuleFn>;
  onError?: (event: RuleErrorEvent) => void;
  debounceMs?: number;
}

export interface RuleHookHost {
  run(name: string, ...args: any[]): RuleResult | any;
  close(): void;
}

interface LoadedHook {
  ctx: vm.Context;
  runScript: vm.Script;
  runnerFn: (fn: any, rawArgs: any[]) => any;
  fn: any;
  exercised: boolean;
}

interface HookState {
  current: LoadedHook | null;
  lastGood: LoadedHook | null;
}

const VM_TIMEOUT_MS = 50;
// The vm timeout is wall-clock. A timeout that spent under half its budget on CPU
// means the host process was descheduled, not that the rule was looping.
const STARVED_CPU_MS = VM_TIMEOUT_MS / 2;
const STARVED_ATTEMPTS = 3;
const STARVED_RELOAD_MS = 250;
const STARVED_RELOADS = 10;

class HostStalledError extends Error {}

function runUnlessLooping<T>(step: () => T): T {
  for (let attempt = 1; ; attempt++) {
    const cpuBefore = process.cpuUsage();
    try {
      return step();
    } catch (err: any) {
      if (err?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err;
      const used = process.cpuUsage(cpuBefore);
      if ((used.user + used.system) / 1000 >= STARVED_CPU_MS) throw err;
      if (attempt >= STARVED_ATTEMPTS) throw new HostStalledError(err.message);
    }
  }
}

function createHookContext(): {
  ctx: vm.Context;
  runScript: vm.Script;
  runnerFn: (fn: any, rawArgs: any[]) => any;
} {
  const ctx = vm.createContext({}, {
    codeGeneration: {
      strings: false,
      wasm: false
    }
  });

  ctx.module = { exports: {} };
  ctx.exports = ctx.module.exports;

  const runnerFn = vm.runInContext(`
    (function() {
      function deepCloneAndFreeze(val) {
        if (val === null || typeof val !== 'object') return val;
        if (Object.prototype.toString.call(val) === '[object Date]') return new Date(val.getTime());
        if (Object.prototype.toString.call(val) === '[object RegExp]') return new RegExp(val.source, val.flags);
        if (Array.isArray(val)) {
          const arr = [];
          for (let i = 0; i < val.length; i++) {
            arr.push(deepCloneAndFreeze(val[i]));
          }
          return Object.freeze(arr);
        }
        const obj = {};
        for (const key of Object.keys(val)) {
          obj[key] = deepCloneAndFreeze(val[key]);
        }
        return Object.freeze(obj);
      }
      return function(fn, rawArgs) {
        const cloned = rawArgs.map(deepCloneAndFreeze);
        return fn(...cloned);
      };
    })()
  `, ctx);

  const runScript = new vm.Script('__runnerFn(__activeFn, __args)');

  return { ctx, runScript, runnerFn };
}

function executeHook(loaded: LoadedHook, args: any[]): any {
  return runUnlessLooping(() => executeHookOnce(loaded, args));
}

function executeHookOnce(loaded: LoadedHook, args: any[]): any {
  loaded.ctx.__runnerFn = loaded.runnerFn;
  loaded.ctx.__activeFn = loaded.fn;
  loaded.ctx.__args = args;
  try {
    return loaded.runScript.runInContext(loaded.ctx, { timeout: VM_TIMEOUT_MS });
  } finally {
    delete loaded.ctx.__runnerFn;
    delete loaded.ctx.__activeFn;
    delete loaded.ctx.__args;
  }
}

export function createRuleHookHost(options: RuleHookHostOptions): RuleHookHost {
  const { rulesDir, defaults, onError, debounceMs = 100 } = options;
  const states = new Map<string, HookState>();
  const stalledReloads = new Map<string, { timer: ReturnType<typeof setTimeout>; count: number }>();
  let closed = false;

  function loadHook(hook: string, stalledCount = 0): void {
    if (closed) return;
    clearTimeout(stalledReloads.get(hook)?.timer);
    stalledReloads.delete(hook);
    const filePath = join(rulesDir, `${hook}.js`);
    let state = states.get(hook);
    if (!state) {
      state = { current: null, lastGood: null };
      states.set(hook, state);
    }

    if (!existsSync(filePath)) {
      state.current = null;
      state.lastGood = null;
      return;
    }

    let code: string;
    try {
      code = readFileSync(filePath, 'utf8');
    } catch {
      state.current = null;
      state.lastGood = null;
      return;
    }

    let loaded: ReturnType<typeof createHookContext>;
    try {
      // Each attempt gets a fresh context: a stalled one may have half-run its top level.
      loaded = runUnlessLooping(() => {
        const attempt = createHookContext();
        new vm.Script(code, { filename: filePath }).runInContext(attempt.ctx, { timeout: VM_TIMEOUT_MS });
        return attempt;
      });
      if (typeof loaded.ctx.module.exports !== 'function') {
        throw new TypeError(`Rule file "${hook}.js" must export a function via module.exports`);
      }
    } catch (err: any) {
      if (err instanceof HostStalledError && stalledCount < STARVED_RELOADS) {
        const count = stalledCount + 1;
        stalledReloads.set(hook, { count, timer: setTimeout(() => loadHook(hook, count), STARVED_RELOAD_MS) });
        return;
      }
      onError?.({
        type: 'rule-error',
        hook,
        file: filePath,
        phase: 'load',
        message: err?.message || String(err)
      });
      if (state.lastGood) {
        state.current = state.lastGood;
      } else {
        state.current = null;
      }
      return;
    }

    const { ctx, runScript, runnerFn } = loaded;
    state.current = {
      ctx,
      runScript,
      runnerFn,
      fn: ctx.module.exports,
      exercised: false
    };
  }

  // Load existing hooks in lexical order
  const hookNames = Object.keys(defaults).sort();
  for (const hook of hookNames) {
    loadHook(hook);
  }

  const watchPaths = hookNames.map(hook => join(rulesDir, `${hook}.js`));
  const watcher = watchFiles(
    watchPaths,
    (changedPath) => {
      if (closed) return;
      const base = basename(changedPath);
      if (base.endsWith('.js')) {
        const hook = base.slice(0, -3);
        if (hook in defaults) {
          loadHook(hook);
        }
      }
    },
    debounceMs
  );

  return {
    run(name: string, ...args: any[]): any {
      const defaultFn = defaults[name];
      const state = states.get(name);

      if (!state || !state.current) {
        return defaultFn ? defaultFn(...args) : undefined;
      }

      const filePath = join(rulesDir, `${name}.js`);

      try {
        const result = executeHook(state.current, args);
        state.current.exercised = true;
        state.lastGood = state.current;
        return result;
      } catch (err: any) {
        onError?.({
          type: 'rule-error',
          hook: name,
          file: filePath,
          phase: 'run',
          message: err?.message || String(err)
        });

        if (state.lastGood && state.lastGood !== state.current) {
          try {
            const fallbackResult = executeHook(state.lastGood, args);
            state.current = state.lastGood;
            return fallbackResult;
          } catch {
            // lastGood also failed for this input
          }
        } else if (!state.lastGood) {
          state.current = null;
        }

        return defaultFn ? defaultFn(...args) : undefined;
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      watcher.close();
      for (const pending of stalledReloads.values()) clearTimeout(pending.timer);
      stalledReloads.clear();
    }
  };
}
