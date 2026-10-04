/**
 * Source of the script worker. It runs in a worker thread, so a slow or looping
 * script cannot block the pi UI, and a stop can terminate it at once.
 *
 * The script itself runs in a fresh vm context with only ECMAScript built-ins and
 * the workflow globals. The globals are defined by PRELUDE inside that context, so
 * all values the script sees belong to its own realm. The prelude talks to the
 * worker through one closure-held bridge object; the bridge talks to the main
 * thread through postMessage.
 *
 * Both sources are plain JavaScript strings. Do not use backticks or "${" in them.
 */

export const PRELUDE_SOURCE = String.raw`(function (bridge, init) {
  "use strict";
  var G = globalThis;
  var parse = JSON.parse;
  var stringify = JSON.stringify;

  function deepFreeze(v) {
    if (v && typeof v === "object" && !Object.isFrozen(v)) {
      Object.freeze(v);
      var keys = Object.keys(v);
      for (var i = 0; i < keys.length; i++) deepFreeze(v[keys[i]]);
    }
    return v;
  }

  function makeError(e) {
    var err = new Error((e && e.message) || String(e));
    if (e && e.name) err.name = e.name;
    if (e && e.agentId !== undefined) err.agentId = e.agentId;
    if (e && e.reason) err.reason = e.reason;
    return err;
  }

  function call(op, payload) {
    return new Promise(function (resolve, reject) {
      var json;
      try { json = stringify(payload); } catch (err) {
        reject(new TypeError(op + "(): arguments must be JSON data (" + err.message + ")"));
        return;
      }
      bridge.call(op, json, function (res) {
        resolve(res === undefined ? undefined : parse(res));
      }, function (e) { reject(makeError(e)); });
    });
  }

  function checkItems(n, fn) {
    if (n > init.maxItems) {
      throw new RangeError(fn + "(): " + n + " items is more than the limit of " + init.maxItems + " per call. Split the list into smaller calls.");
    }
  }

  var OPTION_TYPES = {
    label: "string", phase: "string", schema: "object", model: "string", thinking: "string",
    tools: "array", readOnly: "boolean", cwd: "string", isolation: "string", instructions: "string",
    context: "any", timeout: "number", maxTurns: "number", retries: "number", onError: "string", cache: "boolean"
  };
  var THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  function typeName(v) { return v === null ? "null" : Array.isArray(v) ? "array" : typeof v; }

  function checkAgentOptions(opts) {
    if (opts === undefined || opts === null) return {};
    if (typeof opts !== "object" || Array.isArray(opts)) throw new TypeError("agent(prompt, opts?): opts must be an object");
    var keys = Object.keys(opts);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var want = OPTION_TYPES[k];
      if (!want) throw new TypeError("agent(): unknown option \"" + k + "\". Known options: " + Object.keys(OPTION_TYPES).join(", "));
      var v = opts[k];
      if (v === undefined || want === "any") continue;
      var got = typeName(v);
      if (got !== want) throw new TypeError("agent(): option " + k + " must be " + want + ", not " + got);
    }
    if (opts.tools && opts.tools.some(function (t) { return typeof t !== "string"; })) throw new TypeError("agent(): tools must be an array of tool names");
    if (opts.thinking && THINKING.indexOf(opts.thinking) < 0) throw new TypeError("agent(): thinking must be one of " + THINKING.join(", "));
    if (opts.isolation && opts.isolation !== "worktree") throw new TypeError("agent(): isolation must be \"worktree\"");
    if (opts.onError && opts.onError !== "null" && opts.onError !== "throw") throw new TypeError("agent(): onError must be \"null\" or \"throw\"");
    if (opts.timeout !== undefined && !(opts.timeout > 0)) throw new TypeError("agent(): timeout is in seconds and must be greater than 0");
    if (opts.maxTurns !== undefined && !(opts.maxTurns >= 1)) throw new TypeError("agent(): maxTurns must be 1 or more");
    if (opts.retries !== undefined && !(opts.retries >= 0)) throw new TypeError("agent(): retries must be 0 or more");
    return opts;
  }

  function agent(prompt, opts) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("agent(prompt, opts?): prompt must be a non-empty string");
    var o = checkAgentOptions(opts);
    if (bridge.isCancelled()) return Promise.resolve(null);
    return call("agent", { prompt: prompt, opts: o });
  }

  function runLimited(list, limit, fn) {
    var results = new Array(list.length);
    var next = 0;
    var n = Math.max(1, Math.min(list.length, limit > 0 ? limit : list.length));
    function lane() {
      if (next >= list.length) return Promise.resolve();
      var i = next++;
      return Promise.resolve(bridge.runIsolated(function () { return fn(list[i], i); })).then(function (v) {
        results[i] = v;
        return lane();
      });
    }
    var lanes = [];
    for (var k = 0; k < n; k++) lanes.push(bridge.runIsolated(lane));
    return Promise.all(lanes).then(function () { return results; });
  }

  function concurrencyOf(opts, fn) {
    if (opts === undefined || opts === null) return 0;
    if (typeof opts !== "object") throw new TypeError(fn + "(): options must be an object such as { concurrency: 4 }");
    if (opts.concurrency === undefined) return 0;
    if (!(opts.concurrency >= 1)) throw new TypeError(fn + "(): concurrency must be 1 or more");
    return Math.floor(opts.concurrency);
  }

  function parallel(tasks, opts) {
    var limit = concurrencyOf(opts, "parallel");
    if (Array.isArray(tasks)) {
      checkItems(tasks.length, "parallel");
      return runLimited(tasks, limit, function (t) { return typeof t === "function" ? t() : t; });
    }
    if (tasks && typeof tasks === "object") {
      var keys = Object.keys(tasks);
      return parallel(keys.map(function (k) { return tasks[k]; }), opts).then(function (values) {
        var out = {};
        for (var i = 0; i < keys.length; i++) out[keys[i]] = values[i];
        return out;
      });
    }
    throw new TypeError("parallel(tasks, opts?): tasks must be an array (or an object) of functions, such as items.map(x => () => agent(...))");
  }

  function pipeline(items) {
    var stages = Array.prototype.slice.call(arguments, 1);
    var opts;
    var last = stages[stages.length - 1];
    if (last !== null && typeof last === "object") opts = stages.pop();
    if (!Array.isArray(items)) throw new TypeError("pipeline(items, stage1, stage2?, ...): items must be an array");
    if (stages.length === 0 || stages.some(function (s) { return typeof s !== "function"; })) {
      throw new TypeError("pipeline(items, stage1, stage2?, ...): pass one or more stage functions");
    }
    checkItems(items.length, "pipeline");
    return runLimited(items, concurrencyOf(opts, "pipeline"), function (item, index) {
      var s = 0;
      function step(value) {
        if (s > 0 && (value === null || value === undefined)) return null;
        if (s >= stages.length) return value;
        var stage = stages[s];
        var first = s === 0;
        s++;
        return Promise.resolve(first ? stage(item, index) : stage(value, item, index)).then(step);
      }
      return step(item);
    });
  }

  function race(tasks, predicate) {
    if (!Array.isArray(tasks)) throw new TypeError("race(tasks, predicate?): tasks must be an array of functions");
    checkItems(tasks.length, "race");
    var accept = typeof predicate === "function" ? predicate : function (v) { return v !== null && v !== undefined; };
    return new Promise(function (resolve, reject) {
      if (tasks.length === 0) { resolve(null); return; }
      var settled = false;
      var remaining = tasks.length;
      var groups = [];
      var firstError;
      function finishOthers(winner) {
        var others = groups.filter(function (_, k) { return k !== winner; });
        if (others.length) bridge.cancelGroups(others);
      }
      tasks.forEach(function (t, i) {
        var started = bridge.runInGroup(function () {
          return Promise.resolve().then(function () { return typeof t === "function" ? t() : t; });
        });
        groups.push(started.group);
        started.result.then(function (value) {
          if (settled) return;
          var ok;
          try { ok = !!accept(value); } catch (err) { settled = true; finishOthers(-1); reject(err); return; }
          if (ok) { settled = true; finishOthers(i); resolve({ index: i, value: value }); }
        }, function (err) {
          if (firstError === undefined) firstError = err;
        }).then(function () {
          remaining--;
          if (remaining === 0 && !settled) {
            settled = true;
            if (firstError !== undefined) reject(firstError); else resolve(null);
          }
        });
      });
    });
  }

  function phase(title, fn) {
    if (typeof title !== "string" || !title.trim()) throw new TypeError("phase(title, fn?): title must be a non-empty string");
    title = title.trim();
    bridge.post("phase", stringify({ title: title }));
    if (fn === undefined) { bridge.enterPhase(title); return undefined; }
    if (typeof fn !== "function") throw new TypeError("phase(title, fn?): fn must be a function");
    return bridge.runInPhase(title, fn);
  }

  function fmt(v) {
    if (typeof v === "string") return v;
    if (v === undefined) return "undefined";
    try { var s = stringify(v, null, 2); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  }

  function logAt(level, values) {
    var text = Array.prototype.map.call(values, fmt).join(" ");
    if (text.length > 4000) text = text.slice(0, 4000) + " ...";
    bridge.post("log", stringify({ level: level, text: text }));
  }

  function log() { logAt("info", arguments); }

  var consoleObj = {
    log: log,
    info: log,
    debug: function () { logAt("debug", arguments); },
    warn: function () { logAt("warn", arguments); },
    error: function () { logAt("error", arguments); }
  };

  function ask(question, opts) {
    if (typeof question !== "string" || !question.trim()) throw new TypeError("ask(question, opts?): question must be a non-empty string");
    opts = opts || {};
    if (typeof opts !== "object") throw new TypeError("ask(question, opts?): opts must be an object");
    if (opts.options !== undefined && (!Array.isArray(opts.options) || opts.options.some(function (o) { return typeof o !== "string"; }))) {
      throw new TypeError("ask(): options must be an array of strings");
    }
    if (bridge.isCancelled()) return Promise.resolve(opts.default === undefined ? null : opts.default);
    return call("ask", {
      question: question,
      options: opts.options,
      default: opts.default === undefined ? null : opts.default,
      timeout: opts.timeout
    });
  }

  function sleep(ms) {
    var n = Number(ms);
    if (!(n >= 0)) throw new TypeError("sleep(ms): ms must be a number of milliseconds");
    return new Promise(function (resolve) { bridge.sleep(n, resolve); });
  }

  var state = init.seed >>> 0;
  function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    var t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function shuffle(list) {
    var a = Array.from(list);
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  var RealDate = Date;
  function clockError(what) {
    return new Error(what + " is disabled in workflow scripts, so a relaunched run repeats the same agent() calls. Pass a timestamp in args.");
  }
  function SafeDate() {
    if (!new.target) throw clockError("Date()");
    if (arguments.length === 0) throw clockError("new Date() without arguments");
    return Reflect.construct(RealDate, Array.prototype.slice.call(arguments), new.target);
  }
  Object.setPrototypeOf(SafeDate, RealDate);
  SafeDate.prototype = RealDate.prototype;
  Object.defineProperty(SafeDate, "now", { value: function () { throw clockError("Date.now()"); } });
  G.Date = SafeDate;
  Math.random = function () {
    throw new Error("Math.random() is disabled in workflow scripts. Use random(), which a relaunched run repeats exactly.");
  };

  function define(name, value) {
    Object.defineProperty(G, name, { value: value, writable: false, enumerable: false, configurable: false });
  }
  define("agent", agent);
  define("parallel", parallel);
  define("pipeline", pipeline);
  define("race", race);
  define("phase", phase);
  define("log", log);
  define("console", consoleObj);
  define("ask", ask);
  define("sleep", sleep);
  define("random", random);
  define("shuffle", shuffle);
  define("args", init.argsJson === undefined ? undefined : deepFreeze(parse(init.argsJson)));
  define("env", deepFreeze(parse(init.envJson)));
  Object.defineProperty(G, "budget", {
    get: function () { return deepFreeze(parse(bridge.budget())); },
    enumerable: false,
    configurable: false
  });
})`;

