const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ============ КОНСТАНТЫ ============
const NIGHT_1_TIMER = 90;     // договорка мафии
const NIGHT_ACTIONS_TIMER = 45; // ночные действия (стрельба, проверки)
const DAY_SPEECH = 90;         // речь
const VOTE_TIMER = 30;         // голосование (не критично, Судья сам жмёт)
const MAX_SPEECH_LEN = 700;
const MAFIA_MAX_LEN = 400;
const FOULS_TO_SILENCE = 3;
const FOULS_TO_DQ = 4;
const PLAYER_COUNT = 10;

// ============ РОЛИ ============
const ROLES = {
  mafia:    { name: 'МАФИЯ',  emoji: '🔪', team: 'black', desc: 'Ты — член чёрной команды. Ночью выбирай жертву.' },
  don:      { name: 'ДОН',    emoji: '👑', team: 'black', desc: 'Ты — Дон. Ночью ищешь Шерифа, назначаешь отстрел.' },
  sheriff:  { name: 'ШЕРИФ',  emoji: '🔍', team: 'red',   desc: 'Ты — Шериф. Ночью проверяешь игроков.' },
  civilian: { name: 'МИРНЫЙ', emoji: '👤', team: 'red',   desc: 'Ты — мирный житель. Днём вычисляешь мафию.' },
  judge:    { name: 'СУДЬЯ',  emoji: '⚖',  team: 'judge', desc: 'Ты — Судья. Ведёшь игру.' },
};

const rooms = {};

function genCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pushLog(room, msg, type = '') {
  room.log.push({ t: Date.now(), msg, type });
  if (room.log.length > 300) room.log.shift();
}

// ============ ПУБЛИЧНОЕ СОСТОЯНИЕ ============
function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    night: room.night,
    day: room.day,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      isJudge: p.isJudge,
      isBot: !!p.isBot,
      connected: p.connected,
      hasNominated: !!room.nominatedToday[p.id],
      fouls: room.fouls[p.id] || 0,
      silenced: !!room.silenced[p.id],
      disqualified: !!room.disqualified[p.id],
    })),
    currentSpeakerId: room.currentSpeakerId,
    speechesOrder: room.speechesOrder,
    candidates: room.candidates,
    votes: room.votes,
    nightVictimId: room.nightVictimId,
    lastNightVictimId: room.lastNightVictimId,
    speeches: room.speeches,
    log: room.log.slice(-60),
    winner: room.winner,
    winMessage: room.winMessage,
    finalRoles: room.finalRoles || null,
    mafiaShots: room.night === 0 ? {} : (room.mafiaShots[room.night] || {}),
    nightDeadline: room.nightDeadline || null,
    phaseDeadline: room.phaseDeadline || null,
    phaseDuration: room.phaseDuration || 0,
  };
}

function broadcast(room) {
  room.players.forEach(p => {
    if (!p.socketId) return;
    const isBlack = p.role && ROLES[p.role].team === 'black';
    const payload = {
      ...publicState(room),
      me: {
        id: p.id,
        name: p.name,
        isJudge: p.isJudge,
        role: p.isJudge ? ROLES.judge : (p.role ? ROLES[p.role] : null),
        alive: p.alive,
        fouls: room.fouls[p.id] || 0,
        silenced: !!room.silenced[p.id],
        disqualified: !!room.disqualified[p.id],
        // Свой результат проверки этой ночи (для Шерифа)
        myCheck: (room.sheriffChecks && room.sheriffChecks[room.night] && room.sheriffChecks[room.night][p.id]) || null,
      },
    };
    if (p.isJudge) {
      payload.judgeInfo = {
        realRoles: room.players.filter(x => !x.isJudge).map(x => ({
          id: x.id, name: x.name, role: x.role,
        })),
        mafiaShotsThisNight: room.mafiaShots[room.night] || {},
        nightKillComputed: room.nightKillComputed,
        sheriffChecks: room.sheriffChecks[room.night] || {},
        donChecks: room.donChecks[room.night] || {},
      };
    }
    io.to(p.socketId).emit('state', payload);

    if (isBlack && !p.isJudge) {
      const mafiaMsgs = room.mafiaMessages.filter(m => m.night === room.night);
      io.to(p.socketId).emit('mafiaData', {
        messages: mafiaMsgs,
        donPlan: room.donPlan,
        myShot: (room.mafiaShots[room.night] || {})[p.id] ?? null,
        myDonCheck: (room.donChecks[room.night] || {})[p.id] ?? null,
      });
    }
  });
}

