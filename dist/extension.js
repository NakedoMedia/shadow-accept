"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// main_scripts/terminal-monitor.js
var require_terminal_monitor = __commonJS({
  "main_scripts/terminal-monitor.js"(exports2, module2) {
    "use strict";
    function stripAnsi(text) {
      if (!text) return "";
      return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "").replace(/\x1B\][^\x1B]*\x1B\\/g, "").replace(/\x1B[()][A-Z0-9]/g, "").replace(/\x1B[#=]/g, "").replace(/[\x00-\x08\x0E-\x1A\x1C-\x1F]/g, "").replace(/\r/g, "");
    }
    var PROMPT_PATTERNS = [
      // Claude Code CLI: "Allow Bash(npm test)? [Y/n]"
      {
        name: "claude-code-allow",
        pattern: /Allow\s+\w+\(.*?\)\?\s*\[Y\/n\]/,
        response: "Y\n",
        hasTool: true
      },
      // Claude Code CLI: "Do you want to proceed? [Y/n]"
      {
        name: "claude-code-proceed",
        pattern: /Do you want to proceed\?\s*\[Y\/n\]/i,
        response: "Y\n",
        hasTool: false
      },
      // Generic [Y/n] at end of line
      {
        name: "generic-yn",
        pattern: /\[Y\/n\]\s*$/,
        response: "Y\n",
        hasTool: false
      },
      // Generic [y/N] at end of line
      {
        name: "generic-yN",
        pattern: /\[y\/N\]\s*$/,
        response: "y\n",
        hasTool: false
      },
      // Generic (yes/no) prompt
      {
        name: "generic-yesno",
        pattern: /\(yes\/no\)\s*:?\s*$/i,
        response: "yes\n",
        hasTool: false
      },
      // Generic (y/n) prompt
      {
        name: "generic-yn-paren",
        pattern: /\(y\/n\)\s*:?\s*$/i,
        response: "y\n",
        hasTool: false
      },
      // Press Enter to continue
      {
        name: "press-enter",
        pattern: /Press Enter to continue/i,
        response: "\n",
        hasTool: false
      }
    ];
    function extractCommandFromPrompt(text) {
      const match = text.match(/Allow\s+(\w+)\((.+?)\)\?/);
      if (!match) return null;
      return { tool: match[1], command: match[2] };
    }
    var DANGEROUS_TOOLS = ["Bash", "Execute", "Shell", "Run"];
    var TerminalMonitorEngine = class {
      constructor(logger, vscodeApi) {
        this._log = logger;
        this._vscode = vscodeApi;
        this._running = false;
        this._available = false;
        this._disposables = [];
        this._buffers = /* @__PURE__ */ new Map();
        this._cooldowns = /* @__PURE__ */ new Map();
        this._flushTimers = /* @__PURE__ */ new Map();
        this._bannedCommands = [];
        this._customPatterns = [];
        this._cooldownMs = 1e3;
        this._stats = { clicks: 0, blocked: 0, lastAction: null };
        this.isActive = false;
      }
      // ── Public API ────────────────────────────────────────────────────────────
      start(config) {
        this._bannedCommands = config.bannedCommands || [];
        this._customPatterns = (config.terminalPatterns || []).map((p) => {
          try {
            return { name: "custom", pattern: new RegExp(p), response: "Y\n", hasTool: false };
          } catch (_) {
            return null;
          }
        }).filter(Boolean);
        if (this._running) return;
        this._running = true;
        try {
          if (this._vscode.window.onDidWriteTerminalData) {
            const disposable = this._vscode.window.onDidWriteTerminalData((event) => {
              this._onTerminalData(event);
            });
            this._disposables.push(disposable);
            this._available = true;
            this.isActive = true;
            this._log("[Terminal] Engine started \u2014 onDidWriteTerminalData available");
          } else {
            this._log("[Terminal] Proposed API not available (onDidWriteTerminalData is undefined)");
          }
        } catch (e) {
          this._log(`[Terminal] Proposed API not available: ${e.message}`);
        }
      }
      stop() {
        this._running = false;
        this.isActive = false;
        for (const d of this._disposables) {
          try {
            d.dispose();
          } catch (_) {
          }
        }
        this._disposables = [];
        for (const timer of this._flushTimers.values()) {
          clearTimeout(timer);
        }
        this._buffers.clear();
        this._cooldowns.clear();
        this._flushTimers.clear();
        this._log("[Terminal] Engine stopped");
      }
      getStats() {
        return { ...this._stats };
      }
      // ── Terminal data handler ─────────────────────────────────────────────────
      _onTerminalData(event) {
        if (!this._running) return;
        const { terminal, data } = event;
        const cleaned = stripAnsi(data);
        if (!cleaned) return;
        const existing = this._buffers.get(terminal) || "";
        const combined = existing + cleaned;
        const lines = combined.split("\n");
        const lastLine = lines[lines.length - 1];
        this._buffers.set(terminal, lastLine);
        if (lastLine.length > 2) {
          this._detectPrompt(lastLine, terminal);
        }
        clearTimeout(this._flushTimers.get(terminal));
        this._flushTimers.set(terminal, setTimeout(() => {
          this._buffers.delete(terminal);
        }, 2e3));
      }
      // ── Prompt detection ──────────────────────────────────────────────────────
      _detectPrompt(text, terminal) {
        const lastResponse = this._cooldowns.get(terminal) || 0;
        if (Date.now() - lastResponse < this._cooldownMs) return;
        const allPatterns = [...PROMPT_PATTERNS, ...this._customPatterns];
        for (const p of allPatterns) {
          if (p.pattern.test(text)) {
            this._respondToPrompt(terminal, p, text);
            return;
          }
        }
      }
      _respondToPrompt(terminal, pattern, matchedText) {
        if (pattern.hasTool) {
          const extracted = extractCommandFromPrompt(matchedText);
          if (extracted && DANGEROUS_TOOLS.includes(extracted.tool)) {
            if (this._isBannedCommand(extracted.command)) {
              this._log(`[Terminal] BLOCKED: ${extracted.tool}(${extracted.command})`);
              this._stats.blocked++;
              return;
            }
          }
        }
        try {
          terminal.sendText(pattern.response, false);
        } catch (e) {
          this._log(`[Terminal] sendText failed: ${e.message}`);
          return;
        }
        this._cooldowns.set(terminal, Date.now());
        this._stats.clicks++;
        this._stats.lastAction = { text: pattern.name, time: (/* @__PURE__ */ new Date()).toISOString() };
        this._log(`[Terminal] Auto-accepted: "${pattern.name}" \u2192 sent "${pattern.response.trim()}"`);
      }
      // ── Banned command check ──────────────────────────────────────────────────
      _isBannedCommand(commandText) {
        if (!commandText || this._bannedCommands.length === 0) return false;
        const lower = commandText.toLowerCase();
        for (const pattern of this._bannedCommands) {
          const p = (pattern || "").trim();
          if (!p) continue;
          try {
            if (p.startsWith("/") && p.lastIndexOf("/") > 0) {
              const last = p.lastIndexOf("/");
              const regex = new RegExp(p.slice(1, last), p.slice(last + 1) || "i");
              if (regex.test(commandText)) return true;
            } else if (lower.includes(p.toLowerCase())) {
              return true;
            }
          } catch (_) {
            if (lower.includes(p.toLowerCase())) return true;
          }
        }
        return false;
      }
    };
    module2.exports = {
      TerminalMonitorEngine,
      // Exported for testing
      stripAnsi,
      PROMPT_PATTERNS,
      DANGEROUS_TOOLS,
      extractCommandFromPrompt
    };
  }
});

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       * @param {Boolean} [isServer=false] Create the instance in either server or
       *     client mode
       * @param {Number} [maxPayload=0] The maximum allowed message length
       */
      constructor(options, isServer, maxPayload) {
        this._maxPayload = maxPayload | 0;
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._isServer = !!isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var PerMessageDeflate = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else {
            buf.set(data, 2);
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension) => {
        let configurations = extensions[extension];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https = require("https");
    var http = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes, createHash } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL } = require("url");
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver = require_receiver();
    var Sender = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate.extensionName]) {
          this._extensions[PerMessageDeflate.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket.prototype.addEventListener = addEventListener;
    WebSocket.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL(address);
        } catch (e) {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate(
          opts.perMessageDeflate !== true ? opts.perMessageDeflate : {},
          false,
          opts.maxPayload
        );
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket.CLOSED) return;
      if (websocket.readyState === WebSocket.OPEN) {
        websocket._readyState = WebSocket.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http = require("http");
    var { Duplex } = require("stream");
    var { createHash } = require("crypto");
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var subprotocol = require_subprotocol();
    var WebSocket = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate(
            this.options.perMessageDeflate,
            true,
            this.options.maxPayload
          );
          try {
            const offers = extension.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
              extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate.extensionName]) {
          const params = extensions[PerMessageDeflate.extensionName].params;
          const value = extension.format({
            [PerMessageDeflate.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// node_modules/ws/index.js
var require_ws = __commonJS({
  "node_modules/ws/index.js"(exports2, module2) {
    "use strict";
    var WebSocket = require_websocket();
    WebSocket.createWebSocketStream = require_stream();
    WebSocket.Server = require_websocket_server();
    WebSocket.Receiver = require_receiver();
    WebSocket.Sender = require_sender();
    WebSocket.WebSocket = WebSocket;
    WebSocket.WebSocketServer = WebSocket.Server;
    module2.exports = WebSocket;
  }
});

// main_scripts/cdp-handler.js
var require_cdp_handler = __commonJS({
  "main_scripts/cdp-handler.js"(exports2, module2) {
    "use strict";
    var WebSocket = require_ws();
    var http = require("http");
    var fs = require("fs");
    var path = require("path");
    var PRIORITY_PORTS = [
      9222,
      // Chrome / Electron default
      9229,
      // Node.js inspector default
      9333,
      // Cursor (some versions)
      9e3,
      9001,
      9002,
      9003,
      // Previous Shadow Accept range
      8997,
      8998,
      8999,
      // Extended previous range
      9004,
      9005,
      9006,
      5858,
      5859,
      // Legacy Node.js debug
      9230,
      9231
      // Additional inspector ports
    ];
    var CONNECT_TIMEOUT_MS = 600;
    var EVALUATE_TIMEOUT_MS = 2500;
    var BACKOFF_BASE_MS = 2e3;
    var BACKOFF_MAX_MS = 3e4;
    var _cachedScript = null;
    function loadAutoAcceptScript() {
      if (_cachedScript) return _cachedScript;
      const scriptPath = path.join(__dirname, "auto_accept.js");
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`auto_accept.js not found at ${scriptPath}`);
      }
      _cachedScript = fs.readFileSync(scriptPath, "utf8");
      return _cachedScript;
    }
    var CDPHandler = class {
      /**
       * @param {(msg: string) => void} logger
       */
      constructor(logger = console.log) {
        this._log = logger;
        this._pages = /* @__PURE__ */ new Map();
        this._msgId = 1;
        this._running = false;
        this._cachedPort = null;
        this._failCount = 0;
        this._lastScanTime = 0;
        this._customPorts = [];
        this.isConnected = false;
        this.connectedPort = null;
        this.pagesConnected = 0;
      }
      log(msg) {
        this._log(`[CDP] ${msg}`);
      }
      /** Allow user to specify extra ports via settings. */
      setCustomPorts(ports) {
        this._customPorts = Array.isArray(ports) ? ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536) : [];
      }
      // ── Public API ────────────────────────────────────────────────────────────
      /**
       * Start (or refresh) connections to IDE pages and inject the script.
       * Uses smart port caching: tries cached port first, then full scan with backoff.
       */
      async start(config) {
        this._running = true;
        if (this._cachedPort) {
          const pages = await this._listPages(this._cachedPort);
          if (pages.length > 0) {
            await this._connectAndInject(this._cachedPort, pages, config);
            this._updateConnectionState();
            return;
          }
          this.log(`Cached port ${this._cachedPort} no longer responding`);
          this._cachedPort = null;
        }
        const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(1.5, this._failCount), BACKOFF_MAX_MS);
        const elapsed = Date.now() - this._lastScanTime;
        if (this._failCount > 0 && elapsed < backoffMs) {
          return;
        }
        this._lastScanTime = Date.now();
        const portsToScan = this._getPortList();
        let foundAny = false;
        for (const port of portsToScan) {
          const pages = await this._listPages(port);
          if (pages.length > 0) {
            this._cachedPort = port;
            this._failCount = 0;
            this.log(`Found CDP on port ${port} (${pages.length} page(s))`);
            await this._connectAndInject(port, pages, config);
            foundAny = true;
            break;
          }
        }
        if (!foundAny) {
          this._failCount++;
          if (this._failCount === 1) {
            this.log(`No CDP port found. Scanning ${portsToScan.length} ports. Will retry with backoff.`);
          } else if (this._failCount % 10 === 0) {
            this.log(`Still no CDP port after ${this._failCount} scans. Ensure IDE is launched with --remote-debugging-port=9222`);
          }
        }
        this._updateConnectionState();
      }
      /** Stop all connections and tell the injected script to stop. */
      async stop() {
        this._running = false;
        for (const [key, conn] of this._pages) {
          try {
            await this._eval(key, "if(window.__shadowAcceptStop) window.__shadowAcceptStop()");
          } catch (_) {
          }
          try {
            conn.ws.close();
          } catch (_) {
          }
        }
        this._pages.clear();
        this._updateConnectionState();
      }
      /** Retrieve click/block counters from all connected pages. */
      async getStats() {
        const totals = { clicks: 0, blocked: 0 };
        for (const [key] of this._pages) {
          try {
            const res = await this._eval(
              key,
              "JSON.stringify(window.__shadowAcceptGetStats ? window.__shadowAcceptGetStats() : {})"
            );
            const v = this._parseJSON(res, {});
            totals.clicks += v.clicks || 0;
            totals.blocked += v.blocked || 0;
          } catch (_) {
          }
        }
        return totals;
      }
      // ── Internal helpers ──────────────────────────────────────────────────────
      _getPortList() {
        const seen = /* @__PURE__ */ new Set();
        const list = [];
        for (const p of [...this._customPorts, ...PRIORITY_PORTS]) {
          if (!seen.has(p)) {
            seen.add(p);
            list.push(p);
          }
        }
        return list;
      }
      async _connectAndInject(port, pages, config) {
        for (const page of pages) {
          const key = `${port}:${page.id}`;
          await this._ensureConnected(key, page.webSocketDebuggerUrl);
          await this._ensureInjected(key, config);
        }
      }
      _updateConnectionState() {
        for (const [key, conn] of this._pages) {
          if (conn.ws.readyState !== WebSocket.OPEN) {
            this._pages.delete(key);
          }
        }
        this.pagesConnected = this._pages.size;
        this.isConnected = this._pages.size > 0;
        this.connectedPort = this.isConnected ? this._cachedPort : null;
      }
      // ── Connection helpers ────────────────────────────────────────────────────
      /** GET /json/list from the Electron DevTools endpoint. Returns filtered pages. */
      async _listPages(port) {
        return new Promise((resolve) => {
          const req = http.get(
            { hostname: "127.0.0.1", port, path: "/json/list", timeout: CONNECT_TIMEOUT_MS },
            (res) => {
              let body = "";
              res.on("data", (c) => body += c);
              res.on("end", () => {
                try {
                  const pages = JSON.parse(body);
                  resolve(Array.isArray(pages) ? pages.filter((p) => this._isTargetPage(p)) : []);
                } catch (_) {
                  resolve([]);
                }
              });
            }
          );
          req.on("error", () => resolve([]));
          req.on("timeout", () => {
            req.destroy();
            resolve([]);
          });
        });
      }
      /**
       * Accept only page/webview types and exclude DevTools UI pages.
       * This prevents accidentally injecting into the developer tools window.
       */
      _isTargetPage(p) {
        if (!p || !p.webSocketDebuggerUrl) return false;
        if (p.type !== "page" && p.type !== "webview") return false;
        const url = (p.url || "").toLowerCase();
        if (url.startsWith("devtools://")) return false;
        if (url.startsWith("chrome-devtools://")) return false;
        if (url.includes("devtools/devtools")) return false;
        return true;
      }
      async _ensureConnected(key, wsUrl) {
        const existing = this._pages.get(key);
        if (existing && existing.ws.readyState === WebSocket.OPEN) return;
        if (existing) this._pages.delete(key);
        await new Promise((resolve) => {
          let settled = false;
          const done = (ok) => {
            if (!settled) {
              settled = true;
              resolve(ok);
            }
          };
          const ws = new WebSocket(wsUrl, { handshakeTimeout: CONNECT_TIMEOUT_MS });
          ws.on("open", () => {
            this._pages.set(key, { ws, injected: false, config: null });
            this.log(`Connected: ${key}`);
            done(true);
          });
          ws.on("error", () => done(false));
          ws.on("close", () => {
            this._pages.delete(key);
            this.log(`Disconnected: ${key}`);
          });
          setTimeout(() => done(false), CONNECT_TIMEOUT_MS + 100);
        });
      }
      async _ensureInjected(key, config) {
        const conn = this._pages.get(key);
        if (!conn) return;
        const cfgJson = JSON.stringify({
          ide: config.ide || "Code",
          pollInterval: config.pollInterval || 800,
          bannedCommands: config.bannedCommands || []
        });
        try {
          if (!conn.injected) {
            const script = loadAutoAcceptScript();
            this.log(`Injecting script into ${key} (${(script.length / 1024).toFixed(1)} KB)...`);
            await this._eval(key, script);
            conn.injected = true;
            this.log(`Injected: ${key}`);
          }
          const configChanged = conn.config !== cfgJson;
          if (configChanged) {
            await this._eval(key, `if(window.__shadowAcceptStart) window.__shadowAcceptStart(${cfgJson})`);
            conn.config = cfgJson;
            this.log(`Started with config: ${cfgJson}`);
          }
        } catch (e) {
          this.log(`Injection failed for ${key}: ${e.message}`);
          if (conn) conn.injected = false;
        }
      }
      // ── CDP Runtime.evaluate ─────────────────────────────────────────────────
      async _eval(key, expression) {
        const conn = this._pages.get(key);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
          throw new Error(`Page ${key} not connected`);
        }
        return new Promise((resolve, reject) => {
          const id = this._msgId++;
          const timer = setTimeout(() => {
            conn.ws.off("message", onMessage);
            reject(new Error(`CDP timeout for message ${id}`));
          }, EVALUATE_TIMEOUT_MS);
          const onMessage = (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.id !== id) return;
              conn.ws.off("message", onMessage);
              clearTimeout(timer);
              if (msg.error) {
                reject(new Error(msg.error.message || "CDP error"));
              } else {
                resolve(msg.result);
              }
            } catch (_) {
            }
          };
          conn.ws.on("message", onMessage);
          conn.ws.send(JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, userGesture: true, awaitPromise: true }
          }));
        });
      }
      _parseJSON(res, fallback) {
        const value = res?.result?.value;
        if (typeof value !== "string") return fallback;
        try {
          return JSON.parse(value);
        } catch (_) {
          return fallback;
        }
      }
    };
    module2.exports = { CDPHandler };
  }
});

