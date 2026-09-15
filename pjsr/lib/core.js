// pjsr/lib/core.js — ES5 only. Shared helpers for the daemon and ops.
// Everything here runs inside PixInsight's JavaScript runtime.

#include <pjsr/UndoFlag.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/ColorSpace.jsh>

var PIMCP = PIMCP || {};
PIMCP.ops = PIMCP.ops || {};
/** Null-safe check: SpiderMonkey returns null-objects (isNull), V8 returns null. */
PIMCP.isNull = function (o) { return o === null || o === undefined || o.isNull === true; };

/** Preprocessor macros are not visible to eval'd scripts (pi_run_pjsr); expose the useful ones. */
// NOTE: keys must not be macro names — the preprocessor substitutes macros even after a dot.
PIMCP.K = { GRAY: ColorSpace_Gray, RGB: ColorSpace_RGB, REAL: SampleType_Real, INTEGER: SampleType_Integer, NOSWAP: UndoFlag_NoSwapFile };

// ---------------------------------------------------------------- errors
PIMCP.Err = function (code, message, extra) {
   this.code = code || "PI_ERROR";
   this.message = message || code;
   this.extra = extra || null;
};
PIMCP.Err.prototype.toString = function () { return this.code + ": " + this.message; };
PIMCP.fail = function (code, message, extra) { throw new PIMCP.Err(code, message, extra); };

// ---------------------------------------------------------------- fs
/** V8 engine exposes 64-bit process counters as BigInt; JSON and arithmetic need plain numbers. */
PIMCP.num = function (x) { return (typeof x === "bigint") ? Number(x) : x; };
PIMCP.jsonReplacer = function (k, v) { return (typeof v === "bigint") ? Number(v) : v; };
PIMCP.toJSON = function (obj, indent) { return JSON.stringify(obj, PIMCP.jsonReplacer, indent); };

PIMCP.fs = {
   readJson: function (path) { return JSON.parse(File.readTextFile(path)); },
   writeJsonAtomic: function (path, obj) {
      var tmp = path + "." + Math.floor(Math.random() * 1e9).toString(36) + ".tmp";
      File.writeTextFile(tmp, PIMCP.toJSON(obj, 2));
      if (File.exists(path)) File.remove(path);
      File.move(tmp, path);
   },
   ensureDir: function (dir) {
      if (!File.directoryExists(dir)) File.createDirectory(dir, true);
      return dir;
   },
   basename: function (p) { return File.extractName(p); },
   ext: function (p) { return File.extractExtension(p); },
   dir: function (p) { return File.extractDrive(p) + File.extractDirectory(p); },
   join: function (a, b) { return (a.charAt(a.length - 1) === "/" ? a : a + "/") + b; },
   list: function (dir, pattern) { return searchDirectory(dir + "/" + (pattern || "*"), false); },
   tail: function (path, maxBytes) {
      try {
         if (!File.exists(path)) return "";
         var t = File.readTextFile(path);
         return t.length > maxBytes ? t.substring(t.length - maxBytes) : t;
      } catch (e) { return ""; }
   }
};

// ---------------------------------------------------------------- misc
PIMCP.nowIso = function () { return (new Date()).toISOString(); };
PIMCP.log = function (msg) { Console.writeln("<end><cbr>[pimcp] " + msg); Console.flush(); };
PIMCP.warn = function (msg) { Console.warningln("[pimcp] " + msg); Console.flush(); };
PIMCP.progress = function (step, current, total, msg) {
   // Parsed by the Node log tailer; also stored in the running result by the daemon.
   Console.writeln("<end><cbr>PIMCP-PROGRESS step=" + step + " current=" + current + " total=" + total + (msg ? " msg=" + msg : ""));
   Console.flush();
   if (PIMCP.onProgress) PIMCP.onProgress({ step: step, current: current, total: total, message: msg || "" });
   processEvents();
};
PIMCP.checkCancel = function () {
   if (PIMCP.isCancelRequested && PIMCP.isCancelRequested()) PIMCP.fail("CANCELLED", "job cancelled by request");
};
PIMCP.pick = function (obj, key, dflt) { return (obj && obj[key] !== undefined && obj[key] !== null) ? obj[key] : dflt; };
PIMCP.req = function (obj, key) {
   if (!obj || obj[key] === undefined || obj[key] === null) PIMCP.fail("BAD_ARGS", "missing required argument '" + key + "'");
   return obj[key];
};
PIMCP.isArray = function (a) { return Object.prototype.toString.call(a) === "[object Array]"; };
PIMCP.round = function (x, n) { var f = Math.pow(10, n === undefined ? 6 : n); return Math.round(x * f) / f; };