// ============ ИГРОКИ ============
function addPlayer(room, { name, socketId, isJudge }) {
  const id = room.players.length;
  const p = {
    id, name: name || `Игрок ${id + 1}`,
    socketId, isJudge: !!isJudge,
    isBot: false,
    role: null, alive: true, connected: true,
  };
  room.players.push(p);
  return p;
}

function startGame(room) {
  const judge = room.players.find(p => p.isJudge);
  const players = room.players.filter(p => !p.isJudge);
  if (!judge) return { ok: false, error: 'Нет Судьи' };
  if (players.length !== PLAYER_COUNT) return { ok: false, error: `Нужно ровно ${PLAYER_COUNT} игроков (без Судьи), сейчас ${players.length}` };

  const roles = ['don', 'mafia', 'mafia', 'sheriff',
                 'civilian', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian'];
  shuffle(roles);

  players.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
  });

  room.phase = 'night';
  room.night = 1;
  room.day = 0;
  room.fouls = {};
  room.silenced = {};
  room.disqualified = {};
  room.mafiaMessages = [];
  room.donPlan = '';
  room.noEliminationNights = 0;
  room.firstDayEliminations = 0;
  room.speeches = [];
  room.candidates = [];
  room.votes = {};
  room.votesCast = {};
  room.nominatedToday = {};
  room.speechesOrder = [];
  room.currentSpeakerId = null;
  room.mafiaShots = {};
  room.sheriffChecks = {};   // { night: { sheriffId: { targetId, isBlack, t } } }
  room.donChecks = {};       // { night: { donId: { targetId, isSheriff, t } } }
  room.nightKillComputed = null;
  room.nightVictimId = null;
  room.lastNightVictimId = null;
  room.nightTimerHandle = null;
  room.phaseDeadline = null;
  room.phaseDuration = 0;

  // Запускаем первую ночь
  startNight(room, 1);

  pushLog(room, '🎲 Роли разданы.', 'night');
  return { ok: true };
}