// main_scripts/engine-manager.js
var require_engine_manager = __commonJS({
  "main_scripts/engine-manager.js"(exports2, module2) {
    "use strict";
    var { TerminalMonitorEngine } = require_terminal_monitor();
    var { CDPHandler } = require_cdp_handler();
    var EngineManager2 = class {
      /**
       * @param {(msg: string) => void} logger
       * @param {object} vscodeApi  — the `vscode` module, injected for testability
       */
      constructor(logger, vscodeApi) {
        this._log = logger;
        this._vscode = vscodeApi;
        this._terminal = new TerminalMonitorEngine(logger, vscodeApi);
        this._cdp = new CDPHandler(logger);
        this._mode = "auto";
        this._running = false;
      }
      // ── Public state ─────────────────────────────────────────────────────────
      get isConnected() {
        return this._terminal.isActive || this._cdp.isConnected;
      }
      get primaryEngine() {
        if (this._terminal.isActive && this._cdp.isConnected) return "terminal+cdp";
        if (this._terminal.isActive) return "terminal";
        if (this._cdp.isConnected) return "cdp";
        return "none";
      }
      get connectedPort() {
        return this._cdp.connectedPort;
      }
      get cdp() {
        return this._cdp;
      }
      get terminal() {
        return this._terminal;
      }
      // ── Public API ───────────────────────────────────────────────────────────
      start(config) {
        this._running = true;
        this._mode = config.engineMode || "auto";
        if (this._mode !== "cdp-only") {
          this._terminal.start(config);
        }
        return this;
      }
      /**
       * Start CDP engine. Separated because CDP discovery is async.
       * Called from the extension's discovery polling loop.
       */
      async startCDP(config) {
        if (this._mode === "terminal-only") return;
        await this._cdp.start(config);
      }
      async stop() {
        this._running = false;
        this._terminal.stop();
        await this._cdp.stop();
      }
      /** Aggregate stats from both engines. */
      async getStats() {
        const cdpStats = await this._cdp.getStats();
        const termStats = this._terminal.getStats();
        return {
          clicks: (termStats.clicks || 0) + (cdpStats.clicks || 0),
          blocked: (termStats.blocked || 0) + (cdpStats.blocked || 0),
          terminalClicks: termStats.clicks || 0,
          cdpClicks: cdpStats.clicks || 0,
          lastAction: termStats.lastAction || cdpStats.lastAction || null,
          terminalActive: this._terminal.isActive,
          cdpConnected: this._cdp.isConnected,
          engine: this.primaryEngine
        };
      }
      /** Forward custom ports to CDP handler. */
      setCustomPorts(ports) {
        this._cdp.setCustomPorts(ports);
      }
    };
    module2.exports = { EngineManager: EngineManager2 };
  }
});

