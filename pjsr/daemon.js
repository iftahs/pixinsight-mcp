#engine v8
// pjsr/daemon.js — pixinsight-mcp job daemon. ES5 only (PJSR).
//
// Launch: PixInsight.exe -n --automation-mode -r="<repo>/pjsr/daemon.js,<bridgeDir>"
//
// Polls <bridgeDir>/jobs/ (json), claims by renaming to .claimed, runs the op,
// writes <bridgeDir>/results/<id>.json, streams console to <bridgeDir>/logs/<id>.log,
// writes <bridgeDir>/heartbeat.json every 2 s. Never lets an exception kill the loop.

#include "lib/core.js"
#include "lib/windows.js"
#include "lib/stf.js"
#include "ops/system.js"
#include "ops/inspect.js"
#include "ops/preview.js"
#include "ops/stars.js"
#include "ops/calibration.js"
#include "ops/stacking.js"
#include "ops/postprocess.js"
#include "ops/masks.js"
#include "generated/adp.js"

var PIMCP_VERSION = "0.1.0";

function pimcpMain() {
   if (typeof jsArguments === "undefined" || jsArguments.length < 1) {
      Console.criticalln("pixinsight-mcp daemon: missing bridge directory argument");
      return;
   }
   var bridgeDir = String(jsArguments[0]).replace(/\\/g, "/");
   var jobsDir = bridgeDir + "/jobs", resultsDir = bridgeDir + "/results", logsDir = bridgeDir + "/logs";
   PIMCP.fs.ensureDir(jobsDir); PIMCP.fs.ensureDir(resultsDir); PIMCP.fs.ensureDir(logsDir);
   var heartbeatPath = bridgeDir + "/heartbeat.json";
   var startTime = Date.now(), jobsDone = 0, lastBeat = 0, busy = null, stopRequested = false;

   var piVersion = CoreApplication.versionMajor + "." + CoreApplication.versionMinor + "." + CoreApplication.versionRelease +
                   " " + CoreApplication.versionCodename;

   function beat(force) {
      var t = Date.now();
      if (!force && t - lastBeat < 2000) return;
      lastBeat = t;
      try {
         PIMCP.fs.writeJsonAtomic(heartbeatPath, {
            ts: PIMCP.nowIso(), pid: Number(CoreApplication.pid), pi_version: piVersion, daemon_version: PIMCP_VERSION,
            busy: busy, uptime_s: Math.round((t - startTime) / 1000), jobs_done: jobsDone
         });
      } catch (e) { Console.warningln("heartbeat write failed: " + e); }
   }

   function writeResult(res) {
      try { PIMCP.fs.writeJsonAtomic(resultsDir + "/" + res.id + ".json", res); } catch (e) { Console.criticalln("result write failed: " + e); }
   }

   function errorInfo(e) {
      if (e instanceof PIMCP.Err) return { code: e.code, message: e.message, extra: e.extra };
      var msg = (e && e.message) ? e.message : String(e);
      var code = "PI_ERROR";
      if (/abort/i.test(msg)) code = "ABORTED";
      return { code: code, message: msg, stack: (e && e.stack) ? String(e.stack) : undefined };
   }

   function runJob(claimedPath) {
      var req;
      try { req = PIMCP.fs.readJson(claimedPath); }
      catch (e) { Console.criticalln("bad job file " + claimedPath + ": " + e); try { File.remove(claimedPath); } catch (e2) { } return; }
      var id = req.id, op = req.op, args = req.args || {};
      var logPath = req.log_path || (logsDir + "/" + id + ".log");
      var started = PIMCP.nowIso();
      var res = { id: id, op: op, status: "running", started_at: started, progress: { step: "starting" } };
      busy = { job_id: id, op: op, since: started };
      writeResult(res);
      beat(true);

      if (op === "stop") { stopRequested = true; res.status = "ok"; res.data = { stopped: true }; res.finished_at = PIMCP.nowIso(); writeResult(res); busy = null; try { File.remove(claimedPath); } catch (e0) { } return; }

      var cancelFlag = jobsDir + "/" + id + ".cancel";
      PIMCP.isCancelRequested = function () { return File.exists(cancelFlag); };
      var lastProgressWrite = 0;
      PIMCP.onProgress = function (p) {
         res.progress = p;
         var t = Date.now();
         if (t - lastProgressWrite > 750) { lastProgressWrite = t; writeResult(res); beat(); }
      };

      var handler = PIMCP.ops[op];
      var t0 = Date.now();
      var captured = "";
      try {
         if (!handler) PIMCP.fail("UNKNOWN_OP", "unknown op '" + op + "'");
         Console.writeln("<end><cbr><b>[pimcp] job " + id + " op=" + op + "</b>");
         var ctx = { id: id, op: op, args: args, session_id: req.session_id || null, bridgeDir: bridgeDir, logPath: logPath };
         var r = PIMCP.withConsoleLog(logPath, function () { return handler(args, ctx); });
         captured = r.log;
         res.status = "ok";
         res.data = (r.result === undefined) ? {} : r.result;
      } catch (e) {
         try { captured = Console.endLog().utf8ToString(); } catch (e3) { }
         if (!captured) captured = PIMCP.fs.tail(logPath, 8000);
         var info = errorInfo(e);
         res.status = (info.code === "CANCELLED") ? "cancelled" : "error";
         res.error = { code: info.code, message: info.message, console_tail: PIMCP.tailLines(captured, 40), extra: info.extra, stack: info.stack };
         Console.criticalln("[pimcp] job " + id + " failed: " + info.code + ": " + info.message);
      }
      res.console_tail = PIMCP.tailLines(captured, 25);
      res.finished_at = PIMCP.nowIso();
      res.elapsed_ms = Date.now() - t0;
      delete res.progress;
      writeResult(res);
      busy = null;
      jobsDone++;
      PIMCP.onProgress = null; PIMCP.isCancelRequested = null;
      try { File.remove(claimedPath); } catch (e4) { }
      try { if (File.exists(cancelFlag)) File.remove(cancelFlag); } catch (e5) { }
      beat(true);
      gc();
   }

   Console.show();
   Console.writeln("<end><cbr><b>pixinsight-mcp daemon " + PIMCP_VERSION + " on PixInsight " + piVersion + "</b>");
   Console.writeln("bridge: " + bridgeDir);
   Console.abortEnabled = false;
   beat(true);

   for (;;) {
      if (stopRequested) break;
      try {
         var pending = searchDirectory(jobsDir + "/*.json", false);
         pending.sort();
         for (var i = 0; i < pending.length; ++i) {
            var p = String(pending[i]).replace(/\\/g, "/");
            if (/\.tmp$/.test(p)) continue;
            var claimed = p.replace(/\.json$/, ".claimed");
            try { File.move(p, claimed); } catch (e) { continue; }
            runJob(claimed);
            if (stopRequested) break;
         }
      } catch (e) {
         Console.criticalln("[pimcp] loop error: " + e);
      }
      beat(false);
      processEvents();
      msleep(250);
   }
   Console.writeln("<end><cbr>[pimcp] daemon stopped");
   try { File.remove(heartbeatPath); } catch (e6) { }
}

pimcpMain();