// ============ СОКЕТЫ ============
io.on('connection', (socket) => {
  console.log('connect:', socket.id);

  socket.on('createRoom', ({ name, isJudge }) => {
    const code = genCode();
    rooms[code] = {
      code,
      hostSocketId: socket.id,
      players: [],
      phase: 'lobby',
      night: 0, day: 0,
      currentSpeakerId: null,
      speechesOrder: [],
      candidates: [],
      votes: {},
      votesCast: {},
      nominatedToday: {},
      speeches: [],
      fouls: {},
      silenced: {},
      disqualified: {},
      log: [],
      winner: null,
      winMessage: '',
      finalRoles: null,
      mafiaMessages: [],
      donPlan: '',
      mafiaShots: {},
      sheriffChecks: {},
      donChecks: {},
      nightKillComputed: null,
      nightVictimId: null,
      lastNightVictimId: null,
      nightDeadline: null,
      phaseDeadline: null,
      phaseDuration: 0,
      nightTimerHandle: null,
      noEliminationNights: 0,
      firstDayEliminations: 0,
    };
    const player = addPlayer(rooms[code], { name, socketId: socket.id, isJudge: !!isJudge });
    socket.join(code);
    socket.emit('roomJoined', { code, playerId: player.id, isJudge: player.isJudge });
    pushLog(rooms[code], `${name} создал комнату ${code} (${isJudge ? 'Судья' : 'игрок'})`, 'day');
    broadcast(rooms[code]);
  });

  socket.on('joinRoom', ({ code, name }) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('errorMsg', 'Комната не найдена');
    if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Игра уже началась');
    if (room.players.length >= 11) return socket.emit('errorMsg', 'Комната переполнена');

    const player = addPlayer(room, { name, socketId: socket.id, isJudge: false });
    socket.join(code);
    socket.emit('roomJoined', { code, playerId: player.id, isJudge: false });
    pushLog(room, `${name} присоединился`, 'day');
    broadcast(room);
  });

  socket.on('reconnectPlayer', ({ code, playerId }) => {
    const room = rooms[code];
    if (!room) { socket.emit('sessionExpired'); return; }
    const p = room.players.find(x => x.id === playerId);
    if (!p) { socket.emit('sessionExpired'); return; }

    if (p.socketId && p.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(p.socketId);
      if (oldSocket) oldSocket.disconnect(true);
    }
    p.socketId = socket.id;
    p.connected = true;
    socket.join(code);
    socket.emit('roomJoined', { code, playerId, isJudge: p.isJudge });
    if (p.role) {
      io.to(socket.id).emit('yourRole', {
        role: p.isJudge ? ROLES.judge : ROLES[p.role],
        playerId: p.id,
      });
    }
    pushLog(room, `${p.name} переподключился`, 'day');
    broadcast(room);
  });

  // ========== БОТЫ ==========
  socket.on('addBot', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (!isJudge(socket, room)) return socket.emit('errorMsg', 'Только Судья');
    if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Игра уже началась');
    if (room.players.filter(p => !p.isJudge).length >= PLAYER_COUNT) return socket.emit('errorMsg', 'Комната заполнена');

    const botCount = room.players.filter(p => p.isBot).length;
    const bot = {
      id: room.players.length,
      name: `Бот ${botCount + 1}`,
      socketId: null,
      isJudge: false,
      isBot: true,
      role: null,
      alive: true,
      connected: true,
    };
    room.players.push(bot);
    pushLog(room, `🤖 ${bot.name} добавлен`, 'day');
    broadcast(room);
  });

  socket.on('removeBots', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (!isJudge(socket, room)) return socket.emit('errorMsg', 'Только Судья');
    if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Игра уже началась');
    room.players = room.players.filter(p => !p.isBot);
    room.players.forEach((p, i) => p.id = i);
    pushLog(room, `🤖 Все боты удалены`, 'day');
    broadcast(room);
  });

  socket.on('botAutoVote', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'vote') return;
    const bots = room.players.filter(p => p.isBot && p.alive);
    bots.forEach(bot => {
      const target = room.candidates.find(cid => cid !== bot.id);
      if (target !== undefined) {
        Object.keys(room.votesCast).forEach(vid => {
          if (room.votesCast[vid] === bot.id) {
            const arr = room.votes[vid] || [];
            const i = arr.indexOf(bot.id);
            if (i >= 0) arr.splice(i, 1);
          }
        });
        room.votesCast[target] = bot.id;
        if (!room.votes[target]) room.votes[target] = [];
        if (!room.votes[target].includes(bot.id)) room.votes[target].push(bot.id);
      }
    });
    broadcast(room);
  });

  socket.on('botPass', ({ code, playerId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    if (!isJudge(socket, room)) return;
    const p = room.players.find(x => x.id === playerId);
    if (!p || !p.isBot) return;
    if (room.currentSpeakerId !== p.id) return;
    const already = room.speeches.some(s => s.playerId === p.id && s.day === room.day);
    if (already) return;

    room.speeches.push({
      playerId: p.id, day: room.day, text: '',
      pas: true, shout: false, t: Date.now(),
    });
    pushLog(room, `💬 №${p.id + 1} (бот): ПАС`, 'speech');
    advanceSpeaker(room);
  });

  // ========== СТАРТ ==========
  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.phase !== 'lobby') return;
    const res = startGame(room);
    if (!res.ok) return socket.emit('errorMsg', res.error);

    room.players.forEach(p => {
      if (p.socketId) {
        io.to(p.socketId).emit('yourRole', {
          role: p.isJudge ? ROLES.judge : ROLES[p.role],
          playerId: p.id,
        });
      }
    });
    broadcast(room);
  });

  socket.on('endFirstNight', ({ code }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room)) return;
    if (room.nightTimerHandle) { clearTimeout(room.nightTimerHandle); room.nightTimerHandle = null; }
    room.nightDeadline = null;
    room.phaseDeadline = null;
    startDay(room, 1);
  });

  // ========== НОЧНЫЕ ДЕЙСТВИЯ ==========
  // Мафия стреляет
  socket.on('mafiaShoot', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'night') return;
    if (room.night === 1) return socket.emit('errorMsg', 'В первую ночь стрелять нельзя');
    const p = getPlayerBySocket(socket, room);
    if (!p || !p.alive) return;
    if (!p.role || ROLES[p.role].team !== 'black') return;

    if (!room.mafiaShots[room.night]) room.mafiaShots[room.night] = {};
    if (targetId === null) {
      delete room.mafiaShots[room.night][p.id];
    } else {
      room.mafiaShots[room.night][p.id] = targetId;
      const shotName = room.players.find(x => x.id === targetId)?.name;
      pushLog(room, `🔫 №${p.id + 1} (${ROLES[p.role].name}) стреляет в №${targetId + 1} (${shotName})`, 'kill');
    }

    computeNightKill(room);
    broadcast(room);
  });

  // Дон проверяет — ищет Шерифа
  socket.on('donCheck', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'night') return;
    if (room.night === 1) return socket.emit('errorMsg', 'В первую ночь проверять нельзя');
    const p = getPlayerBySocket(socket, room);
    if (!p || !p.alive) return;
    if (p.role !== 'don') return socket.emit('errorMsg', 'Только Дон может проверять');

    if (!room.donChecks[room.night]) room.donChecks[room.night] = {};
    if (room.donChecks[room.night][p.id]) return socket.emit('errorMsg', 'Вы уже проверяли в эту ночь');

    const target = room.players.find(x => x.id === targetId);
    if (!target || !target.alive) return;

    const isSheriff = target.role === 'sheriff';
    room.donChecks[room.night][p.id] = {
      targetId, isSheriff, t: Date.now(),
    };
    pushLog(room, `👑 Дон проверил №${targetId + 1}`, 'check');
    broadcast(room);
  });

  // Шериф проверяет
  socket.on('sheriffCheck', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'night') return;
    if (room.night === 1) return socket.emit('errorMsg', 'В первую ночь проверять нельзя');
    const p = getPlayerBySocket(socket, room);
    if (!p || !p.alive) return;
    if (p.role !== 'sheriff') return socket.emit('errorMsg', 'Только Шериф может проверять');

    if (!room.sheriffChecks[room.night]) room.sheriffChecks[room.night] = {};
    if (room.sheriffChecks[room.night][p.id]) return socket.emit('errorMsg', 'Вы уже проверяли в эту ночь');

    const target = room.players.find(x => x.id === targetId);
    if (!target || !target.alive) return;

    const isBlack = ROLES[target.role] && ROLES[target.role].team === 'black';
    room.sheriffChecks[room.night][p.id] = {
      targetId, isBlack, t: Date.now(),
    };
    pushLog(room, `🔍 Шериф проверил №${targetId + 1}`, 'check');
    broadcast(room);
  });

  socket.on('resetMafiaShots', ({ code }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room)) return;
    if (room.mafiaShots[room.night]) delete room.mafiaShots[room.night];
    room.nightKillComputed = null;
    pushLog(room, `↩ Судья сбросил выстрелы этой ночи`, 'night');
    broadcast(room);
  });

  // Судья завершает ночь
  socket.on('submitNight', ({ code }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room)) return;

    const victimId = room.nightKillComputed;
    room.nightVictimId = victimId;
    room.lastNightVictimId = victimId;

    if (victimId !== null && victimId !== undefined) {
      const v = room.players.find(p => p.id === victimId);
      if (v) v.alive = false;
      pushLog(room, `🌙 Ночь ${room.night}: убит игрок №${victimId + 1}`, 'kill');
    } else {
      pushLog(room, `🌙 Ночь ${room.night}: промах`, 'night');
      room.noEliminationNights++;
    }
    if (victimId !== null && victimId !== undefined) room.noEliminationNights = 0;

    if (checkWin(room)) return;
    if (room.noEliminationNights >= 3) {
      endGame(room, 'draw', 'Три ночи без жертв — ничья.');
      return;
    }
    startDay(room, room.night + 1);
  });

  // ========== ДЕНЬ: РЕЧИ ==========
  socket.on('submitSpeech', ({ code, text }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    const p = getPlayerBySocket(socket, room);
    if (!p || !p.alive) return;
    if (room.currentSpeakerId !== p.id) return socket.emit('errorMsg', 'Сейчас не ваша минута');
    if (room.silenced[p.id]) return socket.emit('errorMsg', 'Вы лишены права слова');

    const trimmed = (text || '').trim().slice(0, MAX_SPEECH_LEN);
    if (!trimmed) return socket.emit('errorMsg', 'Пустой текст');

    room.speeches.push({
      playerId: p.id, day: room.day, text: trimmed,
      pas: false, shout: false, t: Date.now(),
    });
    pushLog(room, `💬 №${p.id + 1}: ${trimmed}`, 'speech');
    broadcast(room);
  });

  socket.on('endSpeech', ({ code, pas }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    const p = getPlayerBySocket(socket, room);
    if (!p || !p.alive) return;
    if (room.currentSpeakerId !== p.id) return socket.emit('errorMsg', 'Сейчас не ваша минута');

    if (pas) {
      const alreadyPas = room.speeches.some(s => s.playerId === p.id && s.day === room.day && s.pas);
      if (!alreadyPas) {
        room.speeches.push({
          playerId: p.id, day: room.day, text: '',
          pas: true, shout: false, t: Date.now(),
        });
        pushLog(room, `💬 №${p.id + 1}: ПАС`, 'speech');
      }
    }
    advanceSpeaker(room);
  });

  socket.on('passSpeech', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    const p = getPlayerBySocket(socket, room);
    if (!p || !p.alive) return;
    if (room.currentSpeakerId !== p.id) return;
    const alreadyPas = room.speeches.some(s => s.playerId === p.id && s.day === room.day && s.pas);
    if (!alreadyPas) {
      room.speeches.push({
        playerId: p.id, day: room.day, text: '',
        pas: true, shout: false, t: Date.now(),
      });
      pushLog(room, `💬 №${p.id + 1}: ПАС`, 'speech');
    }
    advanceSpeaker(room);
  });

  socket.on('shout', ({ code, text }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    const p = getPlayerBySocket(socket, room);
    if (!p || !p.alive) return;
    if (room.currentSpeakerId === p.id) return socket.emit('errorMsg', 'Вы сейчас говорите');
    const trimmed = (text || '').trim().slice(0, 200);
    if (!trimmed) return;

    room.speeches.push({
      playerId: p.id, day: room.day, text: trimmed,
      pas: false, shout: true, t: Date.now(),
    });
    pushLog(room, `⚠ №${p.id + 1} выкрикнул вне минуты: "${trimmed}"`, 'foul');
    addFoul(room, p.id);
    broadcast(room);
  });

  socket.on('nominate', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    const p = getPlayerBySocket(socket, room);
    if (!p || !p.alive) return;
    if (room.currentSpeakerId !== p.id) return socket.emit('errorMsg', 'Не ваша минута');
    if (room.nominatedToday[p.id]) return socket.emit('errorMsg', 'Вы уже выставляли');
    const t = room.players.find(x => x.id === targetId);
    if (!t || !t.alive) return;
    if (room.candidates.includes(targetId)) return;

    room.nominatedToday[p.id] = true;
    room.candidates.push(targetId);
    pushLog(room, `📢 №${p.id + 1} выставляет №${targetId + 1}`, 'day');
    broadcast(room);
  });

  socket.on('vote', ({ code, candidateId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'vote') return;
    const p = getPlayerBySocket(socket, room);
    if (!p || !p.alive) return;

    Object.keys(room.votesCast).forEach(vid => {
      if (room.votesCast[vid] === p.id) {
        const arr = room.votes[vid] || [];
        const i = arr.indexOf(p.id);
        if (i >= 0) arr.splice(i, 1);
      }
    });

    room.votesCast[candidateId] = p.id;
    if (!room.votes[candidateId]) room.votes[candidateId] = [];
    if (!room.votes[candidateId].includes(p.id)) room.votes[candidateId].push(p.id);
    broadcast(room);
  });

  socket.on('nextSpeaker', ({ code }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room)) return;
    advanceSpeaker(room);
  });

  socket.on('startVoting', ({ code }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room) || room.phase !== 'day') return;
    if (room.candidates.length === 0) {
      pushLog(room, `☀️ День ${room.day}: никого не выставили — сразу ночь`, 'day');
      startNight(room, room.day + 1);
      return;
    }
    if (room.day === 1 && room.candidates.length === 1) {
      pushLog(room, `☀️ День 1: одна кандидатура — голосование не проводится`, 'day');
      startNight(room, room.day + 1);
      return;
    }
    room.phase = 'vote';
    room.votes = {};
    room.votesCast = {};
    room.candidates.forEach(id => room.votes[id] = []);
    room.phaseDeadline = Date.now() + VOTE_TIMER * 1000;
    room.phaseDuration = VOTE_TIMER;
    broadcast(room);
  });

  socket.on('tallyVotes', ({ code }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room) || room.phase !== 'vote') return;
    tallyVotes(room);
  });

  socket.on('skipVote', ({ code }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room)) return;
    pushLog(room, 'Никто не выбыл', 'vote');
    startNight(room, room.day + 1);
  });

  socket.on('revote', ({ code, candidateIds }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room)) return;
    room.candidates = candidateIds;
    room.votes = {};
    room.votesCast = {};
    candidateIds.forEach(id => room.votes[id] = []);
    room.phase = 'vote';
    broadcast(room);
  });

  socket.on('addFoul', ({ code, playerId }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room)) return;
    addFoul(room, playerId);
    broadcast(room);
  });

  socket.on('removeFoul', ({ code, playerId }) => {
    const room = rooms[code];
    if (!room || !isJudge(socket, room)) return;
    removeFoul(room, playerId);
    broadcast(room);
  });

  socket.on('saveDonPlan', ({ code, text }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'night') return;
    const p = getPlayerBySocket(socket, room);
    if (!p || p.role !== 'don') return;
    const trimmed = (text || '').trim().slice(0, MAFIA_MAX_LEN);
    if (!trimmed) return;
    room.donPlan = trimmed;
    room.mafiaMessages.push({
      playerId: p.id, text: trimmed, night: room.night,
      t: Date.now(), isPlan: true,
    });
    broadcast(room);
  });

  socket.on('mafiaMessage', ({ code, text }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'night') return;
    const p = getPlayerBySocket(socket, room);
    if (!p || ROLES[p.role].team !== 'black') return;
    const trimmed = (text || '').trim().slice(0, MAFIA_MAX_LEN);
    if (!trimmed) return;
    room.mafiaMessages.push({
      playerId: p.id, text: trimmed, night: room.night,
      t: Date.now(), isPlan: false,
    });
    broadcast(room);
  });

  socket.on('heartbeat', () => {});

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const p = room.players.find(x => x.socketId === socket.id);
      if (p) {
        p.connected = false;
        pushLog(room, `⚠ ${p.name} отключился`, 'warn');
        broadcast(room);
      }
    }
  });
});