// extension.js
var vscode = require("vscode");
var { EngineManager } = require_engine_manager();
var STATE_ENABLED_KEY = "shadow-accept.enabled";
var STATE_TOTAL_CLICKS = "shadow-accept.totalClicks";
var DISCOVERY_INTERVAL_MS = 3e3;
var STATS_INTERVAL_MS = 1500;
var isEnabled = false;
var discoveryTimer = null;
var statsTimer = null;
var statusBarItem = null;
var outputChannel = null;
var engineManager = null;
var globalContext = null;
var currentIDE = "Code";
var sessionClicks = 0;
var hasShownCDPHelp = false;
function log(msg) {
  const ts = (/* @__PURE__ */ new Date()).toISOString().split("T")[1].split(".")[0];
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (outputChannel) outputChannel.appendLine(line);
}
function detectIDE() {
  const name = (vscode.env.appName || "").toLowerCase();
  if (name.includes("cursor")) return "Cursor";
  if (name.includes("antigravity")) return "Antigravity";
  if (name.includes("windsurf")) return "Windsurf";
  return "Code";
}
function getConfig() {
  const cfg = vscode.workspace.getConfiguration("shadowAccept");
  return {
    pollInterval: cfg.get("pollInterval", 800),
    bannedCommands: cfg.get("bannedCommands", getDefaultBannedCommands()),
    enableOnStartup: cfg.get("enableOnStartup", false),
    debugPort: cfg.get("debugPort", 0),
    engineMode: cfg.get("engineMode", "auto"),
    terminalPatterns: cfg.get("terminalPatterns", [])
  };
}
function getDefaultBannedCommands() {
  return [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf *",
    "format c:",
    "del /f /s /q",
    "rmdir /s /q",
    ":(){:|:&};:",
    "dd if=",
    "mkfs.",
    "> /dev/sda",
    "chmod -R 777 /"
  ];
}
function updateStatusBar() {
  if (!statusBarItem) return;
  const totalClicks = (globalContext?.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + sessionClicks;
  const clickLabel = totalClicks > 0 ? ` (${formatCount(totalClicks)})` : "";
  if (isEnabled) {
    const connected = engineManager?.isConnected;
    if (connected) {
      const engine = engineManager.primaryEngine;
      const engineLabel = engine === "terminal+cdp" ? "Terminal+CDP" : engine === "terminal" ? "Terminal" : engine === "cdp" ? `CDP:${engineManager.connectedPort || "?"}` : "";
      statusBarItem.text = `$(check) Shadow${clickLabel}`;
      statusBarItem.tooltip = `Shadow Accept is ON \u2014 ${engineLabel}
${totalClicks} auto-accepted total
Click to disable`;
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      statusBarItem.color = void 0;
    } else {
      statusBarItem.text = `$(sync~spin) Shadow`;
      statusBarItem.tooltip = `Shadow Accept is ON \u2014 Searching for engines...
Click to disable`;
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      statusBarItem.color = void 0;
    }
  } else {
    statusBarItem.text = `$(circle-slash) Shadow`;
    statusBarItem.tooltip = `Shadow Accept is OFF
Click to enable`;
    statusBarItem.backgroundColor = void 0;
    statusBarItem.color = new vscode.ThemeColor("statusBarItem.foreground");
  }
}
function formatCount(n) {
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function showCDPHelpIfNeeded() {
  if (hasShownCDPHelp || !isEnabled || !engineManager) return;
  if (engineManager.terminal.isActive) return;
  if (engineManager.cdp.isConnected) return;
  setTimeout(() => {
    if (hasShownCDPHelp || !isEnabled) return;
    if (engineManager?.terminal.isActive || engineManager?.cdp.isConnected) return;
    hasShownCDPHelp = true;
    const ide = currentIDE;
    const cfg = getConfig();
    let helpMsg;
    if (cfg.engineMode === "terminal-only") {
      helpMsg = "Shadow Accept terminal monitor needs the proposed onDidWriteTerminalData API. This works best with sideloaded extensions.";
    } else if (ide === "Cursor") {
      helpMsg = "Shadow Accept: Terminal monitor unavailable. For CDP fallback, launch Cursor with: cursor --remote-debugging-port=9222";
    } else if (ide === "Antigravity") {
      helpMsg = "Shadow Accept: Terminal monitor unavailable. For CDP fallback, launch with: antigravity --remote-debugging-port=9222";
    } else {
      helpMsg = "Shadow Accept: Terminal monitor unavailable. For CDP fallback, launch VS Code with: code --remote-debugging-port=9222";
    }
    vscode.window.showWarningMessage(
      helpMsg,
      "Copy command",
      "Set custom port",
      "View log"
    ).then((choice) => {
      if (choice === "Copy command") {
        const cmd = ide === "Cursor" ? "cursor" : ide === "Antigravity" ? "antigravity" : "code";
        vscode.env.clipboard.writeText(`${cmd} --remote-debugging-port=9222`);
        vscode.window.showInformationMessage("Command copied! Restart your IDE with this flag.");
      }
      if (choice === "Set custom port") {
        vscode.commands.executeCommand("workbench.action.openSettings", "shadowAccept.debugPort");
      }
      if (choice === "View log") {
        outputChannel?.show(true);
      }
    });
  }, 8e3);
}
function cmdQuickAccept() {
  const terminal = vscode.window.activeTerminal;
  if (terminal) {
    terminal.sendText("Y", false);
    terminal.sendText("\n", false);
    log("[QuickAccept] Sent Y to active terminal");
  } else {
    vscode.window.showWarningMessage("No active terminal found.");
  }
}
async function runDiscoveryCycle() {
  if (!isEnabled || !engineManager) return;
  const cfg = getConfig();
  if (cfg.debugPort > 0) {
    engineManager.setCustomPorts([cfg.debugPort]);
  }
  try {
    await engineManager.startCDP({
      ide: currentIDE,
      pollInterval: cfg.pollInterval,
      bannedCommands: cfg.bannedCommands
    });
  } catch (e) {
    log(`[Discovery] ${e.message}`);
  }
  updateStatusBar();
}
async function runStatsCycle() {
  if (!isEnabled || !engineManager || !engineManager.isConnected) return;
  try {
    const stats = await engineManager.getStats();
    if (stats.clicks !== sessionClicks) {
      sessionClicks = stats.clicks;
      updateStatusBar();
    }
  } catch (e) {
    log(`[Stats] ${e.message}`);
  }
}
function startPolling() {
  stopPolling();
  const cfg = getConfig();
  log(`Starting v1.2 \u2014 mode=${cfg.engineMode}, discovery every ${DISCOVERY_INTERVAL_MS}ms, stats every ${STATS_INTERVAL_MS}ms on ${currentIDE}`);
  engineManager.start(cfg);
  runDiscoveryCycle();
  discoveryTimer = setInterval(runDiscoveryCycle, DISCOVERY_INTERVAL_MS);
  statsTimer = setInterval(runStatsCycle, STATS_INTERVAL_MS);
  showCDPHelpIfNeeded();
  updateStatusBar();
}
function stopPolling() {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  engineManager?.stop().catch(() => {
  });
}
async function cmdToggle(context) {
  isEnabled = !isEnabled;
  await context.globalState.update(STATE_ENABLED_KEY, isEnabled);
  updateStatusBar();
  if (isEnabled) {
    log("Enabled");
    hasShownCDPHelp = false;
    startPolling();
    vscode.window.showInformationMessage(
      `$(check) Shadow Accept is ON`,
      "Settings",
      "Disable"
    ).then((choice) => {
      if (choice === "Settings") cmdOpenSettings(context);
      if (choice === "Disable") cmdToggle(context);
    });
  } else {
    const prev = context.globalState.get(STATE_TOTAL_CLICKS) ?? 0;
    await context.globalState.update(STATE_TOTAL_CLICKS, prev + sessionClicks);
    sessionClicks = 0;
    stopPolling();
    log("Disabled");
    vscode.window.showInformationMessage(`$(circle-slash) Shadow Accept is OFF`);
    updateStatusBar();
  }
}
function cmdOpenSettings(context) {
  const panel = vscode.window.createWebviewPanel(
    "shadowAcceptSettings",
    "Shadow Accept",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  const cfg = getConfig();
  const bannedStr = cfg.bannedCommands.join("\n");
  const totalClicks = (context.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + sessionClicks;
  const engine = engineManager?.primaryEngine ?? "none";
  const termActive = engineManager?.terminal.isActive ?? false;
  const cdpConn = engineManager?.cdp.isConnected ?? false;
  const port = engineManager?.connectedPort ?? null;
  panel.webview.html = buildSettingsHTML(cfg, bannedStr, totalClicks, currentIDE, isEnabled, engine, termActive, cdpConn, port);
  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case "getStats": {
        const stats = engineManager ? await engineManager.getStats() : { clicks: 0, blocked: 0, terminalClicks: 0, cdpClicks: 0, engine: "none" };
        const total = (context.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + stats.clicks;
        panel.webview.postMessage({
          type: "stats",
          ...stats,
          total,
          enabled: isEnabled,
          ide: currentIDE,
          connected: engineManager?.isConnected ?? false,
          port: engineManager?.connectedPort ?? null,
          terminalActive: stats.terminalActive ?? false,
          cdpConnected: stats.cdpConnected ?? false
        });
        break;
      }
      case "toggle": {
        await cmdToggle(context);
        const stats2 = engineManager ? await engineManager.getStats() : { clicks: 0, blocked: 0, terminalClicks: 0, cdpClicks: 0, engine: "none" };
        const total2 = (context.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + stats2.clicks;
        panel.webview.postMessage({
          type: "stats",
          ...stats2,
          total: total2,
          enabled: isEnabled,
          ide: currentIDE,
          connected: engineManager?.isConnected ?? false,
          port: engineManager?.connectedPort ?? null,
          terminalActive: stats2.terminalActive ?? false,
          cdpConnected: stats2.cdpConnected ?? false
        });
        break;
      }
      case "save": {
        const wcfg = vscode.workspace.getConfiguration("shadowAccept");
        await wcfg.update("pollInterval", msg.pollInterval, vscode.ConfigurationTarget.Global);
        await wcfg.update("bannedCommands", msg.bannedCommands, vscode.ConfigurationTarget.Global);
        if (msg.debugPort !== void 0) {
          await wcfg.update("debugPort", msg.debugPort, vscode.ConfigurationTarget.Global);
        }
        if (msg.engineMode !== void 0) {
          await wcfg.update("engineMode", msg.engineMode, vscode.ConfigurationTarget.Global);
        }
        if (isEnabled) startPolling();
        panel.webview.postMessage({ type: "saved" });
        log(`Settings saved \u2014 pollInterval=${msg.pollInterval}ms, mode=${msg.engineMode}, banned=${msg.bannedCommands.length}`);
        break;
      }
      case "openOutput": {
        outputChannel?.show(true);
        break;
      }
    }
  }, void 0, context.subscriptions);
}
function buildSettingsHTML(cfg, bannedStr, totalClicks, ide, enabled, engine, termActive, cdpConn, port) {
  const engineLabels = {
    "terminal+cdp": "Terminal + CDP",
    "terminal": "Terminal Monitor",
    "cdp": `CDP on port ${port || "?"}`,
    "none": "No engine connected"
  };
  const connLabel = engineLabels[engine] || "No engine connected";
  const connClass = engine !== "none" ? "conn-ok" : "conn-err";
  return (
    /* html */
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Shadow Accept</title>
<style>
:root {
    --fg:       var(--vscode-foreground);
    --bg:       var(--vscode-editor-background);
    --input-bg: var(--vscode-input-background);
    --input-bd: var(--vscode-input-border, rgba(255,255,255,.12));
    --btn-bg:   var(--vscode-button-background);
    --btn-fg:   var(--vscode-button-foreground);
    --btn-hov:  var(--vscode-button-hoverBackground);
    --accent:   #7c6af7;
    --green:    #22c55e;
    --red:      #f87171;
    --orange:   #fb923c;
    --font:     var(--vscode-font-family, system-ui, sans-serif);
    --mono:     var(--vscode-editor-font-family, 'Courier New', monospace);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--font);
    color: var(--fg);
    background: var(--bg);
    padding: 32px 40px;
    max-width: 680px;
    line-height: 1.5;
}

/* \u2500\u2500 Header \u2500\u2500 */
.header { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; }
.header-logo {
    width: 44px; height: 44px; border-radius: 10px;
    background: linear-gradient(135deg, #7c6af7, #a855f7);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; flex-shrink: 0;
}
.header-title { font-size: 22px; font-weight: 700; letter-spacing: -0.4px; }
.header-sub { font-size: 12px; opacity: 0.5; margin-top: 2px; }

/* \u2500\u2500 Connection status \u2500\u2500 */
.conn-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 600;
    margin-bottom: 16px;
}
.conn-badge.conn-ok { background: rgba(34,197,94,.1); color: var(--green); border: 1px solid rgba(34,197,94,.2); }
.conn-badge.conn-err { background: rgba(248,113,113,.08); color: var(--orange); border: 1px solid rgba(248,113,113,.15); }
.conn-dot { width: 7px; height: 7px; border-radius: 50%; }
.conn-ok .conn-dot { background: var(--green); }
.conn-err .conn-dot { background: var(--orange); animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

/* \u2500\u2500 Engine cards \u2500\u2500 */
.engine-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; }
.engine-card {
    padding: 10px 14px; border-radius: 8px; font-size: 12px;
    background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.06);
}
.engine-card.active { border-color: var(--green); background: rgba(34,197,94,.04); }
.engine-card .engine-name { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
.engine-card .engine-status { opacity: 0.5; font-size: 11px; }
.engine-card.active .engine-status { color: var(--green); opacity: 1; }

/* \u2500\u2500 Toggle button \u2500\u2500 */
.toggle-btn {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 14px 18px; margin-bottom: 28px;
    border: 1.5px solid rgba(255,255,255,.08); border-radius: 10px;
    background: rgba(255,255,255,.03); cursor: pointer; transition: all .15s;
    font-size: 15px; font-weight: 600; color: var(--fg); font-family: var(--font);
}
.toggle-btn:hover { background: rgba(255,255,255,.07); border-color: var(--accent); }
.toggle-btn.on { border-color: var(--green); background: rgba(34,197,94,.06); }
.toggle-btn.on .dot { background: var(--green); box-shadow: 0 0 8px var(--green); }
.toggle-btn.off .dot { background: var(--red); }
.dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; transition: all .2s; }
.toggle-label { flex: 1; text-align: left; }
.toggle-ide { font-size: 11px; opacity: 0.5; font-weight: 400; }

/* \u2500\u2500 Stats row \u2500\u2500 */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 28px; }
.stat-card {
    padding: 14px 16px; border-radius: 8px;
    background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.06);
}
.stat-val { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat-lbl { font-size: 11px; opacity: 0.5; margin-top: 2px; }
.stat-card.green .stat-val { color: var(--green); }
.stat-card.red   .stat-val { color: var(--red); }
.stat-card.acc   .stat-val { color: var(--accent); }
.stat-card.blue  .stat-val { color: #60a5fa; }

/* \u2500\u2500 Sections \u2500\u2500 */
.section { margin-bottom: 24px; }
.section-title { font-size: 11px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase; opacity: .45; margin-bottom: 10px; }
label { display: block; font-size: 13px; margin-bottom: 6px; font-weight: 500; }
.hint { font-size: 11px; opacity: .45; margin-top: 5px; line-height: 1.4; }

input[type=range] { width: 100%; cursor: pointer; accent-color: var(--accent); }
.range-row { display: flex; align-items: center; gap: 12px; }
.range-val { font-size: 13px; font-weight: 600; min-width: 44px; text-align: right; opacity: .85; }

input[type=number] {
    width: 100px; background: var(--input-bg); color: var(--fg);
    border: 1px solid var(--input-bd); border-radius: 6px;
    padding: 6px 10px; font-size: 13px; font-family: var(--mono);
}
input[type=number]:focus { outline: none; border-color: var(--accent); }

select {
    background: var(--input-bg); color: var(--fg);
    border: 1px solid var(--input-bd); border-radius: 6px;
    padding: 6px 10px; font-size: 13px; font-family: var(--font);
}
select:focus { outline: none; border-color: var(--accent); }

textarea {
    width: 100%; min-height: 130px; resize: vertical;
    background: var(--input-bg); color: var(--fg);
    border: 1px solid var(--input-bd); border-radius: 6px;
    padding: 10px 12px; font-size: 12px; font-family: var(--mono);
    line-height: 1.6;
}
textarea:focus { outline: none; border-color: var(--accent); }

/* \u2500\u2500 Buttons \u2500\u2500 */
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
button.btn {
    padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
    font-family: var(--font); font-weight: 500; border: none; transition: all .12s;
}
button.btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
button.btn-primary:hover { background: var(--btn-hov); }
button.btn-secondary {
    background: rgba(255,255,255,.05); color: var(--fg);
    border: 1px solid rgba(255,255,255,.1);
}
button.btn-secondary:hover { background: rgba(255,255,255,.09); }

/* \u2500\u2500 Toast \u2500\u2500 */
.toast {
    position: fixed; bottom: 20px; right: 20px;
    background: var(--green); color: #000; font-weight: 600;
    padding: 10px 18px; border-radius: 8px; font-size: 13px;
    opacity: 0; transform: translateY(8px); transition: all .2s;
    pointer-events: none;
}
.toast.show { opacity: 1; transform: translateY(0); }

/* \u2500\u2500 Help box \u2500\u2500 */
.help-box {
    padding: 12px 16px; border-radius: 8px; font-size: 12px; line-height: 1.6;
    background: rgba(124,106,247,.06); border: 1px solid rgba(124,106,247,.15);
    margin-bottom: 24px;
}
.help-box code {
    background: rgba(255,255,255,.08); padding: 2px 6px; border-radius: 3px;
    font-family: var(--mono); font-size: 11px;
}

/* \u2500\u2500 Shortcut hint \u2500\u2500 */
.shortcut-box {
    padding: 10px 14px; border-radius: 8px; font-size: 12px;
    background: rgba(124,106,247,.04); border: 1px solid rgba(124,106,247,.1);
    margin-bottom: 24px; display: flex; align-items: center; gap: 8px;
}
.shortcut-box kbd {
    background: rgba(255,255,255,.1); padding: 2px 8px; border-radius: 4px;
    font-family: var(--mono); font-size: 11px; border: 1px solid rgba(255,255,255,.15);
}

/* \u2500\u2500 About box \u2500\u2500 */
.about-box {
    padding: 16px 18px; border-radius: 10px;
    background: rgba(124,106,247,.04); border: 1px solid rgba(124,106,247,.12);
    font-size: 13px; line-height: 1.65;
}
.about-box p { margin-bottom: 10px; }
.about-box p:last-of-type { margin-bottom: 14px; }
.about-meta { font-size: 11px; opacity: .5; }
.about-link { color: var(--accent); cursor: pointer; text-decoration: none; font-weight: 600; }
.about-link:hover { text-decoration: underline; }
.about-links { display: flex; gap: 8px; flex-wrap: wrap; }
.about-btn {
    display: inline-block; padding: 6px 14px; border-radius: 6px; font-size: 12px;
    font-weight: 600; cursor: pointer; text-decoration: none; color: var(--btn-fg);
    background: var(--accent); border: none; transition: opacity .15s;
}
.about-btn:hover { opacity: .85; }
.about-btn-ghost {
    background: transparent; color: var(--fg); border: 1px solid rgba(255,255,255,.12);
}
.about-btn-ghost:hover { background: rgba(255,255,255,.05); opacity: 1; }

/* \u2500\u2500 Footer \u2500\u2500 */
.footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.06); display: flex; justify-content: space-between; align-items: center; }
.footer-logo { font-size: 11px; opacity: .35; font-weight: 600; letter-spacing: .3px; }
.footer-links { display: flex; gap: 14px; }
.footer-links a { font-size: 11px; opacity: .4; color: var(--fg); text-decoration: none; cursor: pointer; }
.footer-links a:hover { opacity: .8; }
</style>
</head>
<body>

<div class="header">
    <div class="header-logo">&#9889;</div>
    <div>
        <div class="header-title">Shadow Accept</div>
        <div class="header-sub">by NakedoMedia \u2014 nakedo.ai \u2014 Free forever</div>
    </div>
</div>

<!-- Connection status -->
<div class="conn-badge ${connClass}" id="connBadge">
    <span class="conn-dot"></span>
    <span id="connLabel">${connLabel}</span>
</div>

<!-- Engine cards -->
<div class="engine-row">
    <div class="engine-card ${termActive ? "active" : ""}" id="termCard">
        <div class="engine-name">Terminal Monitor</div>
        <div class="engine-status" id="termStatus">${termActive ? "Active \u2014 zero config" : "Inactive"}</div>
    </div>
    <div class="engine-card ${cdpConn ? "active" : ""}" id="cdpCard">
        <div class="engine-name">CDP Engine</div>
        <div class="engine-status" id="cdpStatus">${cdpConn ? "Connected on port " + port : "Not connected"}</div>
    </div>
</div>

<!-- Toggle -->
<button class="toggle-btn ${enabled ? "on" : "off"}" id="toggleBtn" onclick="toggleAccept()">
    <span class="dot" id="dot"></span>
    <span class="toggle-label" id="toggleLabel">${enabled ? "Auto Accept is ON" : "Auto Accept is OFF"}</span>
    <span class="toggle-ide" id="toggleIde">${ide}</span>
</button>

<!-- Quick Accept hint -->
<div class="shortcut-box">
    <kbd>Ctrl+Shift+Y</kbd> Quick Accept \u2014 sends Y to active terminal instantly
</div>

<!-- Stats -->
<div class="stats">
    <div class="stat-card green">
        <div class="stat-val" id="statClicks">0</div>
        <div class="stat-lbl">Session accepts</div>
    </div>
    <div class="stat-card acc">
        <div class="stat-val" id="statTotal">${totalClicks}</div>
        <div class="stat-lbl">All-time accepts</div>
    </div>
    <div class="stat-card blue">
        <div class="stat-val" id="statTerminal">0</div>
        <div class="stat-lbl">Terminal accepts</div>
    </div>
    <div class="stat-card red">
        <div class="stat-val" id="statBlocked">0</div>
        <div class="stat-lbl">Blocked commands</div>
    </div>
</div>

<!-- Help box (shown when no engine connected) -->
<div class="help-box" id="helpBox" style="${engine !== "none" ? "display:none" : ""}">
    <strong>No engine connected?</strong><br>
    The <strong>Terminal Monitor</strong> works automatically with sideloaded VSIX extensions.<br>
    For CDP fallback, launch your IDE with: <code>${ide === "Cursor" ? "cursor" : ide === "Antigravity" ? "antigravity" : "code"} --remote-debugging-port=9222</code>
</div>

<!-- Engine mode -->
<div class="section">
    <div class="section-title">Engine</div>
    <label for="engineMode">Engine mode</label>
    <select id="engineMode">
        <option value="auto" ${cfg.engineMode === "auto" ? "selected" : ""}>Auto (terminal + CDP)</option>
        <option value="terminal-only" ${cfg.engineMode === "terminal-only" ? "selected" : ""}>Terminal only</option>
        <option value="cdp-only" ${cfg.engineMode === "cdp-only" ? "selected" : ""}>CDP only (v1.1 behavior)</option>
    </select>
    <p class="hint">Auto: terminal monitor first (zero-config), CDP as fallback. Terminal-only skips CDP. CDP-only requires debug port.</p>
</div>

<!-- Debug port -->
<div class="section">
    <div class="section-title">Connection</div>
    <label for="debugPort">Custom debug port (0 = auto-scan)</label>
    <input type="number" id="debugPort" min="0" max="65535" value="${cfg.debugPort || 0}">
    <p class="hint">If your IDE uses a specific debug port, set it here for faster CDP connection. Leave 0 for automatic scanning.</p>
</div>

<!-- Poll interval -->
<div class="section">
    <div class="section-title">Performance</div>
    <label for="pollRange">Poll interval</label>
    <div class="range-row">
        <input type="range" id="pollRange" min="300" max="3000" step="100" value="${cfg.pollInterval}" oninput="updatePollLabel()">
        <span class="range-val" id="pollLabel">${cfg.pollInterval} ms</span>
    </div>
    <p class="hint">How often Shadow Accept scans for buttons (CDP engine). Terminal engine responds instantly. Default: 800ms.</p>
</div>

<!-- Banned commands -->
<div class="section">
    <div class="section-title">Safety</div>
    <label for="bannedArea">Banned command patterns</label>
    <textarea id="bannedArea" placeholder="One pattern per line.
Supports /regex/flags syntax.">${bannedStr}</textarea>
    <p class="hint">Run/execute buttons and terminal commands matching these patterns will <strong>never</strong> be auto-accepted.</p>
</div>

<!-- Actions -->
<div class="btn-row">
    <button class="btn btn-primary" onclick="save()">Save settings</button>
    <button class="btn btn-secondary" onclick="resetDefaults()">Reset defaults</button>
    <button class="btn btn-secondary" onclick="showLog()">View log</button>
</div>

<!-- About -->
<div class="section">
    <div class="section-title">About</div>
    <div class="about-box">
        <p><strong>Shadow Accept</strong> is an open-source extension by <a onclick="openWebsite()" class="about-link">NakedoMedia</a> that auto-accepts AI agent prompts across VS Code, Cursor, Antigravity and Windsurf.</p>
        <p>Dual-engine architecture: zero-config Terminal Monitor + CDP fallback. Smart safety via banned commands. No telemetry, no API keys, no limits.</p>
        <p class="about-meta">v1.2.0 &middot; MIT License &middot; Free forever</p>
        <div class="about-links">
            <a onclick="openWebsite()" class="about-btn">nakedo.ai</a>
            <a onclick="openGitHub()" class="about-btn about-btn-ghost">GitHub</a>
            <a onclick="reportIssue()" class="about-btn about-btn-ghost">Report issue</a>
        </div>
    </div>
</div>

<!-- Footer -->
<div class="footer">
    <span class="footer-logo">NAKEDO CORP</span>
    <div class="footer-links">
        <a onclick="openWebsite()">nakedo.ai</a>
        <a onclick="openGitHub()">GitHub</a>
        <a onclick="reportIssue()">Report issue</a>
    </div>
</div>

<div class="toast" id="toast"></div>

<script>
const vscode = acquireVsCodeApi();
let refreshInterval;

// \u2500\u2500 Init \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'stats') {
        document.getElementById('statClicks').textContent   = m.clicks   ?? 0;
        document.getElementById('statBlocked').textContent  = m.blocked  ?? 0;
        document.getElementById('statTotal').textContent    = m.total    ?? 0;
        document.getElementById('statTerminal').textContent = m.terminalClicks ?? 0;
        const on = !!m.enabled;
        const btn = document.getElementById('toggleBtn');
        btn.className = 'toggle-btn ' + (on ? 'on' : 'off');
        document.getElementById('toggleLabel').textContent = on ? 'Auto Accept is ON' : 'Auto Accept is OFF';
        document.getElementById('toggleIde').textContent   = m.ide || '';

        // Update connection badge
        const badge = document.getElementById('connBadge');
        const label = document.getElementById('connLabel');
        const helpBox = document.getElementById('helpBox');
        const engine = m.engine || 'none';
        if (engine !== 'none') {
            badge.className = 'conn-badge conn-ok';
            const labels = {
                'terminal+cdp': 'Terminal + CDP',
                'terminal': 'Terminal Monitor',
                'cdp': 'CDP on port ' + (m.port || '?'),
            };
            label.textContent = labels[engine] || engine;
            helpBox.style.display = 'none';
        } else if (on) {
            badge.className = 'conn-badge conn-err';
            label.textContent = 'Searching for engines...';
            helpBox.style.display = '';
        } else {
            badge.className = 'conn-badge conn-err';
            label.textContent = 'Disabled';
            helpBox.style.display = 'none';
        }

        // Update engine cards
        const termCard = document.getElementById('termCard');
        const cdpCard = document.getElementById('cdpCard');
        const termStatus = document.getElementById('termStatus');
        const cdpStatus = document.getElementById('cdpStatus');
        if (m.terminalActive) {
            termCard.classList.add('active');
            termStatus.textContent = 'Active \u2014 zero config';
        } else {
            termCard.classList.remove('active');
            termStatus.textContent = 'Inactive';
        }
        if (m.cdpConnected) {
            cdpCard.classList.add('active');
            cdpStatus.textContent = 'Connected on port ' + (m.port || '?');
        } else {
            cdpCard.classList.remove('active');
            cdpStatus.textContent = 'Not connected';
        }
    }
    if (m.type === 'saved') {
        showToast('Settings saved');
    }
});

