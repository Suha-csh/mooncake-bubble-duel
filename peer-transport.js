(() => {
  "use strict";

  const ROUND_MS = 60_000;
  const STALE_MS = 9_000;
  const ROOM_VERSION = 8;

  function freshRoom() {
    return {
      version: ROOM_VERSION,
      phase: "lobby",
      players: [null, null],
      presence: {},
      startedAt: null,
      roundId: null,
      seed: 0,
      scores: [0, 0],
      snapshots: [null, null],
      frozen: [false, false],
      winner: null,
      loser: null,
      endReason: null,
      revision: 0,
      updatedAt: Date.now()
    };
  }

  function cleanRoom(state) {
    const now = Date.now();
    state.presence ||= {};
    state.frozen = Array.isArray(state.frozen) ? [Boolean(state.frozen[0]), Boolean(state.frozen[1])] : [false, false];
    for (const [id, presence] of Object.entries(state.presence)) {
      if (!presence || now - Number(presence.lastSeen || 0) > STALE_MS) delete state.presence[id];
    }
    if (state.phase === "lobby" || state.phase === "finished") {
      state.players = state.players.map((player) => player && state.presence[player.id] ? player : null);
    }
    return state;
  }

  function safeSnapshot(value, roundId) {
    if (!value || value.roundId !== roundId || !Array.isArray(value.balls) || value.balls.length > 260) return null;
    return {
      roundId,
      score: Math.max(0, Math.min(99999, Number(value.score) || 0)),
      shiftedRows: Math.max(0, Math.min(5, Number(value.shiftedRows) || 0)),
      balls: value.balls.map((ball) => ({
        row: Math.max(0, Math.min(16, Number(ball.row) || 0)),
        col: Math.max(0, Math.min(16, Number(ball.col) || 0)),
        type: Math.max(0, Math.min(5, Number(ball.type) || 0))
      })),
      queue: Array.isArray(value.queue)
        ? value.queue.slice(0, 4).map((type) => Math.max(0, Math.min(5, Number(type) || 0)))
        : [0, 1, 2, 3],
      shot: value.shot && typeof value.shot === "object" ? {
        x: Number(value.shot.x) || 0,
        y: Number(value.shot.y) || 0,
        vx: Number(value.shot.vx) || 0,
        vy: Number(value.shot.vy) || 0,
        type: Math.max(0, Math.min(5, Number(value.shot.type) || 0))
      } : null,
      aim: Number(value.aim) || -Math.PI / 2,
      frozen: Boolean(value.frozen),
      sequence: Math.max(0, Math.floor(Number(value.sequence) || 0)),
      updatedAt: Math.max(0, Math.min(Date.now(), Number(value.updatedAt) || 0))
    };
  }

  function finishByScore(state, reason) {
    state.phase = "finished";
    state.scores = [
      state.snapshots?.[0]?.score ?? state.scores[0] ?? 0,
      state.snapshots?.[1]?.score ?? state.scores[1] ?? 0
    ];
    state.winner = state.scores[0] === state.scores[1] ? -1 : (state.scores[0] > state.scores[1] ? 0 : 1);
    state.loser = null;
    state.endReason = reason;
  }

  function isNewerSnapshot(next, previous) {
    if (!previous) return true;
    if (next.updatedAt !== previous.updatedAt) return next.updatedAt > previous.updatedAt;
    return next.sequence > (previous.sequence || 0);
  }

  function applyAction(state, body) {
    const now = Date.now();
    const clientId = String(body.clientId || "").slice(0, 80);
    if (!clientId) return state;
    state = cleanRoom(state);
    const action = String(body.action || "");

    if (action !== "leave") state.presence[clientId] = { lastSeen: now };

    if (action === "ready") {
      let existing = state.players.findIndex((player) => player?.id === clientId);
      if (state.phase === "playing") return state;
      if (state.phase === "finished") {
        state.phase = "lobby";
        state.startedAt = null;
        state.winner = null;
        state.loser = null;
        state.endReason = null;
        state.scores = [0, 0];
        state.snapshots = [null, null];
        state.frozen = [false, false];
        state.players = state.players.map((player) => player ? { ...player, ready: false } : null);
        existing = state.players.findIndex((player) => player?.id === clientId);
      }
      if (existing >= 0) {
        state.players[existing].ready = !state.players[existing].ready;
      } else {
        const open = state.players.findIndex((player) => !player);
        if (open >= 0) {
          const prefix = open === 0 ? "玄月" : "皎月";
          state.players[open] = {
            id: clientId,
            name: `${prefix}选手 · ${clientId.slice(-4).toUpperCase()}`,
            ready: true,
            joinedAt: now
          };
        }
      }
      if (state.players.every((player) => player?.ready)) {
        state.phase = "playing";
        state.startedAt = now + 900;
        state.roundId = `${now.toString(36)}-${crypto.randomUUID().slice(0, 5)}`;
        state.seed = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
        state.scores = [0, 0];
        state.snapshots = [null, null];
        state.frozen = [false, false];
        state.winner = null;
        state.loser = null;
        state.endReason = null;
      }
    } else if (action === "snapshot" && state.phase === "playing") {
      const slot = state.players.findIndex((player) => player?.id === clientId);
      const snapshot = safeSnapshot(body.snapshot, state.roundId);
      if (slot >= 0 && snapshot && !state.frozen[slot] && isNewerSnapshot(snapshot, state.snapshots[slot])) {
        state.snapshots[slot] = snapshot;
        state.scores[slot] = snapshot.score;
      }
    } else if (action === "freeze" && state.phase === "playing") {
      const slot = state.players.findIndex((player) => player?.id === clientId);
      const snapshot = safeSnapshot(body.snapshot, state.roundId);
      if (slot >= 0 && snapshot && !state.frozen[slot] && now >= Number(state.startedAt || now)) {
        if (isNewerSnapshot(snapshot, state.snapshots[slot])) {
          state.snapshots[slot] = snapshot;
          state.scores[slot] = snapshot.score;
        }
        state.frozen[slot] = true;
        if (state.frozen.every(Boolean)) finishByScore(state, "both-crossed");
      }
    } else if (action === "finish" && state.phase === "playing") {
      if (now - Number(state.startedAt || now) >= ROUND_MS - 250) {
        finishByScore(state, "time");
      }
    } else if (action === "leave") {
      delete state.presence[clientId];
      if (state.phase !== "playing") {
        state.players = state.players.map((player) => player?.id === clientId ? null : player);
      }
    }

    state.updatedAt = now;
    return state;
  }

  class MoonPeerTransport {
    constructor({ roomCode, clientId, onState, onStatus }) {
      this.roomCode = roomCode;
      this.clientId = clientId;
      this.onState = onState;
      this.onStatus = onStatus;
      this.hostId = `moon-rabbit-v8-${roomCode.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
      this.latest = freshRoom();
      this.hostState = this.latest;
      this.peer = null;
      this.connection = null;
      this.connections = new Set();
      this.pending = new Map();
      this.isHost = false;
      this.connected = false;
      this.generation = 0;
      this.reconnectTimer = 0;
    }

    start() {
      if (!window.Peer) {
        this.onStatus?.("error", "联机组件加载失败，请刷新页面重试");
        return;
      }
      this.electHost();
    }

    options() {
      return { host: "0.peerjs.com", port: 443, path: "/", secure: true, debug: 0, pingInterval: 5000 };
    }

    electHost() {
      clearTimeout(this.reconnectTimer);
      const generation = ++this.generation;
      this.closeCurrent();
      this.onStatus?.("connecting", "正在连接联机房间…");
      const peer = new Peer(this.hostId, this.options());
      this.peer = peer;
      let opened = false;
      let becomingGuest = false;
      peer.on("connection", (connection) => this.acceptConnection(connection));

      peer.on("open", () => {
        if (generation !== this.generation) return;
        opened = true;
        this.isHost = true;
        this.connected = true;
        this.hostState = cleanRoom(structuredClone(this.latest));
        this.latest = this.hostState;
        this.emitState();
        this.onStatus?.("connected", "联机房间已连接");
      });

      peer.on("error", (error) => {
        if (generation !== this.generation) return;
        if (!opened && error?.type === "unavailable-id") {
          becomingGuest = true;
          try { peer.destroy(); } catch (_) {}
          this.joinHost(generation);
          return;
        }
        this.scheduleReconnect();
      });

      peer.on("disconnected", () => {
        if (!becomingGuest && generation === this.generation) this.scheduleReconnect();
      });
    }

    joinHost(generation) {
      const peer = new Peer(undefined, this.options());
      this.peer = peer;
      this.isHost = false;

      peer.on("open", () => {
        if (generation !== this.generation) return;
        const connection = peer.connect(this.hostId, {
          reliable: true,
          metadata: { clientId: this.clientId }
        });
        this.connection = connection;

        connection.on("open", () => {
          if (generation !== this.generation) return;
          this.connected = true;
          this.onStatus?.("connected", "联机房间已连接");
          connection.send({ kind: "sync" });
        });
        connection.on("data", (message) => this.receive(message));
        connection.on("close", () => {
          if (generation === this.generation) this.scheduleReconnect();
        });
        connection.on("error", () => {
          if (generation === this.generation) this.scheduleReconnect();
        });
      });

      peer.on("error", () => {
        if (generation === this.generation) this.scheduleReconnect();
      });
      peer.on("disconnected", () => {
        if (generation === this.generation) this.scheduleReconnect();
      });
    }

    acceptConnection(connection) {
      this.connections.add(connection);
      connection.on("open", () => connection.send({ kind: "state", state: this.hostState }));
      connection.on("data", (message) => {
        if (message?.kind === "sync") {
          connection.send({ kind: "state", state: this.hostState });
          return;
        }
        if (message?.kind !== "action" || !message.body || typeof message.body !== "object") return;
        this.applyHostAction(message.body, connection, message.requestId);
      });
      const remove = () => this.connections.delete(connection);
      connection.on("close", remove);
      connection.on("error", remove);
    }

    applyHostAction(body, origin = null, requestId = null) {
      const previousRevision = Number(this.hostState.revision || 0);
      this.hostState = applyAction(structuredClone(this.hostState), body);
      this.hostState.revision = previousRevision + 1;
      this.latest = this.hostState;
      this.emitState();
      for (const connection of this.connections) {
        if (!connection.open) continue;
        connection.send({
          kind: "state",
          state: this.hostState,
          requestId: connection === origin ? requestId : null
        });
      }
      return this.hostState;
    }

    receive(message) {
      if (message?.kind !== "state" || message.state?.version !== ROOM_VERSION) return;
      if (Number(message.state.revision || 0) >= Number(this.latest.revision || 0)) {
        this.latest = message.state;
        this.emitState();
      }
      if (message.requestId && this.pending.has(message.requestId)) {
        const pending = this.pending.get(message.requestId);
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.resolve(this.latest);
      }
    }

    emitState() {
      this.onState?.(this.latest);
    }

    action(action, payload = {}, options = {}) {
      const body = { action, clientId: this.clientId, ...payload };
      if (this.isHost && this.connected) return Promise.resolve(this.applyHostAction(body));
      if (!this.connection?.open) return Promise.resolve(null);

      const requestId = `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
      this.connection.send({ kind: "action", body, requestId });
      if (options.immediate) return Promise.resolve(this.latest);

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          resolve(null);
        }, 2500);
        this.pending.set(requestId, { resolve, timer });
      });
    }

    current() {
      return this.connected ? this.latest : null;
    }

    scheduleReconnect() {
      if (this.reconnectTimer) return;
      this.connected = false;
      this.onStatus?.("connecting", "联机中断，正在自动重连…");
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = 0;
        this.electHost();
      }, 700 + Math.random() * 900);
    }

    closeCurrent() {
      this.connected = false;
      this.isHost = false;
      for (const connection of this.connections) {
        try { connection.close(); } catch (_) {}
      }
      this.connections.clear();
      try { this.connection?.close(); } catch (_) {}
      try { this.peer?.destroy(); } catch (_) {}
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
      this.pending.clear();
      this.connection = null;
      this.peer = null;
    }
  }

  window.MoonPeerTransport = MoonPeerTransport;
})();