// ============ ЛОГИКА ============
function isJudge(socket, room) {
  const p = room.players.find(x => x.socketId === socket.id);
  return p && p.isJudge;
}

function getPlayerBySocket(socket, room) {
  return room.players.find(x => x.socketId === socket.id);
}

function advanceSpeaker(room) {
  const idx = room.speechesOrder.indexOf(room.currentSpeakerId);
  if (idx < room.speechesOrder.length - 1) {
    room.currentSpeakerId = room.speechesOrder[idx + 1];
    room.phaseDeadline = Date.now() + DAY_SPEECH * 1000;
    room.phaseDuration = DAY_SPEECH;
  } else {
    room.currentSpeakerId = null;
    room.phaseDeadline = null;
  }
  broadcast(room);
}

// Автоматические действия ботов ночью
function botNightActions(room) {
  if (room.phase !== 'night' || room.night === 1) return;

  const bots = room.players.filter(p => p.isBot && p.alive);

  // Боты-мафия стреляют в случайного мирного (если ещё не стреляли)
  const botMafia = bots.filter(p => p.role && ROLES[p.role].team === 'black');
  if (!room.mafiaShots[room.night]) room.mafiaShots[room.night] = {};
  botMafia.forEach(bot => {
    if (room.mafiaShots[room.night][bot.id] === undefined) {
      const targets = room.players.filter(p => p.alive && !p.isJudge && p.id !== bot.id && (!p.role || ROLES[p.role].team !== 'black'));
      if (targets.length > 0) {
        const t = targets[Math.floor(Math.random() * targets.length)];
        room.mafiaShots[room.night][bot.id] = t.id;
      }
    }
  });

  // Бот-Дон проверяет случайного игрока
  const botDon = bots.find(p => p.role === 'don');
  if (botDon) {
    if (!room.donChecks[room.night]) room.donChecks[room.night] = {};
    if (!room.donChecks[room.night][botDon.id]) {
      const targets = room.players.filter(p => p.alive && !p.isJudge && p.id !== botDon.id);
      if (targets.length > 0) {
        const t = targets[Math.floor(Math.random() * targets.length)];
        room.donChecks[room.night][botDon.id] = {
          targetId: t.id,
          isSheriff: t.role === 'sheriff',
          t: Date.now(),
        };
      }
    }
  }

  // Бот-Шериф проверяет случайного игрока
  const botSheriff = bots.find(p => p.role === 'sheriff');
  if (botSheriff) {
    if (!room.sheriffChecks[room.night]) room.sheriffChecks[room.night] = {};
    if (!room.sheriffChecks[room.night][botSheriff.id]) {
      const targets = room.players.filter(p => p.alive && !p.isJudge && p.id !== botSheriff.id);
      if (targets.length > 0) {
        const t = targets[Math.floor(Math.random() * targets.length)];
        room.sheriffChecks[room.night][botSheriff.id] = {
          targetId: t.id,
          isBlack: ROLES[t.role] && ROLES[t.role].team === 'black',
          t: Date.now(),
        };
      }
    }
  }

  computeNightKill(room);
}