function refresh() { vscode.postMessage({ type: 'getStats' }); }
refresh();
refreshInterval = setInterval(refresh, 1500);

// \u2500\u2500 Actions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function toggleAccept() { vscode.postMessage({ type: 'toggle' }); }

function updatePollLabel() {
    document.getElementById('pollLabel').textContent = document.getElementById('pollRange').value + ' ms';
}

function save() {
    vscode.postMessage({
        type:           'save',
        pollInterval:   parseInt(document.getElementById('pollRange').value, 10),
        debugPort:      parseInt(document.getElementById('debugPort').value, 10) || 0,
        engineMode:     document.getElementById('engineMode').value,
        bannedCommands: document.getElementById('bannedArea').value
            .split('\\n').map(s => s.trim()).filter(Boolean),
    });
}

function resetDefaults() {
    document.getElementById('pollRange').value = 800;
    document.getElementById('debugPort').value = 0;
    document.getElementById('engineMode').value = 'auto';
    updatePollLabel();
    document.getElementById('bannedArea').value = [
        'rm -rf /', 'rm -rf ~', 'rm -rf *', 'format c:',
        'del /f /s /q', 'rmdir /s /q', ':(){:|:&};:',
        'dd if=', 'mkfs.', '> /dev/sda', 'chmod -R 777 /',
    ].join('\\n');
    showToast('Defaults restored');
}