export const WORKER_SOURCE = String.raw`"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { AsyncLocalStorage } = require("node:async_hooks");

const als = new AsyncLocalStorage();
const pending = new Map();
const cancelledGroups = new Set();
let nextId = 0;
let nextGroup = 0;
let budgetJson = workerData.budgetJson;
let finished = false;
let sleeps = 0;
let idleTicks = 0;

function scope() {
  return als.getStore() || { phase: null, groups: [] };
}

function serializeError(err) {
  const e = err && typeof err === "object" ? err : { message: String(err) };
  const stack = String(e.stack || "");
  const lines = stack.split("\n").filter((l) => l.indexOf(workerData.filename) >= 0);
  let line;
  let column;
  for (const l of lines) {
    const idx = l.lastIndexOf(workerData.filename + ":");
    if (idx >= 0) {
      const m = /^:(\d+):(\d+)/.exec(l.slice(idx + workerData.filename.length));
      if (m) { line = Number(m[1]); column = Number(m[2]); break; }
    }
  }
  return {
    name: e.name || "Error",
    message: e.message || String(err),
    stack: lines.join("\n"),
    line: line,
    column: column,
    agentId: e.agentId,
    reason: e.reason
  };
}

parentPort.on("message", (msg) => {
  if (msg.type === "resolve" || msg.type === "reject") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === "resolve") p.resolve(msg.json); else p.reject(msg.error);
  } else if (msg.type === "budget") {
    budgetJson = msg.json;
  } else if (msg.type === "cancelled") {
    for (const g of msg.groups) cancelledGroups.add(g);
  }
});

const bridge = Object.freeze({
  call(op, payloadJson, resolve, reject) {
    const s = scope();
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "call", id, op, payload: payloadJson, phase: s.phase, groups: s.groups });
  },
  post(kind, payloadJson) {
    const s = scope();
    parentPort.postMessage({ type: kind, payload: payloadJson, phase: s.phase, groups: s.groups });
  },
  enterPhase(title) {
    const s = scope();
    als.enterWith({ phase: title, groups: s.groups });
  },
  runInPhase(title, fn) {
    const s = scope();
    return als.run({ phase: title, groups: s.groups }, fn);
  },
  runIsolated(fn) {
    const s = scope();
    return als.run({ phase: s.phase, groups: s.groups }, fn);
  },
  runInGroup(fn) {
    const s = scope();
    const group = ++nextGroup;
    const result = als.run({ phase: s.phase, groups: s.groups.concat([group]) }, fn);
    return { group, result };
  },
  cancelGroups(groups) {
    for (const g of groups) cancelledGroups.add(g);
    parentPort.postMessage({ type: "cancelGroups", payload: JSON.stringify({ groups }), phase: null, groups: [] });
  },
  isCancelled() {
    return scope().groups.some((g) => cancelledGroups.has(g));
  },
  budget() {
    return budgetJson;
  },
  sleep(ms, done) {
    sleeps++;
    setTimeout(() => { sleeps--; done(); }, Math.min(ms, 2147483647));
  }
});

process.on("unhandledRejection", (reason) => {
  const e = serializeError(reason);
  parentPort.postMessage({
    type: "log",
    payload: JSON.stringify({ level: "warn", text: "Unhandled promise rejection in the script: " + e.name + ": " + e.message + (e.line ? " (line " + e.line + ")" : "") }),
    phase: null,
    groups: []
  });
});

const context = vm.createContext({}, { name: "workflow", codeGeneration: { strings: true, wasm: false } });
try {
  const install = new vm.Script(workerData.prelude, { filename: "workflow-prelude.js" }).runInContext(context);
  install(bridge, {
    maxItems: workerData.maxItems,
    seed: workerData.seed,
    envJson: workerData.envJson,
    argsJson: workerData.argsJson
  });
} catch (err) {
  finished = true;
  parentPort.postMessage({ type: "error", error: serializeError(err) });
}

if (!finished) {
  let fn;
  try {
    fn = new vm.Script(workerData.code, { filename: workerData.filename, lineOffset: -1 }).runInContext(context);
  } catch (err) {
    finished = true;
    parentPort.postMessage({ type: "error", error: serializeError(err) });
  }
  if (fn) {
    Promise.resolve()
      .then(() => fn())
      .then(
        (value) => {
          if (finished) return;
          finished = true;
          let json;
          try {
            json = value === undefined ? undefined : JSON.stringify(value);
          } catch (err) {
            parentPort.postMessage({ type: "error", error: { name: "TypeError", message: "The script returned a value that is not JSON data: " + err.message } });
            return;
          }
          parentPort.postMessage({ type: "done", json });
        },
        (err) => {
          if (finished) return;
          finished = true;
          parentPort.postMessage({ type: "error", error: serializeError(err) });
        }
      );
  }
}

setInterval(() => {
  if (finished) return;
  if (pending.size === 0 && sleeps === 0) {
    idleTicks++;
    if (idleTicks >= 3) {
      finished = true;
      parentPort.postMessage({
        type: "error",
        error: {
          name: "Error",
          message: "The script waits on a promise that can never settle: no agent(), ask(), or sleep() call is pending. Check that every promise you await is resolved."
        }
      });
    }
  } else {
    idleTicks = 0;
  }
  parentPort.postMessage({ type: "heartbeat" });
}, 1000);
`;