function computeNightKill(room) {
  const blackAlive = room.players.filter(x => x.alive && x.role && ROLES[x.role].team === 'black');
  const shotsThisNight = room.mafiaShots[room.night] || {};
  const allShot = blackAlive.length === 0 || blackAlive.every(x => shotsThisNight[x.id] !== undefined);

  if (allShot && blackAlive.length > 0) {
    const targets = blackAlive.map(x => shotsThisNight[x.id]);
    const allSame = targets.every(t => t === targets[0]);
    room.nightKillComputed = allSame ? targets[0] : null;
  } else {
    room.nightKillComputed = null;
  }
}

function startNight(room, n) {
  room.phase = 'night';
  room.night = n;
  room.nightKillComputed = null;
  room.nightVictimId = null;
  room.mafiaShots[n] = {};
  room.sheriffChecks[n] = {};
  room.donChecks[n] = {};
  room.nightDonCheck = null;
  room.nightSheriffCheck = null;

  if (n === 1) {
    room.phaseDuration = NIGHT_1_TIMER;
    room.phaseDeadline = Date.now() + NIGHT_1_TIMER * 1000;
    room.nightDeadline = room.phaseDeadline;
    pushLog(room, `🌙 Ночь 1 — договорка мафии. ${NIGHT_1_TIMER} сек.`, 'night');

    if (room.nightTimerHandle) clearTimeout(room.nightTimerHandle);
    room.nightTimerHandle = setTimeout(() => {
      if (room.phase === 'night' && room.night === 1) {
        pushLog(room, `⏰ Время договорки истекло — день 1`, 'night');
        room.nightDeadline = null;
        room.phaseDeadline = null;
        startDay(room, 1);
      }
    }, NIGHT_1_TIMER * 1000);
  } else {
    room.phaseDuration = NIGHT_ACTIONS_TIMER;
    room.phaseDeadline = Date.now() + NIGHT_ACTIONS_TIMER * 1000;
    room.nightDeadline = null;
    pushLog(room, `🌙 Ночь ${n}. Ночные действия — ${NIGHT_ACTIONS_TIMER} сек.`, 'night');

    // Боты выполняют свои ночные действия
    botNightActions(room);

    // Таймер на ночные действия
    if (room.nightTimerHandle) clearTimeout(room.nightTimerHandle);
    room.nightTimerHandle = setTimeout(() => {
      if (room.phase === 'night' && room.night === n) {
        pushLog(room, `⏰ Время ночи истекло — обрабатываем результат`, 'night');
        room.phaseDeadline = null;
        // Применяем результат ночи
        applyNightResult(room);
      }
    }, NIGHT_ACTIONS_TIMER * 1000);
  }

  broadcast(room);
}