function showLog()       { vscode.postMessage({ type: 'openOutput' }); }
function openGitHub()    { vscode.postMessage({ type: 'openLink', url: 'https://github.com/NakedoMedia/shadow-accept' }); }
function reportIssue()   { vscode.postMessage({ type: 'openLink', url: 'https://github.com/NakedoMedia/shadow-accept/issues' }); }
function openWebsite()   { vscode.postMessage({ type: 'openLink', url: 'https://nakedo.ai' }); }

// \u2500\u2500 Toast \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
}
</script>
</body>
</html>`
  );
}
async function activate(context) {
  globalContext = context;
  currentIDE = detectIDE();
  outputChannel = vscode.window.createOutputChannel("Shadow Accept");
  context.subscriptions.push(outputChannel);
  log(`Shadow Accept v1.2 activating on ${currentIDE}`);
  engineManager = new EngineManager(log, vscode);
  const cfg = getConfig();
  if (cfg.debugPort > 0) {
    engineManager.setCustomPorts([cfg.debugPort]);
  }
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "shadow-accept.toggle";
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();
  isEnabled = context.globalState.get(STATE_ENABLED_KEY, cfg.enableOnStartup);
  updateStatusBar();
  if (isEnabled) {
    log("Restoring enabled state...");
    startPolling();
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("shadow-accept.toggle", () => cmdToggle(context)),
    vscode.commands.registerCommand("shadow-accept.openSettings", () => cmdOpenSettings(context)),
    vscode.commands.registerCommand("shadow-accept.quickAccept", () => cmdQuickAccept())
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("shadowAccept")) {
        const newCfg = getConfig();
        if (newCfg.debugPort > 0) {
          engineManager.setCustomPorts([newCfg.debugPort]);
        }
        if (isEnabled) {
          log("Config changed, restarting poll");
          startPolling();
        }
      }
    })
  );
  const hasSeenWelcome = context.globalState.get("shadow-accept.welcomed", false);
  if (!hasSeenWelcome) {
    await context.globalState.update("shadow-accept.welcomed", true);
    vscode.window.showInformationMessage(
      "Shadow Accept by Nakedo Corp is ready. Click the status bar to enable.",
      "Enable now",
      "Settings"
    ).then((choice) => {
      if (choice === "Enable now") cmdToggle(context);
      if (choice === "Settings") cmdOpenSettings(context);
    });
  }
  log("Activation complete.");
}
function deactivate() {
  stopPolling();
  if (globalContext && sessionClicks > 0) {
    const prev = globalContext.globalState.get(STATE_TOTAL_CLICKS) ?? 0;
    globalContext.globalState.update(STATE_TOTAL_CLICKS, prev + sessionClicks);
  }
  log("Deactivated.");
}
module.exports = { activate, deactivate };