/** Resolve an enum constant on a process class, validating that it exists. */
PIMCP.enumOf = function (ctor, name, what) {
   // SpiderMonkey engine exposes enums on the prototype, V8 engine as statics; support both.
   var v = ctor[name];
   if (typeof v === "undefined") v = ctor.prototype[name];
   if (typeof v === "undefined") PIMCP.fail("BAD_ENUM", "unknown " + (what || "enum") + " '" + name + "' for " + (ctor.prototype.processId || "process"));
   return v;
};

/** Does a process class exist in this PixInsight? (BlurXTerminator etc.) */
PIMCP.hasProcess = function (name) {
   try { return typeof eval(name) === "function"; } catch (e) { return false; }
};

/** Apply a flat {param: value} object onto a process instance, validating names. */
PIMCP.assignParams = function (P, params, opts) {
   opts = opts || {};
   var unknown = [];
   for (var k in params) {
      if (!params.hasOwnProperty(k)) continue;
      if (!(k in P)) { unknown.push(k); continue; }
      var v = params[k];
      // Allow "EnumName" strings for numeric enum params: "WinsorizedSigmaClip"
      if (typeof v === "string" && typeof P[k] === "number") {
         var ev = P.constructor[v]; if (typeof ev === "undefined") ev = P.constructor.prototype[v];
         if (typeof ev === "number") v = ev;
      }
      P[k] = v;
   }
   if (unknown.length && !opts.ignoreUnknown) PIMCP.fail("BAD_PARAM", "unknown parameter(s) for " + P.processId + ": " + unknown.join(", "));
   return unknown;
};

/** Files → [enabled, path] rows etc. */
PIMCP.rows = function (files, shape) {
   var out = [];
   for (var i = 0; i < files.length; ++i) out.push(shape(files[i], i));
   return out;
};

/** Ensure every path in a list exists. */
PIMCP.assertFiles = function (files, what) {
   if (!PIMCP.isArray(files) || files.length === 0) PIMCP.fail("BAD_ARGS", "no " + (what || "files") + " given");
   for (var i = 0; i < files.length; ++i)
      if (!File.exists(files[i])) PIMCP.fail("FILE_NOT_FOUND", (what || "file") + " not found: " + files[i]);
};

/** Console log capture around an operation. Returns {result, log}. */
PIMCP.withConsoleLog = function (logPath, fn) {
   var started = false;
   try { Console.beginLog(logPath); started = true; } catch (e) { PIMCP.warn("beginLog failed: " + e); }
   var result, err = null;
   try { result = fn(); } catch (e) { err = e; }
   var text = "";
   if (started) { try { var ba = Console.endLog(); text = ba.utf8ToString ? ba.utf8ToString() : ba.toString(); } catch (e2) { } }
   if (err) throw err;
   return { result: result, log: text };
};

/** Last N lines of a text. */
PIMCP.tailLines = function (text, n) {
   var lines = String(text || "").split(/\r?\n/);
   var out = [];
   for (var i = lines.length - 1; i >= 0 && out.length < n; --i) if (lines[i].length) out.unshift(lines[i]);
   return out.join("\n");
};