function applyNightResult(room) {
  const victimId = room.nightKillComputed;
  room.nightVictimId = victimId;
  room.lastNightVictimId = victimId;

  if (victimId !== null && victimId !== undefined) {
    const v = room.players.find(p => p.id === victimId);
    if (v) v.alive = false;
    pushLog(room, `🌙 Ночь ${room.night}: убит игрок №${victimId + 1}`, 'kill');
  } else {
    pushLog(room, `🌙 Ночь ${room.night}: промах`, 'night');
    room.noEliminationNights++;
  }
  if (victimId !== null && victimId !== undefined) room.noEliminationNights = 0;

  if (checkWin(room)) return;
  if (room.noEliminationNights >= 3) {
    endGame(room, 'draw', 'Три ночи без жертв — ничья.');
    return;
  }
  startDay(room, room.night + 1);
}

function startDay(room, d) {
  room.phase = 'day';
  room.day = d;
  room.nightDeadline = null;
  if (room.nightTimerHandle) { clearTimeout(room.nightTimerHandle); room.nightTimerHandle = null; }

  room.candidates = [];
  room.votes = {};
  room.votesCast = {};
  room.nominatedToday = {};

  const alive = room.players.filter(p => p.alive && !p.isJudge && !room.disqualified[p.id]).map(p => p.id);
  if (d === 1) {
    const startIdx = alive.indexOf(0);
    room.speechesOrder = startIdx >= 0
      ? [...alive.slice(startIdx), ...alive.slice(0, startIdx)]
      : alive;
  } else {
    const shift = (d - 1) % alive.length;
    room.speechesOrder = [...alive.slice(shift), ...alive.slice(0, shift)];
  }
  room.currentSpeakerId = room.speechesOrder[0] ?? null;
  if (room.currentSpeakerId !== null) {
    room.phaseDuration = DAY_SPEECH;
    room.phaseDeadline = Date.now() + DAY_SPEECH * 1000;
  } else {
    room.phaseDeadline = null;
  }

  pushLog(room, `☀️ День ${d}`, 'day');
  broadcast(room);
}

