import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  APPROVAL_TTL_MS,
  CodexAppServerClient,
  JsonRpcConnection,
  MAX_CLOCK_SKEW_MS,
  MAX_PENDING_PAIR_CODES,
  PAIR_CODE_TTL_MS,
  StateStore,
  TelegramBotClient,
  TelegramBridge,
  TELEGRAM_MODE_CHANNEL,
  TELEGRAM_MODE_RELAY,
  TELEGRAM_NO_REPLY_WARNING,
  TelegramWakeSupervisor,
  approvalButtons,
  assertStartupSecurity,
  bridgeDaemonPaths,
  bridgeDaemonStatus,
  chunkTelegramText,
  pairAccessCode,
  prepareStartupStateSecurity,
  readTelegramBotToken,
  redactSecrets,
  renderTelegramChannelPrompt,
  renderTelegramFinalPreview,
  runSecurityChecks,
  startBridgeDaemon,
  startWakeSupervisorDaemon,
  telegramDynamicTools,
  wakeSupervisorPaths
} from "../src/bridge.mjs";

const FAKE_TELEGRAM_TOKEN = ["123456789", "A".repeat(35)].join(":");
const FAKE_OPENAI_KEY = ["sk", "proj", "a".repeat(36)].join("-");
const FAKE_GITHUB_PAT = ["github", "pat", "A".repeat(32), "a".repeat(16)].join("_");
const FAKE_STRIPE_KEY = ["sk", "live", "a".repeat(24)].join("_");
const FAKE_PRIVATE_KEY = [
  [["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")],
  "secret",
  [["-----END", "PRIVATE", "KEY-----"].join(" ")]
].join("\n");

async function tempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-bridge-test-"));
}

async function auditEvents(stateDir) {
  const text = await fs.readFile(path.join(stateDir, "audit.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeTelegram {
  constructor() {
    this.sent = [];
    this.edits = [];
    this.answered = [];
    this.actions = [];
    this.reactions = [];
  }

  async sendMessage(chatId, text, extra = {}) {
    const message = { chatId, text, extra, message_id: this.sent.length + 1 };
    this.sent.push(message);
    return message;
  }

  async editMessageText(chatId, messageId, text, extra = {}) {
    const edit = { chatId, messageId, text, extra };
    this.edits.push(edit);
    return edit;
  }

  async answerCallbackQuery(callbackQueryId, text = "") {
    this.answered.push({ callbackQueryId, text });
    return true;
  }

  async sendChatAction(chatId, action = "typing") {
    this.actions.push({ chatId, action });
    return true;
  }

  async setMessageReaction(chatId, messageId, emoji) {
    this.reactions.push({ chatId, messageId, emoji });
    return true;
  }
}

class FakeApp extends EventEmitter {
  constructor() {
    super();
    this.threadId = "thr_initial";
    this.activeTurnId = null;
    this.started = false;
    this.threadCount = 0;
    this.startTurnCalls = [];
    this.steerCalls = [];
    this.interruptCalls = [];
    this.decisions = [];
    this.stopped = false;
  }

  async start() {
    this.started = true;
  }

  async startThread() {
    this.threadCount += 1;
    this.threadId = `thr_${this.threadCount}`;
    this.activeTurnId = null;
    return this.threadId;
  }

  async startTurn(text, meta = null) {
    this.startTurnCalls.push(meta ? { text, meta } : text);
    this.activeTurnId = `turn_${this.startTurnCalls.length}`;
    return this.activeTurnId;
  }

  async steerTurn(text, expectedTurnId, meta = null) {
    this.steerCalls.push(meta ? { text, expectedTurnId, meta } : { text, expectedTurnId });
    return expectedTurnId;
  }

  async interruptTurn(turnId) {
    this.interruptCalls.push(turnId);
    return true;
  }

  respondServerRequest(id, decision) {
    this.decisions.push({ id, decision });
  }

  stop() {
    this.stopped = true;
  }
}

function setActiveBridgeTurn(bridge, threadId = "thr_initial", turnId = "turn_1") {
  bridge.threadId = threadId;
  bridge.app.threadId = threadId;
  bridge.activeTurnId = turnId;
  bridge.turnActive = true;
  return { threadId, turnId };
}

class FakeRpc extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
    this.notifications = [];
    this.responses = [];
  }

  start() {}

  async request(method, params = {}) {
    this.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thr_rpc" } };
    if (method === "turn/start") return { turn: { id: "turn_rpc" } };
    if (method === "turn/steer") return { turnId: params.expectedTurnId };
    return {};
  }

  notify(method, params = {}) {
    this.notifications.push({ method, params });
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  close() {}
}

test("JsonRpcConnection frames requests, dispatches server requests, and sends responses", async () => {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const rpc = new JsonRpcConnection({
    input: serverToClient,
    output: clientToServer,
    requestTimeoutMs: 1000
  });
  const written = [];
  clientToServer.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      if (line) written.push(JSON.parse(line));
    }
  });

  rpc.start();
  const responsePromise = rpc.request("thread/start", { cwd: "/tmp/project" });
  await nextTick();

  assert.equal(written[0].method, "thread/start");
  assert.deepEqual(written[0].params, { cwd: "/tmp/project" });

  serverToClient.write(`${JSON.stringify({ id: written[0].id, result: { thread: { id: "thr_123" } } })}\n`);
  assert.deepEqual(await responsePromise, { thread: { id: "thr_123" } });

  const serverRequestPromise = once(rpc, "serverRequest");
  serverToClient.write(
    `${JSON.stringify({
      id: 99,
      method: "item/fileChange/requestApproval",
      params: { itemId: "item_1" }
    })}\n`
  );
  const [request] = await serverRequestPromise;
  assert.equal(request.id, 99);
  assert.equal(request.method, "item/fileChange/requestApproval");

  rpc.respond(99, "decline");
  await nextTick();
  assert.deepEqual(written.at(-1), { id: 99, result: "decline" });
  rpc.close();
});

test("JsonRpcConnection protocol errors do not echo raw child output", async () => {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const rpc = new JsonRpcConnection({
    input: serverToClient,
    output: clientToServer,
    requestTimeoutMs: 1000
  });

  rpc.start();
  const protocolErrorPromise = once(rpc, "protocolError");
  serverToClient.write(`OPENAI_API_KEY=${FAKE_OPENAI_KEY}\n`);
  const [error] = await protocolErrorPromise;

  assert.doesNotMatch(error.message, /OPENAI_API_KEY/);
  assert.doesNotMatch(error.message, /sk-proj-/);
  rpc.close();
});

