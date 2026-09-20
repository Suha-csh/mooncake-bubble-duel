(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const roomCode = (params.get("room") || "MOON-082").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24) || "MOON-082";
  const tabKey = params.get("tab") || "root";
  const clientStorageKey = `moon-rabbit-client-${tabKey}`;
  const ROUND_SECONDS = 60;
  const STALE_MS = 9000;
  const INITIAL_ROWS = 5;
  const BALL_SIZE = 38;
  const COLORS = ["#e7aa45", "#d96757", "#789b4f", "#8a5598", "#ef9d32", "#70402d"];
  const sprite = new Image();
  sprite.src = "./assets/mooncake-rabbits.png?v=air1";
  const clientId = sessionStorage.getItem(clientStorageKey) || `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  sessionStorage.setItem(clientStorageKey, clientId);

  const el = (id) => document.getElementById(id);
  const ui = {
    timer: el("timer"), clockProgress: el("clockProgress"), phaseLabel: el("phaseLabel"),
    roomHint: el("roomHint"), viewerCount: el("viewerCount"), readyButton: el("readyButton"),
    opponentButton: el("opponentButton"), roleLabel: el("roleLabel"), roleAvatar: el("roleAvatar"),
    dockMessage: el("dockMessage"), toast: el("toast"), soundButton: el("soundButton"),
    helpDialog: el("helpDialog"), helpButton: el("helpButton"), closeHelp: el("closeHelp"), confirmHelp: el("confirmHelp")
  };
  el("roomCode").textContent = roomCode;

  let room = makeRoom();
  let currentRole = -1;
  let soundOn = true;
  let lastPublished = 0;
  let finishRequested = false;
  let lastFrame = performance.now();
  let toastTimer = 0;
  let audioContext = null;
  let roomTransport = null;

  function makeRoom() {
    return {
      version: 5,
      phase: "lobby",
      players: [null, null],
      presence: {},
      startedAt: null,
      roundId: null,
      seed: 0,
      scores: [0, 0],
      snapshots: [null, null],
      winner: null,
      loser: null,
      endReason: null,
      revision: 0,
      updatedAt: Date.now()
    };
  }

  async function serverAction(action, payload = {}, options = {}) {
    try {
      const next = await roomTransport?.action(action, payload, { immediate: options.keepalive === true });
      if (next?.version === 5 && next.revision >= room.revision) {
        room = next;
        renderRoom();
      }
      return next;
    } catch (_) {
      if (!options.silent) announce("房间连接暂时不稳定，正在自动重试");
      return null;
    }
  }

  async function refreshRoom() {
    try {
      const next = roomTransport?.current();
      if (next?.version === 5 && next.revision >= room.revision) {
        room = next;
        renderRoom();
      }
    } catch (_) {}
  }

  function announce(message) {
    clearTimeout(toastTimer);
    ui.toast.textContent = message;
    ui.toast.classList.add("show");
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 2200);
  }

  function sound(kind) {
    if (!soundOn) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const frequencies = { shoot: 260, bounce: 190, pop: 540, start: 720, end: 160 };
      osc.type = kind === "pop" ? "sine" : "triangle";
      osc.frequency.setValueAtTime(frequencies[kind] || 300, audioContext.currentTime);
      if (kind === "pop") osc.frequency.exponentialRampToValueAtTime(850, audioContext.currentTime + .08);
      gain.gain.setValueAtTime(.055, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .12);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(); osc.stop(audioContext.currentTime + .13);
    } catch (_) {}
  }

  function hashSeed(seed, slot) {
    let h = (seed ^ ((slot + 1) * 0x9e3779b9)) >>> 0;
    return () => {
      h += 0x6D2B79F5;
      let t = h;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  class MoonBoard {
    constructor(canvas, slot) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.slot = slot;
      this.radius = 18;
      this.pitch = 40;
      this.rowHeight = 33;
      this.top = 23;
      this.fitCanvas();
      this.shooter = { x: this.canvas.width / 2, y: this.canvas.height - 50 };
      this.aim = -Math.PI / 2;
      this.balls = [];
      this.queue = [0, 1, 2, 3];
      this.shot = null;
      this.particles = [];
      this.score = 0;
      this.shiftedRows = 0;
      this.overflowed = false;
      this.roundId = null;
      this.rng = Math.random;
      this.canvas.addEventListener("pointermove", (event) => this.point(event, false));
      this.canvas.addEventListener("pointerdown", (event) => this.point(event, true));
      window.addEventListener("resize", () => this.fitCanvas());
      this.reset(82 + slot, "preview");
    }

    fitCanvas() {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nextHeight = Math.max(360, Math.min(640, Math.round(this.canvas.width * rect.height / rect.width)));
      if (this.canvas.height !== nextHeight) this.canvas.height = nextHeight;
      if (this.shooter) {
        this.shooter.x = this.canvas.width / 2;
        this.shooter.y = this.canvas.height - 50;
      }
    }

    reset(seed, roundId) {
      this.rng = hashSeed(seed, this.slot);
      this.roundId = roundId;
      this.balls = [];
      for (let row = 0; row < INITIAL_ROWS; row++) {
        const count = this.cols(row);
        for (let col = 0; col < count; col++) {
          if (row === INITIAL_ROWS - 1 && this.rng() < .18) continue;
          this.balls.push({ row, col, type: this.nextType() });
        }
      }
      this.queue = [this.nextType(), this.nextType(), this.nextType(), this.nextType()];
      this.shot = null;
      this.particles = [];
      this.score = 0;
      this.shiftedRows = 0;
      this.overflowed = false;
      this.aim = -Math.PI / 2;
    }

    nextType() { return Math.floor(this.rng() * 6); }
    cols(row) { return row % 2 ? 13 : 14; }
    coord(row, col) { return { x: 39 + col * this.pitch + (row % 2 ? 20 : 0), y: this.top + row * this.rowHeight }; }
    key(row, col) { return `${row}:${col}`; }

    point(event, shouldShoot) {
      if (currentRole !== this.slot || room.phase !== "playing" || Date.now() < room.startedAt) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) * this.canvas.width / rect.width;
      const y = (event.clientY - rect.top) * this.canvas.height / rect.height;
      let angle = Math.atan2(y - this.shooter.y, x - this.shooter.x);
      angle = Math.max(-Math.PI + .18, Math.min(-.18, angle));
      this.aim = angle;
      if (shouldShoot) {
        event.preventDefault();
        this.fire();
      }
    }

    fire() {
      if (this.shot) return;
      const speed = 520;
      this.shot = {
        x: this.shooter.x, y: this.shooter.y - 23,
        vx: Math.cos(this.aim) * speed, vy: Math.sin(this.aim) * speed,
        type: this.queue.shift()
      };
      this.queue.push(this.nextType());
      sound("shoot");
    }

    update(dt, elapsed) {
      const expectedShifts = Math.floor(elapsed / 10);
      while (this.shiftedRows < expectedShifts && this.shiftedRows < 5) {
        this.addRow();
        this.shiftedRows++;
      }

      if (this.shot) {
        const shot = this.shot;
        shot.x += shot.vx * dt;
        shot.y += shot.vy * dt;
        if (shot.x < this.radius) { shot.x = this.radius; shot.vx = Math.abs(shot.vx); sound("bounce"); }
        if (shot.x > this.canvas.width - this.radius) { shot.x = this.canvas.width - this.radius; shot.vx = -Math.abs(shot.vx); sound("bounce"); }
        let landed = shot.y <= this.top;
        if (!landed) {
          for (const ball of this.balls) {
            const p = this.coord(ball.row, ball.col);
            if ((shot.x - p.x) ** 2 + (shot.y - p.y) ** 2 <= (this.radius * 1.88) ** 2) { landed = true; break; }
          }
        }
        if (landed) this.landShot();
      }

      this.particles.forEach((particle) => {
        particle.y += particle.vy * dt;
        particle.vy += 450 * dt;
        particle.rotation += particle.spin * dt;
        particle.alpha -= dt * .8;
      });
      this.particles = this.particles.filter((particle) => particle.alpha > 0 && particle.y < this.canvas.height + 120);
      if (!this.overflowed && this.isOverDangerLine()) {
        this.overflowed = true;
        return true;
      }
      return false;
    }

    dangerY() {
      const line = this.canvas.parentElement?.querySelector(".danger-line");
      const canvasRect = this.canvas.getBoundingClientRect();
      const lineRect = line?.getBoundingClientRect();
      if (!lineRect || !canvasRect.height) return this.canvas.height * .72;
      return (lineRect.top - canvasRect.top) * this.canvas.height / canvasRect.height;
    }

    isOverDangerLine() {
      const limit = this.dangerY();
      return this.balls.some((ball) => this.coord(ball.row, ball.col).y + this.radius >= limit);
    }

    addRow() {
      this.balls.forEach((ball) => { ball.row += 1; });
      for (let col = 0; col < this.cols(0); col++) this.balls.push({ row: 0, col, type: this.nextType() });
    }

    landShot() {
      const shot = this.shot;
      const occupied = new Set(this.balls.map((ball) => this.key(ball.row, ball.col)));
      let best = null;
      for (let row = 0; row < 10; row++) {
        for (let col = 0; col < this.cols(row); col++) {
          if (occupied.has(this.key(row, col))) continue;
          const p = this.coord(row, col);
          const d = (shot.x - p.x) ** 2 + (shot.y - p.y) ** 2;
          if (!best || d < best.d) best = { row, col, d };
        }
      }
      if (!best) { this.shot = null; return; }
      const landed = { row: best.row, col: best.col, type: shot.type };
      this.balls.push(landed);
      this.shot = null;
      const matched = this.connected(landed, (ball) => ball.type === landed.type);
      if (matched.length >= 3) {
        this.dropBalls(matched);
        const anchored = this.anchoredKeys();
        const floating = this.balls.filter((ball) => !anchored.has(this.key(ball.row, ball.col)));
        if (floating.length) this.dropBalls(floating);
        sound("pop");
      }
    }

    neighbors(ball) {
      const even = ball.row % 2 === 0;
      const deltas = even
        ? [[-1,0],[1,0],[-1,-1],[0,-1],[-1,1],[0,1]]
        : [[-1,0],[1,0],[0,-1],[1,-1],[0,1],[1,1]];
      const map = new Map(this.balls.map((item) => [this.key(item.row, item.col), item]));
      return deltas.map(([dc, dr]) => map.get(this.key(ball.row + dr, ball.col + dc))).filter(Boolean);
    }

    connected(start, predicate) {
      const found = [];
      const queue = [start];
      const seen = new Set([this.key(start.row, start.col)]);
      while (queue.length) {
        const ball = queue.shift();
        if (!predicate(ball)) continue;
        found.push(ball);
        for (const neighbor of this.neighbors(ball)) {
          const key = this.key(neighbor.row, neighbor.col);
          if (!seen.has(key) && predicate(neighbor)) { seen.add(key); queue.push(neighbor); }
        }
      }
      return found;
    }

    anchoredKeys() {
      const topBalls = this.balls.filter((ball) => ball.row === 0);
      const anchored = new Set(topBalls.map((ball) => this.key(ball.row, ball.col)));
      const queue = [...topBalls];
      while (queue.length) {
        const ball = queue.shift();
        this.neighbors(ball).forEach((neighbor) => {
          const key = this.key(neighbor.row, neighbor.col);
          if (!anchored.has(key)) { anchored.add(key); queue.push(neighbor); }
        });
      }
      return anchored;
    }

    dropBalls(list) {
      const remove = new Set(list.map((ball) => this.key(ball.row, ball.col)));
      list.forEach((ball) => {
        const p = this.coord(ball.row, ball.col);
        this.particles.push({ x: p.x, y: p.y, type: ball.type, vy: 35 + this.rng() * 100, rotation: 0, spin: (this.rng() - .5) * 7, alpha: 1 });
      });
      this.balls = this.balls.filter((ball) => !remove.has(this.key(ball.row, ball.col)));
      this.score += list.length;
    }

    snapshot() {
      return {
        roundId: this.roundId, score: this.score, shiftedRows: this.shiftedRows,
        balls: this.balls.map((ball) => ({ row: ball.row, col: ball.col, type: ball.type })),
        queue: [...this.queue], shot: this.shot ? { ...this.shot } : null,
        aim: this.aim, overflowed: this.overflowed, updatedAt: Date.now()
      };
    }

    applySnapshot(snapshot) {
      if (!snapshot || snapshot.roundId !== room.roundId || this.slot === currentRole) return;
      this.roundId = snapshot.roundId;
      this.score = snapshot.score || 0;
      this.shiftedRows = snapshot.shiftedRows || 0;
      this.balls = snapshot.balls || [];
      this.queue = snapshot.queue || this.queue;
      this.shot = snapshot.shot || null;
      this.aim = snapshot.aim ?? this.aim;
      this.overflowed = Boolean(snapshot.overflowed);
    }

    drawSprite(type, x, y, size, rotation = 0, alpha = 1) {
      const ctx = this.ctx;
      const col = type < 4 ? type : type - 4;
      const row = type < 4 ? 0 : 1;
      const sw = sprite.naturalWidth / 4;
      const sh = sprite.naturalHeight / 2;
      ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.rotate(rotation);
      ctx.shadowColor = "rgba(0,0,0,.38)"; ctx.shadowBlur = size * .22; ctx.shadowOffsetY = size * .1;
      if (sprite.complete && sprite.naturalWidth) ctx.drawImage(sprite, col * sw, row * sh, sw, sh, -size / 2, -size / 2, size, size);
      else { ctx.fillStyle = COLORS[type]; ctx.beginPath(); ctx.arc(0,0,size*.43,0,Math.PI*2); ctx.fill(); }
      ctx.restore();
    }

    drawRabbit() {
      const ctx = this.ctx;
      if (!sprite.complete || !sprite.naturalWidth) return;
      const sw = sprite.naturalWidth / 4;
      const sh = sprite.naturalHeight / 2;
      const sx = (this.slot === 0 ? 2 : 3) * sw;
      ctx.save(); ctx.globalAlpha = .94;
      ctx.drawImage(sprite, sx, sh, sw, sh, 175, this.canvas.height - 94, 84, 84);
      ctx.restore();
    }

    draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.save();
      ctx.strokeStyle = "rgba(255,230,176,.06)"; ctx.lineWidth = 1;
      for (let x = 24; x < this.canvas.width; x += 44) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,this.canvas.height - 95); ctx.stroke(); }
      ctx.restore();

      this.balls.forEach((ball) => {
        const p = this.coord(ball.row, ball.col);
        this.drawSprite(ball.type, p.x, p.y, BALL_SIZE);
      });
      this.particles.forEach((particle) => this.drawSprite(particle.type, particle.x, particle.y, 36, particle.rotation, Math.max(0, particle.alpha)));
      if (this.shot) this.drawSprite(this.shot.type, this.shot.x, this.shot.y, BALL_SIZE);

      const sx = this.shooter.x, sy = this.shooter.y;
      const lineLength = 112;
      const ex = sx + Math.cos(this.aim) * lineLength;
      const ey = sy + Math.sin(this.aim) * lineLength;
      ctx.save();
      ctx.setLineDash([3, 9]); ctx.lineCap = "round"; ctx.strokeStyle = "rgba(255,231,176,.58)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx, sy - 20); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]); ctx.translate(sx, sy); ctx.rotate(this.aim + Math.PI / 2);
      const gradient = ctx.createLinearGradient(-8,-34,8,10); gradient.addColorStop(0,"#f2b84e"); gradient.addColorStop(1,"#713623");
      ctx.fillStyle = gradient; ctx.strokeStyle = "#ffdc8b"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(-9,-39,18,42,8); ctx.fill(); ctx.stroke(); ctx.restore();
      this.drawSprite(this.queue[0], sx, sy - 26, BALL_SIZE);
      this.drawRabbit();

      ctx.save(); ctx.fillStyle = "rgba(255,255,255,.05)"; ctx.strokeStyle = "rgba(255,220,150,.15)";
      const queueTop = this.canvas.height - 89;
      ctx.beginPath(); ctx.roundRect(380, queueTop, 210, 79, 17); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "rgba(255,225,170,.72)"; ctx.font = "600 10px system-ui"; ctx.fillText("随后登场", 394, queueTop + 17);
      [1,2,3].forEach((index) => this.drawSprite(this.queue[index], 427 + (index - 1) * 60, queueTop + 49, 35));
      ctx.restore();
    }
  }

  const games = [new MoonBoard(el("board0"), 0), new MoonBoard(el("board1"), 1)];

  async function readyAction() {
    const before = room.phase;
    const next = await serverAction("ready");
    if (!next) return null;
    const role = next.players.findIndex((player) => player?.id === clientId);
    if (role < 0 && next.players.every(Boolean)) announce("两个席位已满，已为你保留观战席");
    if (before !== "playing" && next.phase === "playing") sound("start");
    return next;
  }

  function renderRoom() {
    if (room.phase !== "playing") finishRequested = false;
    currentRole = room.players.findIndex((player) => player?.id === clientId);
    const activeIds = Object.keys(room.presence || {});
    const playerIds = room.players.filter(Boolean).map((player) => player.id);
    const viewers = activeIds.filter((id) => !playerIds.includes(id)).length;
    ui.viewerCount.textContent = String(viewers);

    room.players.forEach((player, slot) => {
      el(`playerName${slot}`).textContent = player?.name || "等待加入";
      const statusEl = el(`playerStatus${slot}`);
      const online = player && Boolean(room.presence?.[player.id]);
      statusEl.textContent = player ? (room.phase === "playing" ? (online ? "对战中" : "已离线") : (player.ready ? "已准备" : "未准备")) : "未准备";
      statusEl.parentElement.classList.toggle("ready", Boolean(player?.ready && (room.phase !== "playing" || online)));
      el(`score${slot}`).textContent = String(room.scores?.[slot] || 0);
      el(`playerPanel${slot}`).classList.toggle("is-local", currentRole === slot);
      const lock = el(`lock${slot}`);
      const showBoard = player && (room.phase === "playing" || room.phase === "finished");
      lock.classList.toggle("hidden", Boolean(showBoard));
      if (!showBoard) {
        lock.querySelector("strong").textContent = player ? (player.ready ? "已准备，等待对手" : "等待准备") : "等待选手";
        lock.querySelector("small").textContent = player ? "两位选手都准备后，倒计时自动开始" : "点击下方“加入并准备”占领席位";
      }
    });

    if (room.phase === "lobby") {
      ui.phaseLabel.textContent = "等待选手准备";
      ui.roomHint.textContent = "前两位点击准备的玩家进入比赛，其他人自动观战";
      ui.timer.textContent = "01:00"; ui.clockProgress.style.width = "100%";
    } else if (room.phase === "playing") {
      ui.phaseLabel.textContent = "擂台对战中";
      ui.roomHint.textContent = currentRole < 0 ? "观战模式 · 棋盘状态实时同步" : "瞄准棋盘并点击，连接三枚同口味月饼";
    } else {
      if (room.endReason === "overflow" && Number.isInteger(room.loser)) {
        ui.phaseLabel.textContent = `选手 ${room.loser + 1} 月饼越线`;
        ui.roomHint.textContent = `选手 ${room.winner + 1} 获胜 · 最终比分 ${room.scores[0]} : ${room.scores[1]}`;
        ui.timer.textContent = "结束";
      } else {
        const winnerText = room.winner === -1 ? "本局平局" : `选手 ${room.winner + 1} 获胜`;
        ui.phaseLabel.textContent = winnerText;
        ui.roomHint.textContent = `最终比分 ${room.scores[0]} : ${room.scores[1]}`;
        ui.timer.textContent = "00:00";
      }
      ui.clockProgress.style.width = "0%";
    }

    if (currentRole >= 0) {
      const player = room.players[currentRole];
      ui.roleLabel.textContent = `选手 ${currentRole + 1} · ${currentRole ? "白兔" : "黑兔"}`;
      ui.roleAvatar.textContent = "";
      ui.roleAvatar.style.backgroundImage = "url('./assets/mooncake-rabbits.png?v=air1')";
      ui.roleAvatar.style.backgroundSize = "400% 200%";
      ui.roleAvatar.style.backgroundPosition = currentRole ? "100% 100%" : "66.666% 100%";
      if (room.phase === "lobby") {
        ui.readyButton.disabled = false;
        ui.readyButton.classList.toggle("is-ready", Boolean(player.ready));
        ui.readyButton.querySelector("span").textContent = player.ready ? "取消准备" : "准备";
        ui.dockMessage.textContent = player.ready ? "已就位，等待另一位选手" : "准备后请等待另一位选手";
      } else if (room.phase === "playing") {
        ui.readyButton.disabled = true; ui.readyButton.classList.remove("is-ready");
        ui.readyButton.querySelector("span").textContent = "比赛进行中";
        ui.dockMessage.textContent = "移动指针瞄准，点击发射月饼";
      } else {
        ui.readyButton.disabled = false; ui.readyButton.classList.remove("is-ready");
        ui.readyButton.querySelector("span").textContent = "再来一局";
        ui.dockMessage.textContent = room.winner === currentRole ? "漂亮！你赢下了这一局" : room.winner === -1 ? "势均力敌，再战一局吧" : "差一点，再来一局";
      }
    } else {
      ui.roleLabel.textContent = room.players.every(Boolean) ? "观战席" : "尚未入场";
      ui.roleAvatar.textContent = "观"; ui.roleAvatar.style.backgroundImage = "none";
      const full = room.players.every(Boolean);
      ui.readyButton.disabled = full || room.phase === "playing";
      ui.readyButton.classList.remove("is-ready");
      ui.readyButton.querySelector("span").textContent = full ? "观战中" : "加入并准备";
      ui.dockMessage.textContent = full ? "两个比赛席位已满，你可以实时观看双方状态" : "先准备的两位玩家可以操作发射器";
    }

    games.forEach((game, slot) => {
      if (room.phase === "playing" && room.roundId && game.roundId !== room.roundId && currentRole === slot) game.reset(room.seed, room.roundId);
      if (slot !== currentRole) game.applySnapshot(room.snapshots?.[slot]);
    });
  }

  async function finishRound(loser = null) {
    if (room.phase !== "playing") return;
    const overflow = Number.isInteger(loser);
    const payload = overflow ? { snapshot: games[loser].snapshot() } : {};
    const next = await serverAction(overflow ? "overflow" : "finish", payload, { silent: true });
    if (next?.phase === "finished") {
      sound("end");
      if (overflow) announce("月饼越过警戒线，本局结束");
    }
  }

  function publishGame(now) {
    if (currentRole < 0 || room.phase !== "playing" || now - lastPublished < 220) return;
    lastPublished = now;
    const snapshot = games[currentRole].snapshot();
    serverAction("snapshot", { snapshot }, { silent: true });
  }

  function frame(now) {
    const dt = Math.min(.035, (now - lastFrame) / 1000);
    lastFrame = now;
    if (room.phase === "playing" && room.startedAt) {
      const elapsed = Math.max(0, (Date.now() - room.startedAt) / 1000);
      const left = Math.max(0, ROUND_SECONDS - elapsed);
      const shown = Math.ceil(left);
      ui.timer.textContent = `${Math.floor(shown / 60).toString().padStart(2,"0")}:${(shown % 60).toString().padStart(2,"0")}`;
      ui.clockProgress.style.width = `${left / ROUND_SECONDS * 100}%`;
      const untilShift = 10 - (Math.floor(elapsed) % 10);
      [0,1].forEach((slot) => el(`shift${slot}`).textContent = `${untilShift} 秒后月饼下移`);
      if (currentRole >= 0 && elapsed > 0 && left > 0) {
        const overflowed = games[currentRole].update(dt, elapsed);
        if (overflowed && !finishRequested) {
          finishRequested = true;
          finishRound(currentRole);
        }
      }
      publishGame(now);
      if (left <= 0 && !finishRequested) { finishRequested = true; finishRound(); }
    } else {
      [0,1].forEach((slot) => el(`shift${slot}`).textContent = "10 秒后月饼下移");
    }
    games.forEach((game) => game.draw());
    requestAnimationFrame(frame);
  }

  function heartbeat() {
    serverAction("heartbeat", {}, { silent: true });
  }

  ui.readyButton.addEventListener("click", readyAction);
  ui.opponentButton.addEventListener("click", () => {
    const url = new URL(location.href); url.searchParams.set("tab", crypto.getRandomValues(new Uint32Array(1))[0].toString(36));
    window.open(url, "_blank", "noopener");
    announce("已打开新窗口，请在那里点击加入并准备");
  });
  ui.helpButton.addEventListener("click", () => ui.helpDialog.showModal());
  ui.closeHelp.addEventListener("click", () => ui.helpDialog.close());
  ui.confirmHelp.addEventListener("click", () => ui.helpDialog.close());
  ui.soundButton.addEventListener("click", () => {
    soundOn = !soundOn; ui.soundButton.style.opacity = soundOn ? "1" : ".45";
    announce(soundOn ? "音效已开启" : "音效已关闭");
  });

  window.addEventListener("beforeunload", () => {
    try {
      roomTransport?.action("leave", {}, { immediate: true });
    } catch (_) {}
  });

  if (document.modelContext?.registerTool) {
    const tools = [
      {
        name: "get_match_state", title: "查看比赛状态", description: "读取当前房间阶段、双方得分、剩余时间和你的身份。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: () => ({ phase: room.phase, scores: room.scores, role: currentRole < 0 ? "spectator" : `player_${currentRole + 1}`, remainingSeconds: room.phase === "playing" ? Math.max(0, Math.ceil(ROUND_SECONDS - (Date.now() - room.startedAt) / 1000)) : null })
      },
      {
        name: "toggle_ready", title: "切换准备状态", description: "在有空余席位时加入比赛并切换自己的准备状态。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async () => { await readyAction(); return { phase: room.phase, role: currentRole < 0 ? "spectator" : `player_${currentRole + 1}`, ready: currentRole >= 0 ? room.players[currentRole]?.ready : false }; }
      }
    ];
    tools.forEach((tool) => { try { document.modelContext.registerTool(tool); } catch (_) {} });
  }

  roomTransport = new window.MoonPeerTransport({
    roomCode,
    clientId,
    onState(next) {
      if (next?.version === 5 && next.revision >= room.revision) {
        room = next;
        renderRoom();
      }
    },
    onStatus(status, message) {
      document.body.dataset.connection = status;
      if (status === "error") announce(message);
    }
  });
  roomTransport.start();
  refreshRoom().then(heartbeat);
  setInterval(refreshRoom, 650);
  setInterval(heartbeat, 2500);
  sprite.addEventListener("load", () => games.forEach((game) => game.draw()), { once: true });
  renderRoom();
  requestAnimationFrame(frame);
})();