function addFoul(room, playerId) {
  room.fouls[playerId] = (room.fouls[playerId] || 0) + 1;
  const f = room.fouls[playerId];
  pushLog(room, `⚠ №${playerId + 1} — фол #${f}`, 'foul');

  if (f === FOULS_TO_SILENCE) {
    room.silenced[playerId] = true;
    pushLog(room, `🤐 №${playerId + 1} лишён права слова`, 'foul');
  }
  if (f >= FOULS_TO_DQ) {
    room.disqualified[playerId] = true;
    const p = room.players.find(x => x.id === playerId);
    if (p) p.alive = false;
    pushLog(room, `❌ №${playerId + 1} дисквалифицирован`, 'dq');
    checkWin(room);
  }
}

function removeFoul(room, playerId) {
  if (!room.fouls[playerId]) return;
  room.fouls[playerId]--;
  if (room.fouls[playerId] < FOULS_TO_SILENCE) room.silenced[playerId] = false;
  if (room.fouls[playerId] < FOULS_TO_DQ) room.disqualified[playerId] = false;
  pushLog(room, `↩ Фол снят с №${playerId + 1} (${room.fouls[playerId]})`, 'foul');
}

function tallyVotes(room) {
  const counts = room.candidates.map(id => ({
    id, count: (room.votes[id] || []).length,
  })).sort((a, b) => b.count - a.count);

  const max = counts[0].count;
  const top = counts.filter(c => c.count === max);

  if (top.length === 1) {
    const id = top[0].id;
    const p = room.players.find(x => x.id === id);
    if (p) p.alive = false;
    pushLog(room, `🗳 Голосование: №${id + 1} покидает игру`, 'vote');
    if (room.day === 1) room.firstDayEliminations++;
    if (checkWin(room)) return;
    startNight(room, room.day + 1);
    return;
  }

  pushLog(room, `⚖ Ничья: ${top.map(t => '№' + (t.id + 1)).join(', ')}. 30 сек.`, 'vote');
  room.phase = 'revote_speech';
  room.tieCandidates = top.map(t => t.id);
  broadcast(room);
}

function checkWin(room) {
  const alive = room.players.filter(p => p.alive && !p.isJudge);
  const black = alive.filter(p => ROLES[p.role] && ROLES[p.role].team === 'black').length;
  const red = alive.filter(p => ROLES[p.role] && ROLES[p.role].team === 'red').length;

  if (black === 0) { endGame(room, 'red', 'Все чёрные выведены. Победа красных! 🏆'); return true; }
  if (black >= red) { endGame(room, 'black', 'Чёрных не меньше, чем красных. Победа мафии! 🔪'); return true; }
  return false;
}

function endGame(room, winner, msg) {
  room.phase = 'end';
  room.winner = winner;
  room.winMessage = msg;
  if (room.nightTimerHandle) { clearTimeout(room.nightTimerHandle); room.nightTimerHandle = null; }
  room.phaseDeadline = null;
  room.finalRoles = room.players.filter(p => !p.isJudge).map(p => ({
    id: p.id, name: p.name,
    role: ROLES[p.role] || ROLES.civilian,
    alive: p.alive,
    fouls: room.fouls[p.id] || 0,
  }));
  pushLog(room, `🏁 Игра окончена: ${msg}`, 'end');
  broadcast(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎭 Mafia server запущен: http://localhost:${PORT}\n`);
});