test("Codex app-server child env excludes Telegram bridge secrets", async () => {
  let capturedEnv = null;
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
      if (message.method === "thread/start") {
        stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "thr_1" } } })}\n`);
      }
    }
  });

  const client = new CodexAppServerClient({
    cwd: "/tmp/project",
    codexBin: "codex",
    env: {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "needed-by-codex",
      TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
      TELEGRAM_CODEX_STATE_DIR: "/tmp/bridge-state"
    },
    spawnFn: (_command, _args, options) => {
      capturedEnv = options.env;
      return {
        stdout,
        stdin,
        stderr,
        killed: false,
        on() {},
        kill() {
          this.killed = true;
        }
      };
    }
  });

  await client.start();
  assert.equal(client.threadId, "thr_1");
  assert.equal(capturedEnv.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(capturedEnv.TELEGRAM_CODEX_STATE_DIR, undefined);
  assert.equal(capturedEnv.OPENAI_API_KEY, "needed-by-codex");
  assert.equal(capturedEnv.PATH, "/usr/bin");
  client.stop();
});

test("Codex app-server client enables dynamic Telegram tools only in channel mode", async () => {
  const channelRpc = new FakeRpc();
  const channelClient = new CodexAppServerClient({
    cwd: "/tmp/project",
    rpc: channelRpc,
    telegramMode: TELEGRAM_MODE_CHANNEL
  });

  await channelClient.start();
  const channelInitialize = channelRpc.requests.find((request) => request.method === "initialize");
  const channelThreadStart = channelRpc.requests.find((request) => request.method === "thread/start");
  assert.deepEqual(channelInitialize.params.capabilities, { experimentalApi: true });
  assert.equal(Array.isArray(channelThreadStart.params.dynamicTools), true);
  assert.equal(channelThreadStart.params.dynamicTools.some((tool) => tool.namespace === "telegram" && tool.name === "reply"), true);

  const relayRpc = new FakeRpc();
  const relayClient = new CodexAppServerClient({
    cwd: "/tmp/project",
    rpc: relayRpc,
    telegramMode: TELEGRAM_MODE_RELAY
  });

  await relayClient.start();
  const relayInitialize = relayRpc.requests.find((request) => request.method === "initialize");
  const relayThreadStart = relayRpc.requests.find((request) => request.method === "thread/start");
  assert.equal(relayInitialize.params.capabilities, undefined);
  assert.equal(relayThreadStart.params.dynamicTools, undefined);
});

test("Codex app-server client wraps Telegram text in channel mode and preserves raw relay text", async () => {
  const channelRpc = new FakeRpc();
  const channelClient = new CodexAppServerClient({
    cwd: "/tmp/project",
    rpc: channelRpc,
    telegramMode: TELEGRAM_MODE_CHANNEL
  });
  await channelClient.start();
  await channelClient.startTurn("Summarize this repo.", {
    chatId: "111",
    messageId: "10",
    userId: "111",
    username: "owner",
    receivedAt: "2026-05-04T00:00:00.000Z"
  });
  const channelTurnStart = channelRpc.requests.find((request) => request.method === "turn/start");
  const channelText = channelTurnStart.params.input[0].text;
  assert.match(channelText, /Use the telegram\.reply dynamic tool/);
  assert.match(channelText, /chat_id: 111/);
  assert.match(channelText, /-----BEGIN TELEGRAM TEXT-----\nSummarize this repo\./);

  const relayRpc = new FakeRpc();
  const relayClient = new CodexAppServerClient({
    cwd: "/tmp/project",
    rpc: relayRpc,
    telegramMode: TELEGRAM_MODE_RELAY
  });
  await relayClient.start();
  await relayClient.startTurn("Raw relay text.");
  const relayTurnStart = relayRpc.requests.find((request) => request.method === "turn/start");
  assert.equal(relayTurnStart.params.input[0].text, "Raw relay text.");
});

test("Telegram dynamic tool specs are text-only and channel prompt is explicit", () => {
  const tools = telegramDynamicTools();
  const reply = tools.find((tool) => tool.name === "reply");
  const edit = tools.find((tool) => tool.name === "edit_message");
  assert.equal(reply.namespace, "telegram");
  assert.equal(reply.inputSchema.properties.files, undefined);
  assert.equal(edit.inputSchema.properties.files, undefined);

  const prompt = renderTelegramChannelPrompt("Can you respond here?", {
    chatId: "111",
    messageId: "10",
    userId: "111",
    receivedAt: "2026-05-04T00:00:00.000Z"
  });
  assert.match(prompt, /Normal assistant text is not sent to Telegram/);
  assert.match(prompt, /Do not try to send files/);
});

test("Telegram token file loading requires a private regular file", async () => {
  const stateDir = await tempStateDir();
  const tokenPath = path.join(stateDir, "bot-token");
  await fs.writeFile(tokenPath, `${FAKE_TELEGRAM_TOKEN}\n`, { mode: 0o600 });

  assert.equal(readTelegramBotToken({ env: { HOME: stateDir }, tokenFile: tokenPath }), FAKE_TELEGRAM_TOKEN);

  await fs.chmod(tokenPath, 0o644);
  assert.throws(
    () => readTelegramBotToken({ env: { HOME: stateDir }, tokenFile: tokenPath }),
    /Telegram token file is too open/
  );

  await fs.chmod(tokenPath, 0o600);
  const symlinkPath = path.join(stateDir, "bot-token-link");
  await fs.symlink(tokenPath, symlinkPath);
  assert.throws(
    () => readTelegramBotToken({ env: { HOME: stateDir }, tokenFile: symlinkPath }),
    /must not be a symbolic link/
  );
});

test("security check accepts a private token file without storing the token", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const tokenPath = path.join(stateDir, "bot-token");
  await fs.writeFile(tokenPath, `${FAKE_TELEGRAM_TOKEN}\n`, { mode: 0o600 });

  const results = await runSecurityChecks({
    stateDir,
    tokenFile: tokenPath,
    strict: true,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "",
      CODEX_BIN: process.execPath
    }
  });

  assert.equal(results.some((result) => result.status === "fail"), false);
  assert.equal(results.find((result) => result.id === "telegram-token")?.status, "ok");
  assert.equal(results.some((result) => JSON.stringify(result).includes(FAKE_TELEGRAM_TOKEN)), false);
});

test("daemon startup does not put Telegram tokens in argv or PID metadata", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const tokenPath = path.join(stateDir, "bot-token");
  await fs.writeFile(tokenPath, `${FAKE_TELEGRAM_TOKEN}\n`, { mode: 0o600 });

  let capturedArgs = null;
  let capturedOptions = null;
  const fakeSpawn = (_nodeBin, args, options) => {
    capturedArgs = args;
    capturedOptions = options;
    return {
      pid: 987654321,
      unref() {}
    };
  };

  const status = await startBridgeDaemon({
    cwd: stateDir,
    stateDir,
    tokenFile: tokenPath,
    codexBin: process.execPath,
    nodeBin: process.execPath,
    spawnFn: fakeSpawn
  });

  assert.equal(status.pid, 987654321);
  assert.equal(capturedOptions.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(capturedArgs.join(" ").includes(FAKE_TELEGRAM_TOKEN), false);
  assert.equal(capturedArgs.includes("--token-file"), true);
  const pidText = await fs.readFile(bridgeDaemonPaths(stateDir).pidPath, "utf8");
  assert.equal(pidText.includes(FAKE_TELEGRAM_TOKEN), false);
});

test("daemon startup does not override an env token with the default token file", async () => {
  const stateDir = await tempStateDir();
  const homeDir = await tempStateDir();
  const defaultTokenDir = path.join(homeDir, ".codex-telegram-bridge");
  const staleDefaultToken = ["987654321", "B".repeat(35)].join(":");
  await fs.mkdir(defaultTokenDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(defaultTokenDir, "bot-token"), `${staleDefaultToken}\n`, { mode: 0o600 });

  let capturedArgs = null;
  let capturedOptions = null;
  const fakeSpawn = (_nodeBin, args, options) => {
    capturedArgs = args;
    capturedOptions = options;
    return {
      pid: 123456789,
      unref() {}
    };
  };

  await startBridgeDaemon({
    cwd: stateDir,
    stateDir,
    codexBin: process.execPath,
    nodeBin: process.execPath,
    env: {
      ...process.env,
      HOME: homeDir,
      TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
      CODEX_BIN: process.execPath
    },
    spawnFn: fakeSpawn
  });

  assert.equal(capturedArgs.includes("--token-file"), false);
  assert.equal(capturedOptions.env.TELEGRAM_BOT_TOKEN, FAKE_TELEGRAM_TOKEN);
  assert.equal(capturedOptions.env.TELEGRAM_BOT_TOKEN.includes(staleDefaultToken), false);
});

test("daemon status reports stale PID files", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  const { pidPath, logPath } = bridgeDaemonPaths(stateDir);
  await fs.writeFile(
    pidPath,
    `${JSON.stringify({
      version: 1,
      pid: 987654321,
      startedAt: new Date(0).toISOString(),
      stateDir,
      logPath
    })}\n`,
    { mode: 0o600 }
  );

  const status = await bridgeDaemonStatus({ stateDir });

  assert.equal(status.running, false);
  assert.equal(status.stale, true);
  assert.equal(status.pid, 987654321);
});

test("wake supervisor starts the bridge on paired private /tgon only", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const startCalls = [];
  const supervisor = new TelegramWakeSupervisor({
    telegram,
    store,
    stateDir,
    cwd: "/tmp/project",
    codexBin: process.execPath,
    startDaemon: async (options) => {
      startCalls.push(options);
      return { pid: 12345 };
    }
  });

  await supervisor.handleMessage({
    chat: { id: 222, type: "private" },
    from: { id: 222 },
    text: "/tgon"
  });
  assert.equal(startCalls.length, 0);
  assert.equal(telegram.sent.length, 0);

  await supervisor.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "/tgon"
  });

  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].cwd, "/tmp/project");
  assert.match(telegram.sent[0].text, /Starting Codex Telegram Bridge/);
  assert.match(telegram.sent[1].text, /Bridge is on/);
  assert.equal((await auditEvents(stateDir)).some((event) => event.event === "bridge_wake_requested"), true);
});

test("wake supervisor reports off status without starting the bridge", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const supervisor = new TelegramWakeSupervisor({
    telegram,
    store,
    stateDir,
    cwd: "/tmp/project",
    startDaemon: async () => {
      throw new Error("should not start");
    }
  });

  await supervisor.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "/status"
  });

  assert.match(telegram.sent.at(-1).text, /Wake listener is on/);
  assert.match(telegram.sent.at(-1).text, /Bridge is off/);
});

test("wake supervisor warns instead of silently consuming text while bridge is off", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const supervisor = new TelegramWakeSupervisor({
    telegram,
    store,
    stateDir,
    cwd: "/tmp/project",
    startDaemon: async () => {
      throw new Error("should not start");
    }
  });

  await supervisor.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "keep this context warm"
  });

  assert.match(telegram.sent.at(-1).text, /Send \/tgon to start it/);

  await supervisor.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "/bogus"
  });

  assert.match(telegram.sent.at(-1).text, /only handles \/tgon/);
});

test("wake supervisor daemon startup does not put Telegram tokens in argv or PID metadata", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const tokenPath = path.join(stateDir, "bot-token");
  await fs.writeFile(tokenPath, `${FAKE_TELEGRAM_TOKEN}\n`, { mode: 0o600 });

  let capturedArgs = null;
  let capturedOptions = null;
  const fakeSpawn = (_nodeBin, args, options) => {
    capturedArgs = args;
    capturedOptions = options;
    return {
      pid: 876543210,
      unref() {}
    };
  };

  const status = await startWakeSupervisorDaemon({
    cwd: stateDir,
    stateDir,
    tokenFile: tokenPath,
    codexBin: process.execPath,
    nodeBin: process.execPath,
    spawnFn: fakeSpawn
  });

  assert.equal(status.pid, 876543210);
  assert.equal(capturedOptions.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(capturedArgs.join(" ").includes(FAKE_TELEGRAM_TOKEN), false);
  const pidText = await fs.readFile(wakeSupervisorPaths(stateDir).pidPath, "utf8");
  assert.equal(pidText.includes(FAKE_TELEGRAM_TOKEN), false);
});

test("wake supervisor daemon does not override an env token with the default token file", async () => {
  const stateDir = await tempStateDir();
  const homeDir = await tempStateDir();
  const defaultTokenDir = path.join(homeDir, ".codex-telegram-bridge");
  const staleDefaultToken = ["987654321", "C".repeat(35)].join(":");
  await fs.mkdir(defaultTokenDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(defaultTokenDir, "bot-token"), `${staleDefaultToken}\n`, { mode: 0o600 });

  let capturedArgs = null;
  let capturedOptions = null;
  const fakeSpawn = (_nodeBin, args, options) => {
    capturedArgs = args;
    capturedOptions = options;
    return {
      pid: 876543219,
      unref() {}
    };
  };

  await startWakeSupervisorDaemon({
    cwd: stateDir,
    stateDir,
    codexBin: process.execPath,
    nodeBin: process.execPath,
    env: {
      ...process.env,
      HOME: homeDir,
      TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
      CODEX_BIN: process.execPath
    },
    spawnFn: fakeSpawn
  });

  assert.equal(capturedArgs.includes("--token-file"), false);
  assert.equal(capturedOptions.env.TELEGRAM_BOT_TOKEN, FAKE_TELEGRAM_TOKEN);
  assert.equal(capturedOptions.env.TELEGRAM_BOT_TOKEN.includes(staleDefaultToken), false);
});

test("TelegramBotClient posts redacted send and edit requests through fetch", async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: calls.length } })
    };
  };
  const client = new TelegramBotClient({
    token: FAKE_TELEGRAM_TOKEN,
    fetchFn
  });

  await client.sendMessage(10, `OPENAI_API_KEY=${FAKE_OPENAI_KEY}`);
  await client.editMessageText(10, 1, FAKE_GITHUB_PAT);
  await client.sendMessage(10, "safe", {
    chat_id: 999,
    text: `OPENAI_API_KEY=${FAKE_OPENAI_KEY}`
  });
  await client.editMessageText(10, 1, "safe edit", {
    chat_id: 999,
    message_id: 999,
    text: FAKE_GITHUB_PAT
  });

  assert.equal(calls[0].url.endsWith("/sendMessage"), true);
  assert.equal(calls[1].url.endsWith("/editMessageText"), true);
  assert.doesNotMatch(calls[0].body.text, /sk-proj-/);
  assert.doesNotMatch(calls[1].body.text, /github_pat_/);
  assert.equal(calls[2].body.chat_id, 10);
  assert.equal(calls[2].body.text, "safe");
  assert.equal(calls[3].body.chat_id, 10);
  assert.equal(calls[3].body.message_id, 1);
  assert.equal(calls[3].body.text, "safe edit");
});

test("pairing locks the bridge to one Telegram user and drops unknown users", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project", telegramMode: TELEGRAM_MODE_RELAY });

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111, username: "owner", first_name: "Owner" },
    text: "/start"
  });

  assert.match(telegram.sent[0].text, /access pair \d{6}/);
  const pending = (await store.readState()).pendingPairCodes;
  const code = Object.keys(pending)[0];
  await pairAccessCode(code, { stateDir });

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111, username: "owner" },
    text: "/help"
  });
  assert.match(telegram.sent.at(-1).text, /\/new/);

  const sentBeforeDrop = telegram.sent.length;
  await bridge.handleMessage({
    chat: { id: 222, type: "private" },
    from: { id: 222, username: "stranger" },
    text: "hello"
  });
  assert.equal(telegram.sent.length, sentBeforeDrop);

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "/new"
  });
  assert.equal(app.threadId, "thr_1");
  assert.match(telegram.sent.at(-1).text, /New Codex thread started/);
});

test("pairing reuses active codes per user and caps pending pair codes", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();

  const first = await store.createPairCode({ id: 111, username: "owner" });
  const second = await store.createPairCode({ id: 111, username: "owner" });
  assert.equal(second, first);

  for (let id = 200; id < 200 + MAX_PENDING_PAIR_CODES + 5; id += 1) {
    await store.createPairCode({ id, username: `user${id}` });
  }

  const state = await store.readState();
  assert.equal(Object.keys(state.pendingPairCodes).length, MAX_PENDING_PAIR_CODES);
});

test("pairing treats malformed pair-code timestamps as expired", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    pendingPairCodes: {
      123456: {
        telegramUserId: "111",
        requestedAt: "not-a-date"
      }
    }
  });

  await assert.rejects(() => pairAccessCode("123456", { stateDir }), /Pair code expired/);

  await store.createPairCode({ id: 111, username: "owner" });
  assert.equal(Object.hasOwn((await store.readState()).pendingPairCodes, "123456"), false);
});

test("pairing treats future-dated pair-code timestamps as expired", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    pendingPairCodes: {
      123456: {
        telegramUserId: "111",
        requestedAt: new Date(Date.now() + PAIR_CODE_TTL_MS + MAX_CLOCK_SKEW_MS).toISOString()
      }
    }
  });

  await assert.rejects(() => pairAccessCode("123456", { stateDir }), /Pair code expired/);

  await store.createPairCode({ id: 111, username: "owner" });
  assert.equal(Object.hasOwn((await store.readState()).pendingPairCodes, "123456"), false);
});

test("non-private Telegram chats are ignored", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project", telegramMode: TELEGRAM_MODE_RELAY });

  await bridge.handleMessage({
    chat: { id: -100, type: "group" },
    from: { id: 111, username: "owner" },
    text: "/start"
  });
  assert.equal(telegram.sent.length, 0);
  assert.deepEqual(Object.keys((await store.readState()).pendingPairCodes), []);

  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  await bridge.handleMessage({
    chat: { id: -100, type: "supergroup" },
    from: { id: 111, username: "owner" },
    text: "Summarize this repo."
  });
  assert.deepEqual(app.startTurnCalls, []);
  assert.equal(telegram.sent.length, 0);
});

test("runtime allowlist with multiple users fails closed", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111", "222"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project", telegramMode: TELEGRAM_MODE_RELAY });

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "This should not run."
  });
  assert.deepEqual(app.startTurnCalls, []);
  assert.equal(telegram.sent.length, 0);

  bridge.activeChatId = 111;
  const context = setActiveBridgeTurn(bridge);
  await bridge.handleAppServerRequest({
    id: 40,
    method: "item/commandExecution/requestApproval",
    params: {
      ...context,
      itemId: "item_invalid_allowlist",
      command: "echo blocked",
      availableDecisions: ["accept", "decline", "cancel"]
    }
  });
  assert.deepEqual(app.decisions, [{ id: 40, decision: "cancel" }]);
  assert.equal(telegram.sent.length, 0);
  assert.equal((await auditEvents(stateDir)).some((event) => event.event === "allowlist_invalid"), true);
});

test("Telegram update offsets are persisted before handling updates", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });

  await bridge.markTelegramUpdateSeen(55);
  assert.equal((await store.readState()).telegramUpdateOffset, 56);

  const restarted = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  await restarted.loadTelegramUpdateOffset();
  assert.equal(restarted.offset, 56);

  await restarted.markTelegramUpdateSeen(54);
  assert.equal((await store.readState()).telegramUpdateOffset, 56);
});

test("text starts a turn, follow-up text steers, and media is rejected", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project", telegramMode: TELEGRAM_MODE_RELAY });

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    message_id: 10,
    text: "Summarize this repo."
  });
  assert.deepEqual(app.startTurnCalls, ["Summarize this repo."]);
  assert.equal(bridge.turnActive, true);
  assert.deepEqual(telegram.actions, [{ chatId: 111, action: "typing" }]);
  assert.deepEqual(telegram.reactions, [{ chatId: 111, messageId: 10, emoji: "\u{1F440}" }]);
  assert.equal(telegram.sent.length, 0);

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    message_id: 11,
    text: "Focus on tests."
  });
  assert.deepEqual(app.steerCalls, [{ text: "Focus on tests.", expectedTurnId: "turn_1" }]);
  assert.deepEqual(telegram.actions.at(-1), { chatId: 111, action: "typing" });
  assert.deepEqual(telegram.reactions.at(-1), { chatId: 111, messageId: 11, emoji: "\u{1F440}" });
  assert.equal(telegram.sent.length, 0);

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    document: { file_id: "file" }
  });
  assert.match(telegram.sent.at(-1).text, /Text only/);
});

test("channel mode uses Telegram metadata and warns instead of auto-relaying unsent output", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111, username: "owner" },
    message_id: 10,
    date: 1777852800,
    text: "Summarize this repo."
  });

  assert.equal(app.startTurnCalls.length, 1);
  assert.deepEqual(app.startTurnCalls[0], {
    text: "Summarize this repo.",
    meta: {
      chatId: "111",
      messageId: "10",
      userId: "111",
      username: "owner",
      receivedAt: "2026-05-04T00:00:00.000Z"
    }
  });
  assert.equal(telegram.sent.length, 0);

  await bridge.handleAppNotification({
    method: "item/agentMessage/delta",
    params: { delta: "This local model output should not be relayed automatically." }
  });
  await bridge.handleAppNotification({
    method: "turn/completed",
    params: { status: "completed" }
  });

  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].text, TELEGRAM_NO_REPLY_WARNING);
  assert.doesNotMatch(telegram.sent[0].text, /local model output/);
  assert.equal((await auditEvents(stateDir)).some((event) => event.event === "channel_turn_completed_without_reply"), true);

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "/more"
  });
  assert.equal(telegram.sent.at(-1).text, "/more is only available in relay mode.");
});

test("channel mode handles Telegram reply, edit, and react dynamic tools with chat binding", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  bridge.threadId = "thr_initial";
  bridge.activeTurnId = "turn_1";
  bridge.turnActive = true;
  bridge.currentChannelContext = {
    chatId: "111",
    messageId: "10",
    userId: "111",
    username: "owner",
    threadId: "thr_initial",
    turnId: "turn_1"
  };

  await bridge.handleAppServerRequest({
    id: 100,
    method: "item/tool/call",
    params: {
      namespace: "telegram",
      tool: "reply",
      callId: "call_reply",
      threadId: "thr_initial",
      turnId: "turn_1",
      arguments: {
        chat_id: "111",
        reply_to: "10",
        text: "Short Telegram answer."
      }
    }
  });

  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].text, "Short Telegram answer.");
  assert.deepEqual(telegram.sent[0].extra.reply_parameters, { message_id: 10 });
  assert.equal(app.decisions.at(-1).decision.success, true);
  assert.match(app.decisions.at(-1).decision.contentItems[0].text, /Sent Telegram message id/);

  await bridge.handleAppServerRequest({
    id: 101,
    method: "item/tool/call",
    params: {
      namespace: "telegram",
      tool: "edit_message",
      callId: "call_edit",
      threadId: "thr_initial",
      turnId: "turn_1",
      arguments: {
        chat_id: "111",
        message_id: "1",
        text: "Edited Telegram answer."
      }
    }
  });
  assert.equal(telegram.edits.length, 1);
  assert.equal(telegram.edits[0].text, "Edited Telegram answer.");
  assert.equal(app.decisions.at(-1).decision.success, true);

  await bridge.handleAppServerRequest({
    id: 102,
    method: "item/tool/call",
    params: {
      namespace: "telegram",
      tool: "react",
      callId: "call_react",
      threadId: "thr_initial",
      turnId: "turn_1",
      arguments: {
        chat_id: "111",
        message_id: "10",
        emoji: "\u{1F44D}"
      }
    }
  });
  assert.deepEqual(telegram.reactions.at(-1), { chatId: 111, messageId: "10", emoji: "\u{1F44D}" });
  assert.equal(app.decisions.at(-1).decision.success, true);

  await bridge.handleAppServerRequest({
    id: 103,
    method: "item/tool/call",
    params: {
      namespace: "telegram",
      tool: "reply",
      callId: "call_wrong_chat",
      threadId: "thr_initial",
      turnId: "turn_1",
      arguments: {
        chat_id: "222",
        text: "Do not send."
      }
    }
  });
  assert.equal(telegram.sent.length, 1);
  assert.equal(app.decisions.at(-1).decision.success, false);
  assert.match(app.decisions.at(-1).decision.contentItems[0].text, /not the active allowed chat/);

  await bridge.handleAppServerRequest({
    id: 104,
    method: "item/tool/call",
    params: {
      namespace: "telegram",
      tool: "reply",
      callId: "call_file",
      threadId: "thr_initial",
      turnId: "turn_1",
      arguments: {
        text: "No files.",
        files: ["/tmp/secret.txt"]
      }
    }
  });
  assert.equal(telegram.sent.length, 1);
  assert.equal(app.decisions.at(-1).decision.success, false);
  assert.match(app.decisions.at(-1).decision.contentItems[0].text, /text-only/);

  bridge.agentText = "This local output should stay local because telegram.reply already ran.";
  await bridge.handleAppNotification({
    method: "turn/completed",
    params: { status: "completed" }
  });
  assert.equal(telegram.sent.length, 1);
});

test("channel mode rejects edits of messages not sent during the current turn", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  bridge.threadId = "thr_initial";
  bridge.activeTurnId = "turn_1";
  bridge.turnActive = true;
  bridge.currentChannelContext = {
    chatId: "111",
    messageId: "10",
    threadId: "thr_initial",
    turnId: "turn_1"
  };

  await bridge.handleAppServerRequest({
    id: 105,
    method: "item/tool/call",
    params: {
      namespace: "telegram",
      tool: "edit_message",
      callId: "call_unknown_edit",
      threadId: "thr_initial",
      turnId: "turn_1",
      arguments: {
        chat_id: "111",
        message_id: "999",
        text: "Do not edit."
      }
    }
  });

  assert.equal(telegram.edits.length, 0);
  assert.equal(app.decisions.at(-1).decision.success, false);
  assert.match(app.decisions.at(-1).decision.contentItems[0].text, /Can only edit Telegram messages/);
});

test("channel mode rejects Telegram dynamic tools without exact active context", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  setActiveBridgeTurn(bridge);
  bridge.currentChannelContext = {
    chatId: "111",
    messageId: "10",
    threadId: "thr_initial",
    turnId: "turn_1"
  };

  await bridge.handleAppServerRequest({
    id: 106,
    method: "item/tool/call",
    params: {
      namespace: "telegram",
      tool: "reply",
      callId: "call_missing_context",
      arguments: {
        chat_id: "111",
        text: "Do not send."
      }
    }
  });

  assert.equal(telegram.sent.length, 0);
  assert.equal(app.decisions.at(-1).decision.success, false);
  assert.match(app.decisions.at(-1).decision.contentItems[0].text, /stale Codex turn context/);

  await bridge.handleAppServerRequest({
    id: 107,
    method: "item/tool/call",
    params: {
      namespace: "telegram",
      tool: "reply",
      callId: "call_wrong_turn",
      threadId: "thr_initial",
      turnId: "turn_other",
      arguments: {
        chat_id: "111",
        text: "Still do not send."
      }
    }
  });

  assert.equal(telegram.sent.length, 0);
  assert.equal(app.decisions.at(-1).decision.success, false);
});

test("Telegram toggle commands explain startup and shut down the running bridge", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project", telegramMode: TELEGRAM_MODE_RELAY });

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "/tgon"
  });
  assert.match(telegram.sent.at(-1).text, /Bridge is already on/);
  assert.match(telegram.sent.at(-1).text, /node src\/bridge\.mjs on/);

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "/tgoff"
  });

  assert.equal(bridge.stopped, true);
  assert.equal(app.stopped, true);
  assert.match(telegram.sent.at(-1).text, /Bridge shutting down/);
  assert.equal((await auditEvents(stateDir)).some((event) => event.event === "bridge_shutdown_requested"), true);
});

test("active chat is revalidated before streaming output", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project", telegramMode: TELEGRAM_MODE_RELAY });
  bridge.activeChatId = 111;
  bridge.agentText = "sensitive response body";

  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["222"]
  });
  await bridge.flushStreamEdit();

  assert.equal(telegram.sent.length, 0);
  assert.equal(bridge.activeChatId, null);
  assert.equal((await auditEvents(stateDir)).some((event) => event.event === "active_chat_revoked"), true);
});

test("turn output is preview-sized by default and /more sends the saved full response", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project", telegramMode: TELEGRAM_MODE_RELAY });
  bridge.activeChatId = 111;
  bridge.turnActive = true;
  bridge.activeTurnId = "turn_1";

  await bridge.handleAppNotification({
    method: "item/agentMessage/delta",
    params: { delta: "A".repeat(2500) }
  });
  assert.equal(telegram.sent.length, 0);

  await bridge.handleAppNotification({
    method: "turn/completed",
    params: { status: "completed" }
  });

  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].text, /Output shortened for Telegram/);
  assert.equal(bridge.lastFinalText.length, 2500);
  assert.equal((await auditEvents(stateDir)).some((event) => event.event === "turn_output_shortened"), true);

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "/more"
  });
  assert.equal(telegram.sent.at(-1).text.length, 2500);
});

test("bridge errors sent to Telegram do not include local stack details", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const logger = { error() {} };
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project", logger });
  bridge.activeChatId = 111;

  await bridge.reportError(new Error(`OPENAI_API_KEY=${FAKE_OPENAI_KEY}`));

  assert.equal(telegram.sent.at(-1).text, "Bridge error. Check the local bridge logs for details.");
  assert.doesNotMatch(telegram.sent.at(-1).text, /OPENAI_API_KEY|sk-proj-/);
});

test("approval requests require exact active thread and turn ids", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;

  await bridge.handleAppServerRequest({
    id: 46,
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "item_missing_context",
      command: "echo should-not-prompt",
      availableDecisions: ["accept", "decline", "cancel"]
    }
  });

  assert.deepEqual(app.decisions, [{ id: 46, decision: "cancel" }]);
  assert.equal(telegram.sent.length, 0);

  const context = setActiveBridgeTurn(bridge);
  await bridge.handleAppServerRequest({
    id: 47,
    method: "item/commandExecution/requestApproval",
    params: {
      ...context,
      turnId: "turn_other",
      itemId: "item_wrong_turn",
      command: "echo should-not-prompt-either",
      availableDecisions: ["accept", "decline", "cancel"]
    }
  });

  assert.deepEqual(app.decisions.at(-1), { id: 47, decision: "cancel" });
  assert.equal(telegram.sent.length, 0);
  assert.equal((await auditEvents(stateDir)).some((event) => event.event === "approval_cancelled_stale_context"), true);
});

test("approval requests fall back to the current allowlist after active chat revocation", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  const context = setActiveBridgeTurn(bridge);

  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["222"]
  });
  await bridge.handleAppServerRequest({
    id: 41,
    method: "item/commandExecution/requestApproval",
    params: {
      ...context,
      itemId: "item_revoke",
      command: "echo current-allowlist",
      availableDecisions: ["accept", "decline", "cancel"]
    }
  });

  assert.equal(bridge.activeChatId, null);
  assert.equal(String(telegram.sent.at(-1).chatId), "222");
  assert.deepEqual(app.decisions, []);
});

test("malformed approval decision lists cancel fail-closed", async () => {
  assert.deepEqual(approvalButtons("abc", { accept: true }), []);

  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  const context = setActiveBridgeTurn(bridge);

  await bridge.handleAppServerRequest({
    id: 41,
    method: "item/commandExecution/requestApproval",
    params: {
      ...context,
      itemId: "item_malformed_decisions",
      command: "echo malformed",
      availableDecisions: { accept: true }
    }
  });

  assert.deepEqual(app.decisions, [{ id: 41, decision: "cancel" }]);
  assert.equal(telegram.sent.length, 0);
});

test("approval UI only emits accept, decline, or cancel", async () => {
  assert.deepEqual(
    approvalButtons("abc", ["accept", "acceptForSession", "decline", "cancel"]).flat().map((button) => button.callback_data),
    ["appr:abc:accept", "appr:abc:decline", "appr:abc:cancel"]
  );

  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  const context = setActiveBridgeTurn(bridge);

  await bridge.handleAppServerRequest({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: {
      ...context,
      itemId: "item_1",
      command: "echo harmless",
      cwd: "/tmp/project",
      reason: "test",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
    }
  });

  const keyboard = telegram.sent.at(-1).extra.reply_markup.inline_keyboard;
  const callbacks = keyboard.flat().map((button) => button.callback_data);
  assert.equal(callbacks.some((callback) => callback.includes("acceptForSession")), false);
  assert.deepEqual(callbacks.map((callback) => callback.split(":").at(-1)), ["accept", "decline", "cancel"]);

  await bridge.handleCallbackQuery({
    id: "cb_group",
    from: { id: 111 },
    data: callbacks[0],
    message: { chat: { id: -100, type: "group" }, message_id: 1, text: "approval" }
  });
  assert.deepEqual(app.decisions, []);
  assert.deepEqual(telegram.answered.at(-1), {
    callbackQueryId: "cb_group",
    text: "Use the bot in a private chat."
  });

  await bridge.handleCallbackQuery({
    id: "cb_1",
    from: { id: 111 },
    data: callbacks[0],
    message: { chat: { id: 111, type: "private" }, message_id: 1, text: "approval" }
  });
  assert.deepEqual(app.decisions, [{ id: 42, decision: "accept" }]);
  assert.deepEqual(telegram.answered.at(-1), { callbackQueryId: "cb_1", text: "Allowed" });
});

test("approval callbacks must come from the original Telegram message", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  const context = setActiveBridgeTurn(bridge);

  await bridge.handleAppServerRequest({
    id: 43,
    method: "item/commandExecution/requestApproval",
    params: {
      ...context,
      itemId: "item_2",
      command: "echo message-bound",
      availableDecisions: ["accept", "decline", "cancel"]
    }
  });
  const callback = telegram.sent.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;

  await bridge.handleCallbackQuery({
    id: "cb_wrong_message",
    from: { id: 111 },
    data: callback,
    message: { chat: { id: 111, type: "private" }, message_id: 999, text: "approval" }
  });

  assert.deepEqual(app.decisions, [{ id: 43, decision: "cancel" }]);
  assert.deepEqual(telegram.answered.at(-1), { callbackQueryId: "cb_wrong_message", text: "Approval expired." });
});

test("approval callbacks expire by age", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  const context = setActiveBridgeTurn(bridge);

  await bridge.handleAppServerRequest({
    id: 44,
    method: "item/commandExecution/requestApproval",
    params: {
      ...context,
      itemId: "item_3",
      command: "echo too-late",
      availableDecisions: ["accept", "decline", "cancel"]
    }
  });
  const sent = telegram.sent.at(-1);
  const callback = sent.extra.reply_markup.inline_keyboard[0][0].callback_data;
  const approval = [...bridge.pendingApprovals.values()][0];
  approval.createdAt = Date.now() - APPROVAL_TTL_MS - MAX_CLOCK_SKEW_MS;

  await bridge.handleCallbackQuery({
    id: "cb_expired",
    from: { id: 111 },
    data: callback,
    message: { chat: { id: 111, type: "private" }, message_id: sent.message_id, text: "approval" }
  });

  assert.deepEqual(app.decisions, [{ id: 44, decision: "cancel" }]);
  assert.deepEqual(telegram.answered.at(-1), { callbackQueryId: "cb_expired", text: "Approval expired." });
});

test("pending approvals are canceled when starting a new thread", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  bridge.threadId = "thr_old";
  bridge.activeTurnId = "turn_old";
  bridge.turnActive = true;

  await bridge.handleAppServerRequest({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "item_1",
      threadId: "thr_old",
      turnId: "turn_old",
      command: "echo old-context",
      availableDecisions: ["accept", "decline", "cancel"]
    }
  });
  const callback = telegram.sent.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;

  await bridge.handleMessage({
    chat: { id: 111, type: "private" },
    from: { id: 111 },
    text: "/new"
  });
  assert.deepEqual(app.decisions, [{ id: 42, decision: "cancel" }]);

  await bridge.handleCallbackQuery({
    id: "cb_old",
    from: { id: 111 },
    data: callback,
    message: { chat: { id: 111, type: "private" }, message_id: 1, text: "old approval" }
  });
  assert.deepEqual(app.decisions, [{ id: 42, decision: "cancel" }]);
  assert.deepEqual(telegram.answered.at(-1), { callbackQueryId: "cb_old", text: "Approval expired." });
});

test("pending approvals are canceled when stop interrupt fails", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  app.interruptTurn = async () => {
    throw new Error("interrupt failed");
  };
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  bridge.threadId = "thr_old";
  bridge.activeTurnId = "turn_old";
  bridge.turnActive = true;

  await bridge.handleAppServerRequest({
    id: 44,
    method: "item/fileChange/requestApproval",
    params: {
      itemId: "item_3",
      threadId: "thr_old",
      turnId: "turn_old",
      grantRoot: "/tmp/project",
      availableDecisions: ["accept", "decline", "cancel"]
    }
  });

  await assert.rejects(
    () =>
      bridge.handleMessage({
        chat: { id: 111, type: "private" },
        from: { id: 111 },
        text: "/stop"
      }),
    /interrupt failed/
  );
  assert.deepEqual(app.decisions, [{ id: 44, decision: "cancel" }]);
});

test("pending approvals are canceled on app-server thread change notifications", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await store.writeState({
    ...(await store.readState()),
    allowlistTelegramUserIds: ["111"]
  });
  const telegram = new FakeTelegram();
  const app = new FakeApp();
  const bridge = new TelegramBridge({ telegram, app, store, cwd: "/tmp/project" });
  bridge.activeChatId = 111;
  bridge.threadId = "thr_old";
  bridge.activeTurnId = "turn_old";
  bridge.turnActive = true;

  await bridge.handleAppServerRequest({
    id: 45,
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "item_4",
      threadId: "thr_old",
      turnId: "turn_old",
      command: "echo notification-change",
      availableDecisions: ["accept", "decline", "cancel"]
    }
  });

  await bridge.handleAppNotification({
    method: "thread/started",
    params: { thread: { id: "thr_new" } }
  });

  assert.deepEqual(app.decisions, [{ id: 45, decision: "cancel" }]);
  assert.equal(bridge.threadId, "thr_new");
  assert.equal(bridge.turnActive, false);
});

test("startup security rejects open state permissions but allows safe unpaired state", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
    CODEX_BIN: process.execPath
  };

  const safeResults = await assertStartupSecurity({ stateDir, env });
  assert.equal(safeResults.some((result) => result.status === "fail"), false);

  await fs.chmod(stateDir, 0o777);
  await fs.chmod(path.join(stateDir, "config.json"), 0o666);
  await fs.chmod(path.join(stateDir, "state.json"), 0o666);
  await fs.chmod(path.join(stateDir, "audit.jsonl"), 0o666);

  await assert.rejects(
    () => assertStartupSecurity({ stateDir, env }),
    /Refusing to start Codex Telegram Bridge because security checks failed/
  );
});

test("startup preparation checks created state before app-server launch", async () => {
  const stateDir = path.join(await tempStateDir(), "missing-state");
  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
    CODEX_BIN: process.execPath
  };

  await prepareStartupStateSecurity({ stateDir, env });
  assert.equal((await fs.stat(stateDir)).isDirectory(), true);

  const unsafeStateDir = path.join(await tempStateDir(), "created-unsafe");
  const unsafeStore = {
    async ensure() {
      await fs.mkdir(unsafeStateDir, { recursive: true });
      await fs.writeFile(path.join(unsafeStateDir, "config.json"), "{}\n", { mode: 0o600 });
      await fs.writeFile(path.join(unsafeStateDir, "state.json"), "{}\n", { mode: 0o600 });
      await fs.writeFile(path.join(unsafeStateDir, "audit.jsonl"), "", { mode: 0o600 });
      await fs.chmod(unsafeStateDir, 0o777);
    }
  };

  await assert.rejects(
    () => prepareStartupStateSecurity({ stateDir: unsafeStateDir, env, store: unsafeStore }),
    /Refusing to start Codex Telegram Bridge because security checks failed/
  );
});

test("startup preparation refuses unsafe existing state before repair", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  await fs.chmod(stateDir, 0o777);
  let ensureCalled = false;
  const shouldNotRepairStore = {
    async ensure() {
      ensureCalled = true;
    }
  };
  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
    CODEX_BIN: process.execPath
  };

  await assert.rejects(
    () => prepareStartupStateSecurity({ stateDir, env, store: shouldNotRepairStore }),
    /Refusing to start Codex Telegram Bridge because security checks failed/
  );
  assert.equal(ensureCalled, false);
});

test("startup security rejects malformed persisted Telegram update offsets", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  const statePath = path.join(stateDir, "state.json");
  await fs.writeFile(
    statePath,
    `${JSON.stringify({
      ...(await store.readState()),
      telegramUpdateOffset: "not-a-number"
    })}\n`,
    { mode: 0o600 }
  );

  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
    CODEX_BIN: process.execPath
  };
  await assert.rejects(
    () => assertStartupSecurity({ stateDir, env }),
    /telegramUpdateOffset must be a non-negative safe integer/
  );
});

test("startup security rejects invalid pending pair codes", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  const statePath = path.join(stateDir, "state.json");
  await fs.writeFile(
    statePath,
    `${JSON.stringify({
      ...(await store.readState()),
      pendingPairCodes: {
        123456: {
          telegramUserId: "111",
          requestedAt: new Date(Date.now() + PAIR_CODE_TTL_MS + MAX_CLOCK_SKEW_MS).toISOString()
        }
      }
    })}\n`,
    { mode: 0o600 }
  );

  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
    CODEX_BIN: process.execPath
  };
  await assert.rejects(
    () => assertStartupSecurity({ stateDir, env }),
    /Pending pair codes contain invalid/
  );
});

test("state store and startup security reject symlinked state files", async () => {
  const stateDir = await tempStateDir();
  const store = new StateStore(stateDir);
  await store.ensure();
  const auditPath = path.join(stateDir, "audit.jsonl");
  const targetPath = path.join(stateDir, "target.log");
  await fs.writeFile(targetPath, "", { mode: 0o600 });
  await fs.rm(auditPath);
  await fs.symlink(targetPath, auditPath);

  await assert.rejects(() => store.appendAudit("probe"), /Unsafe state file is a symbolic link/);

  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
    CODEX_BIN: process.execPath
  };
  await assert.rejects(
    () => assertStartupSecurity({ stateDir, env }),
    /Refusing to start Codex Telegram Bridge because security checks failed/
  );
});

test("redaction covers common token patterns and chunking stays under Telegram limits", () => {
  const input = [
    `TELEGRAM_BOT_TOKEN=${FAKE_TELEGRAM_TOKEN}`,
    `OPENAI_API_KEY=${FAKE_OPENAI_KEY}`,
    FAKE_GITHUB_PAT,
    FAKE_STRIPE_KEY,
    FAKE_PRIVATE_KEY
  ].join("\n");
  const redacted = redactSecrets(input);

  assert.doesNotMatch(redacted, /123456789:/);
  assert.doesNotMatch(redacted, /sk-proj-/);
  assert.doesNotMatch(redacted, /github_pat_/);
  assert.doesNotMatch(redacted, /sk_live_/);
  assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY/);

  const chunks = chunkTelegramText(`${"x".repeat(5000)}\n${input}`, 1000);
  assert.equal(chunks.every((chunk) => chunk.length <= 1000), true);
  assert.equal(chunks.some((chunk) => /sk-proj-/.test(chunk)), false);

  const preview = renderTelegramFinalPreview(`${"x".repeat(700)}\n${input}`, { limit: 600 });
  assert.equal(preview.truncated, true);
  assert.match(preview.text, /Output shortened for Telegram/);
  assert.doesNotMatch(preview.text, /sk-proj-|github_pat_|123456789:/);
});
