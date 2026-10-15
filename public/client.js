"use strict";

const socket = io();
let myId = null;
let myIsJudge = false;
let myRole = null;
let roomCode = null;
let latestState = null;
let mafiaData = { messages: [], donPlan: '', myShot: null, myDonCheck: null };
let activeChatTab = 'public';
let myShotThisNight = null;
let globalTimerInterval = null;

const $ = (id) => document.getElementById(id);

// ============ УТИЛИТЫ ============
function showError(msg) { $('lobbyError').textContent = msg; setTimeout(() => $('lobbyError').textContent = '', 4000); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function showToast(text, type = '') {
  const cont = $('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = text;
  cont.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 4000);
}

// ============ ЗВУК ============
let audioCtx = null;
function initAudio() {
  if (audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
}
function beep(freq = 880, duration = 0.15, type = 'sine', volume = 0.2) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type; osc.frequency.value = freq; gain.gain.value = volume;
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + duration);
}
function soundYourTurn() {
  beep(660, 0.12, 'square', 0.25);
  setTimeout(() => beep(880, 0.12, 'square', 0.25), 150);
  setTimeout(() => beep(1100, 0.20, 'square', 0.25), 300);
}
function soundNight() { beep(220, 0.4, 'sine', 0.2); setTimeout(() => beep(180, 0.5, 'sine', 0.2), 300); }
function soundVote() { beep(550, 0.15, 'triangle', 0.2); setTimeout(() => beep(550, 0.15, 'triangle', 0.2), 200); }
function soundFoul() { beep(150, 0.3, 'sawtooth', 0.25); }
function soundEnd() {
  beep(880, 0.2, 'square', 0.25);
  setTimeout(() => beep(660, 0.2, 'square', 0.25), 200);
  setTimeout(() => beep(440, 0.4, 'square', 0.25), 400);
}

let titleInterval = null;
const originalTitle = document.title;
function startTitleBlink(text) {
  stopTitleBlink();
  let on = true;
  titleInterval = setInterval(() => {
    document.title = on ? text : originalTitle;
    on = !on;
  }, 700);
}
function stopTitleBlink() {
  if (titleInterval) { clearInterval(titleInterval); titleInterval = null; document.title = originalTitle; }
}

// ============ ГЛОБАЛЬНЫЙ ТАЙМЕР ФАЗЫ ============
function updateGlobalTimer() {
  const el = document.getElementById('globalTimer');
  if (!el || !latestState) return;
  const dl = latestState.phaseDeadline;
  if (!dl) {
    el.style.display = 'none';
    return;
  }
  const left = Math.max(0, Math.round((dl - Date.now()) / 1000));
  el.style.display = 'flex';
  el.textContent = `⏱ ${left} сек`;
  el.classList.toggle('danger', left <= 10);
}

setInterval(updateGlobalTimer, 500);

// ============ ЛОББИ ============
function createRoom(isJudge) {
  initAudio();
  localStorage.removeItem('mafia_code');
  localStorage.removeItem('mafia_id');
  const name = $('nameInput').value.trim() || 'Игрок';
  socket.emit('createRoom', { name, isJudge });
}
function joinRoom() {
  initAudio();
  localStorage.removeItem('mafia_code');
  localStorage.removeItem('mafia_id');
  const name = $('nameInput').value.trim() || 'Игрок';
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return showError('Введите код');
  socket.emit('joinRoom', { code, name });
}
function addBot() { if (roomCode) socket.emit('addBot', { code: roomCode }); }
function removeBots() { if (roomCode) socket.emit('removeBots', { code: roomCode }); }
function botAutoVote() { if (roomCode) socket.emit('botAutoVote', { code: roomCode }); }

// ============ СОКЕТЫ ============
socket.on('roomJoined', ({ code, playerId, isJudge }) => {
  roomCode = code;
  myId = playerId;
  myIsJudge = isJudge;
  localStorage.setItem('mafia_code', code);
  localStorage.setItem('mafia_id', playerId);
  $('roomCode').textContent = code;
  $('lobbyScreen').classList.remove('active');
  $('roomScreen').classList.add('active');
});

socket.on('yourRole', ({ role, playerId }) => {
  myRole = role;
  const cls = role.team === 'black' ? (role.name === 'ДОН' ? 'don' : 'mafia')
            : role.team === 'red' ? (role.name === 'ШЕРИФ' ? 'sheriff' : 'civilian')
            : 'judge';
  $('myRoleModalContent').innerHTML = `
    <div class="role-big ${cls}">
      <div class="emoji">${role.emoji}</div>
      <div class="title">${role.name}</div>
      <div class="desc">${role.desc || ''}</div>
      <div style="margin-top:10px;font-size:0.7rem;color:#888;">
        Ты — игрок №${playerId + 1}.
      </div>
    </div>
  `;
  $('myRoleModal').classList.add('active');
});

socket.on('state', (s) => {
  latestState = s;
  render(s);
  updateGlobalTimer();
});

socket.on('mafiaData', (data) => {
  mafiaData = data;
  myShotThisNight = data.myShot;
  if (activeChatTab === 'mafia') renderMafiaChat();
});

socket.on('errorMsg', (msg) => { showToast('⚠ ' + msg, 'foul'); });

socket.on('sessionExpired', () => {
  localStorage.removeItem('mafia_code');
  localStorage.removeItem('mafia_id');
  roomCode = null;
  myId = null;
  $('roomScreen').classList.remove('active');
  $('gameScreen').classList.remove('active');
  $('lobbyScreen').classList.add('active');
});

setInterval(() => {
  if (roomCode) socket.emit('heartbeat', { code: roomCode });
}, 10000);

// ============ РЕНДЕР ============
function render(state) {
  if (state.phase === 'lobby') {
    $('lobbyScreen').classList.remove('active');
    $('roomScreen').classList.add('active');
    $('gameScreen').classList.remove('active');
    renderLobby(state);
  } else {
    $('lobbyScreen').classList.remove('active');
    $('roomScreen').classList.remove('active');
    $('gameScreen').classList.add('active');
    renderGame(state);
  }
}

function renderLobby(state) {
  $('playerCount').textContent = state.players.filter(p => !p.isJudge).length;
  const judge = state.players.find(p => p.isJudge);
  $('judgeStatus').textContent = judge ? `(✅ ${judge.name})` : '(нет)';

  const list = $('roomPlayers');
  list.innerHTML = '';
  state.players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'player-card' + (p.id === myId ? ' me' : '');
    let badge = '';
    if (p.isJudge) badge += '⚖ ';
    if (p.isBot) badge += '🤖 ';
    if (!p.connected && !p.isBot) badge += '🔴';
    else if (p.connected && !p.isBot && !p.isJudge) badge += '🟢';
    card.innerHTML = `
      <div class="num">№${p.id + 1}</div>
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="badge">${badge}</div>
    `;
    list.appendChild(card);
  });

  const controls = $('roomControls');
  controls.innerHTML = '';
  if (myIsJudge) {
    const playerCount = state.players.filter(p => !p.isJudge).length;
    const botCount = state.players.filter(p => p.isBot).length;

    const startBtn = document.createElement('button');
    startBtn.className = 'green';
    startBtn.textContent = playerCount === 10 ? '▶ НАЧАТЬ ИГРУ' : `Ждём игроков (${playerCount}/10)`;
    startBtn.disabled = playerCount !== 10;
    startBtn.onclick = () => socket.emit('startGame', { code: roomCode });
    controls.appendChild(startBtn);

    const addBotBtn = document.createElement('button');
    addBotBtn.className = 'blue';
    addBotBtn.textContent = `🤖 ДОБАВИТЬ БОТА`;
    addBotBtn.disabled = playerCount >= 10;
    addBotBtn.onclick = () => addBot();
    controls.appendChild(addBotBtn);

    if (botCount > 0) {
      const removeBotsBtn = document.createElement('button');
      removeBotsBtn.textContent = `🗑 УБРАТЬ БОТОВ (${botCount})`;
      removeBotsBtn.onclick = () => removeBots();
      controls.appendChild(removeBotsBtn);
    }
  } else {
    const hint = document.createElement('div');
    hint.className = 'info-box';
    hint.textContent = 'Ждём, пока Судья начнёт игру...';
    controls.appendChild(hint);
  }
}

function renderGame(state) {
  const me = state.me;
  const alive = me.alive;

  const phaseMap = {
    night: { text: `🌙 НОЧЬ ${state.night}`, cls: 'night' },
    day:   { text: `☀️ ДЕНЬ ${state.day}`, cls: 'day' },
    vote:  { text: '🗳 ГОЛОСОВАНИЕ', cls: 'vote' },
    revote_speech: { text: '⚖ ПЕРЕГОЛОСОВАНИЕ', cls: 'vote' },
    end:   { text: '🏁 КОНЕЦ', cls: 'end' },
  };
  const p = phaseMap[state.phase] || { text: '—', cls: 'day' };
  $('topPhase').textContent = p.text;
  $('topPhase').className = 'phase ' + p.cls;

  if (me.role) {
    const r = me.role;
    const cls = r.team === 'black' ? (r.name === 'ДОН' ? 'don' : 'mafia')
              : r.team === 'red' ? (r.name === 'ШЕРИФ' ? 'sheriff' : 'civilian')
              : 'judge';
    $('myRoleChip').className = 'my-role-chip ' + cls;
    $('myRoleChipText').textContent = `${r.emoji} ${r.name}`;
  }
  $('deadFlag').style.display = alive ? 'none' : 'inline';

  const f = me.fouls || 0;
  $('foulChip').textContent = `⚠ ${f} фолов`;
  $('foulChip').className = 'foul-chip' + (f >= 4 ? ' danger' : f >= 2 ? ' warn' : '');

  const isBlack = me.role && me.role.team === 'black';
  if (isBlack && state.phase === 'night') {
    $('tabMafia').style.display = 'block';
    $('tabMafia').classList.remove('locked');
  } else {
    $('tabMafia').style.display = 'none';
    if (activeChatTab === 'mafia') switchChatTab('public');
  }

  renderOnlinePanel(state);

  const content = $('gameContent');
  content.innerHTML = '';

  if (state.phase === 'end') {
    renderEnd(state, content);
  } else if (me.isJudge) {
    renderJudge(state, content);
  } else {
    renderPlayer(state, content);
  }

  const log = $('gameLog');
  log.innerHTML = state.log.map(l =>
    `<div class="${l.type}">${escapeHtml(l.msg)}</div>`
  ).join('');
  log.scrollTop = log.scrollHeight;

  renderPublicChat(state);
  if (activeChatTab === 'mafia') renderMafiaChat();

  if (state.phase === 'day' && state.currentSpeakerId === myId && alive) {
    if (!window._turnNotified || window._turnNotified !== state.day) {
      window._turnNotified = state.day;
      soundYourTurn();
      showToast('🎤 ВАША МИНУТА! 90 сек', '');
      $('topBar').classList.add('my-turn');
      setTimeout(() => $('topBar').classList.remove('my-turn'), 5000);
      startTitleBlink('🎤 ВАША МИНУТА — Мафия');
      setTimeout(() => stopTitleBlink(), 5000);
    }
  }
  if (state.phase === 'night' && window._lastPhase !== 'night') {
    soundNight();
    showToast(state.night === 1 ? `🌙 НОЧЬ 1 — ДОГОВОРКА` : `🌙 НОЧЬ ${state.night}`, 'night');
    myShotThisNight = null;
  }
  if (state.phase === 'vote' && window._lastPhase !== 'vote') {
    soundVote();
    showToast('🗳 ГОЛОСОВАНИЕ', 'vote');
    if (myIsJudge) setTimeout(() => botAutoVote(), 500);
  }
  if (state.phase === 'end' && window._lastPhase !== 'end') {
    soundEnd();
  }
  window._lastPhase = state.phase;
}

// ============ ПАНЕЛЬ ОНЛАЙН-СТАТУСА ============
function renderOnlinePanel(state) {
  let el = document.getElementById('onlinePanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'onlinePanel';
    el.className = 'online-panel';
    const colSide = document.querySelector('.col-side');
    if (colSide) colSide.insertBefore(el, colSide.firstChild);
  }

  const online = state.players.filter(p => !p.isJudge && p.connected && !p.isBot);
  const offline = state.players.filter(p => !p.isJudge && !p.connected && !p.isBot);
  const bots = state.players.filter(p => p.isBot);

  el.innerHTML = `
    <div class="online-title">🟢 В СЕТИ: ${online.length} / 🔴 ОФЛАЙН: ${offline.length} / 🤖 БОТЫ: ${bots.length}</div>
    <div class="online-list">
      ${state.players.filter(p => !p.isJudge).map(p => {
        let dot = '🟢';
        if (p.isBot) dot = '🤖';
        else if (!p.connected) dot = '🔴';
        else if (!p.alive) dot = '💀';
        return `<span class="online-chip ${p.connected || p.isBot ? 'on' : 'off'}" title="${escapeHtml(p.name)}">
          ${dot} №${p.id + 1} ${escapeHtml(p.name)}${p.alive ? '' : ' ☠'}
        </span>`;
      }).join('')}
    </div>
  `;
}

// ============ ИГРОК ============
function renderPlayer(state, el) {
  const me = state.me;
  const alive = me.alive;

  if (!alive) {
    el.innerHTML = `<div class="info-box warn" style="text-align:center;">
      Вы выбыли из игры.
    </div>`;
    renderPlayersList(state, el);
    return;
  }

  if (state.phase === 'night') {
    const isBlack = me.role && me.role.team === 'black';

    // НОЧЬ 1 — договорка
    if (state.night === 1) {
      if (isBlack) {
        el.innerHTML = `
          <div class="info-box warn">
            🌙 <b>Первая ночь — договорка мафии.</b><br>
            Откройте чат «🔪 МАФИЯ» справа.<br>
            Дон назначает порядок отстрела. <b>Стрелять в первую ночь нельзя.</b>
          </div>
        `;
      } else {
        el.innerHTML = `
          <div class="info-box">
            🌙 Ночь 1 — мафия договаривается. Закройте глаза и не разговаривайте.
          </div>
        `;
      }
      return;
    }

    // НОЧЬ 2+ — стрельба и проверки
    if (isBlack) {
      const targets = state.players.filter(p => p.alive && !p.isJudge && p.id !== me.id);
      const isDon = me.role.name === 'ДОН';
      const myDonCheck = mafiaData.myDonCheck;

      let donCheckBlock = '';
      if (isDon) {
        if (myDonCheck) {
          const tName = state.players.find(x => x.id === myDonCheck.targetId)?.name;
          const res = myDonCheck.isSheriff ? '🎯 ЭТО ШЕРИФ!' : '❌ Не Шериф';
          donCheckBlock = `<div class="info-box good">👑 Ваша проверка: №${myDonCheck.targetId + 1} ${escapeHtml(tName)} — ${res}</div>`;
        } else {
          donCheckBlock = `
            <div class="info-box warn">👑 <b>Ваша проверка (Дон):</b> кликните на игрока, чтобы узнать, Шериф ли он.</div>
            <div class="player-list" id="donCheckList"></div>
          `;
        }
      }

      el.innerHTML = `
        <div class="info-box warn">
          🌙 Ночь ${state.night}. <b>Выберите цель для отстрела.</b><br>
          Все чёрные должны выбрать <b>одного и того же</b>.
        </div>
        ${myShotThisNight !== null && myShotThisNight !== undefined
          ? `<div class="info-box good">✅ Вы стреляли в №${myShotThisNight + 1}.</div>`
          : `<div class="info-box">⬇ Выберите цель для выстрела:</div>`}
        <div class="player-list" id="shootList"></div>
        <div class="row">
          <button class="blue" onclick="mafiaShoot(null)">💨 ПРОМАХ (не стрелять)</button>
        </div>
        ${donCheckBlock}
      `;
      const list = $('shootList');
      targets.forEach(p => {
        const card = document.createElement('div');
        card.className = 'player-card';
        if (myShotThisNight === p.id) card.classList.add('selected');
        card.innerHTML = `<div class="num">№${p.id + 1}</div><div class="name">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</div>`;
        card.onclick = () => mafiaShoot(p.id);
        list.appendChild(card);
      });
      if (isDon && !myDonCheck) {
        const dcl = $('donCheckList');
        if (dcl) {
          targets.forEach(p => {
            const card = document.createElement('div');
            card.className = 'player-card';
            card.innerHTML = `<div class="num">№${p.id + 1}</div><div class="name">${escapeHtml(p.name)}</div>`;
            card.onclick = () => donCheck(p.id);
            dcl.appendChild(card);
          });
        }
      }
      return;
    }

    // Мирные — Шериф может проверять
    if (me.role && me.role.name === 'ШЕРИФ') {
      const myCheck = me.myCheck;
      const targets = state.players.filter(p => p.alive && !p.isJudge && p.id !== me.id);
      let checkBlock = '';
      if (myCheck) {
        const tName = state.players.find(x => x.id === myCheck.targetId)?.name;
        const res = myCheck.isBlack ? '🔪 ЧЁРНЫЙ' : '👤 КРАСНЫЙ';
        checkBlock = `<div class="info-box good">🔍 Ваша проверка: №${myCheck.targetId + 1} ${escapeHtml(tName)} — <b>${res}</b></div>`;
      } else {
        checkBlock = `
          <div class="info-box warn">🔍 <b>Ваша проверка (Шериф):</b> кликните на игрока — узнаете его команду.</div>
          <div class="player-list" id="sheriffCheckList"></div>
        `;
      }
      el.innerHTML = `
        <div class="info-box">🌙 Ночь ${state.night}. Закройте глаза... но у вас есть проверка.</div>
        ${checkBlock}
      `;
      if (!myCheck) {
        const list = $('sheriffCheckList');
        targets.forEach(p => {
          const card = document.createElement('div');
          card.className = 'player-card';
          card.innerHTML = `<div class="num">№${p.id + 1}</div><div class="name">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</div>`;
          card.onclick = () => sheriffCheck(p.id);
          list.appendChild(card);
        });
      }
      return;
    }

    el.innerHTML = `<div class="info-box">🌙 Ночь ${state.night}. Закройте глаза.</div>`;
    return;
  }

  if (state.phase === 'day') {
    const isMyTurn = state.currentSpeakerId === me.id;
    const silenced = me.silenced;

    let html = '';
    if (isMyTurn) {
      if (silenced) {
        html = `<div class="info-box warn">🤐 Вы лишены права слова.</div>
          <div class="row"><button class="blue" onclick="passSpeech()">⏭ ПАС</button></div>`;
      } else {
        html = `
          <div class="info-box good" style="text-align:center;">
            🎤 ВАША МИНУТА! Можно отправить несколько сообщений.
          </div>
          <textarea class="speech-input" id="speechInput" maxlength="700"
            placeholder="Ваша речь (Enter — новая строка, отправка — кнопкой)"></textarea>
          <div class="row">
            <button class="green" onclick="submitSpeech()">📨 ОТПРАВИТЬ В ЧАТ</button>
            <button class="blue" onclick="endSpeech()">🏁 ЗАВЕРШИТЬ РЕЧЬ</button>
            <button onclick="passSpeech()">⏭ ПАС</button>
          </div>
        `;
      }
    } else {
      const sp = state.players.find(p => p.id === state.currentSpeakerId);
      html = `<div class="info-box">
        Сейчас говорит: <b>${sp ? '№' + (sp.id + 1) + ' ' + escapeHtml(sp.name) : '— все выступили'}</b>
      </div>`;
    }

    el.innerHTML = html;

    if (isMyTurn && !me.hasNominated && !silenced) {
      const list = document.createElement('div');
      list.className = 'player-list';
      state.players.filter(p => p.alive && !p.isJudge && p.id !== me.id).forEach(p => {
        const card = document.createElement('div');
        card.className = 'player-card';
        if (state.candidates.includes(p.id)) card.classList.add('dead');
        card.innerHTML = `<div class="num">№${p.id + 1}</div><div class="name">${escapeHtml(p.name)}</div>`;
        if (!state.candidates.includes(p.id)) card.onclick = () => nominate(p.id);
        list.appendChild(card);
      });
      el.appendChild(list);
    }

    el.insertAdjacentHTML('beforeend', `
      <div class="info-box" style="margin-top:8px;">
        <b>Выставлены:</b> ${state.candidates.length
          ? state.candidates.map(id => '№' + (id + 1)).join(', ')
          : 'никого'}
      </div>
    `);

    if (!isMyTurn) {
      el.insertAdjacentHTML('beforeend', `
        <div class="info-box warn" style="margin-top:8px;">
          💬 Выкрик вне минуты = <b>фол</b>.
        </div>
        <div class="row">
          <input type="text" id="shoutText" placeholder="Что крикнуть?" maxlength="200"
            style="background:#0a0a0a;border:2px solid #333;color:#ffdd33;padding:6px 10px;border-radius:5px;font-family:inherit;font-size:0.78rem;flex:1;">
          <button class="foul" onclick="submitShout()">⚠ ВЫКРИКНУТЬ</button>
        </div>
      `);
    }
    return;
  }

  if (state.phase === 'vote') {
    el.innerHTML = `<div class="info-box">🗳 Голосование.</div>`;
    state.candidates.forEach(cid => {
      const c = state.players.find(p => p.id === cid);
      const voters = state.votes[cid] || [];
      const iVoted = voters.includes(me.id);
      const div = document.createElement('div');
      div.className = 'vote-row';
      div.innerHTML = `
        <div class="vote-bar"><div class="vote-fill" style="width:${voters.length / state.players.filter(p => p.alive).length * 100}%"></div></div>
        <div class="vote-count">${voters.length}</div>
        <button class="${iVoted ? 'green' : 'blue'}" onclick="vote(${cid})">
          ${iVoted ? '✅' : 'Против'} №${cid + 1} ${escapeHtml(c.name)}
        </button>
      `;
      el.appendChild(div);
    });
    return;
  }

  if (state.phase === 'revote_speech') {
    el.innerHTML = `<div class="info-box warn">
      ⚖ Ничья! Кандидаты: ${(state.candidates || []).map(id => '№' + (id + 1)).join(', ')}.
    </div>`;
  }
}

function renderPlayersList(state, el) {
  const list = document.createElement('div');
  list.className = 'player-list';
  state.players.filter(p => !p.isJudge).forEach(p => {
    const card = document.createElement('div');
    card.className = 'player-card' + (p.alive ? '' : ' dead') + (p.id === myId ? ' me' : '');
    let dot = '🟢';
    if (p.isBot) dot = '🤖';
    else if (!p.connected) dot = '🔴';
    else if (!p.alive) dot = '💀';
    card.innerHTML = `
      <div class="num">${dot} №${p.id + 1}</div>
      <div class="name">${escapeHtml(p.name)}</div>
      ${p.fouls ? `<div class="fouls">⚠×${p.fouls}</div>` : ''}
    `;
    list.appendChild(card);
  });
  el.appendChild(list);
}

// ============ СУДЬЯ ============
function renderJudge(state, el) {
  if (state.phase === 'night') {
    renderJudgeNight(state, el);
  } else if (state.phase === 'day') {
    renderJudgeDay(state, el);
  } else if (state.phase === 'vote') {
    renderJudgeVote(state, el);
  } else if (state.phase === 'revote_speech') {
    el.innerHTML = `
      <div class="info-box warn">
        ⚖ Ничья! Кандидаты: ${(state.candidates || []).map(id => '№' + (id + 1)).join(', ')}. 30 сек.
      </div>
      <div class="row">
        <button class="green" onclick="revote()">➡ ПЕРЕГОЛОСОВАНИЕ</button>
        <button class="blue" onclick="skipVote()">Никто не выбывает</button>
      </div>
    `;
  }
}

function renderJudgeNight(state, el) {
  const alive = state.players.filter(p => p.alive && !p.isJudge);
  const don = state.players.find(p => p.role && p.role.name === 'ДОН' && p.alive);
  const sheriff = state.players.find(p => p.role && p.role.name === 'ШЕРИФ' && p.alive);

  if (state.night === 1) {
    el.innerHTML = `
      <div class="info-box">
        <b>🌙 Ночь 1 — договорка мафии.</b><br>
        Чёрные общаются в чате «🔪 МАФИЯ». Стрельбы и проверок в эту ночь нет.
      </div>
      <div class="row">
        <button class="green" onclick="endFirstNight()">☀️ ДОГОВОРКА ЗАВЕРШЕНА → ДЕНЬ 1</button>
      </div>
    `;
    return;
  }

  const shotsThisNight = state.mafiaShots || {};
  const realRoles = state.judgeInfo?.realRoles || [];
  const blackPlayers = alive.filter(p => {
    const r = realRoles.find(x => x.id === p.id);
    return r && (r.role === 'mafia' || r.role === 'don');
  });

  const shotsRows = blackPlayers.map(bp => {
    const shotId = shotsThisNight[bp.id];
    const shotName = shotId !== undefined && shotId !== null
      ? `№${shotId + 1} ${state.players.find(x => x.id === shotId)?.name}`
      : '— ждём';
    const roleIcon = realRoles.find(x => x.id === bp.id)?.role === 'don' ? '👑' : '🔪';
    return `<div class="judge-row">
      <span class="who">№${bp.id + 1} ${escapeHtml(bp.name)} (${roleIcon})</span>
      <span style="color:#ff8888;">→ ${shotName}</span>
    </div>`;
  }).join('');

  // Панель проверок
  const sheriffChecks = state.judgeInfo?.sheriffChecks || {};
  const donChecks = state.judgeInfo?.donChecks || {};
  const checkRows = [];
  Object.entries(sheriffChecks).forEach(([sid, chk]) => {
    const s = state.players.find(x => x.id === +sid);
    const t = state.players.find(x => x.id === chk.targetId);
    if (s && t) {
      checkRows.push(`<div class="judge-row"><span class="who">🔍 Шериф №${s.id + 1} проверил №${t.id + 1}</span><span style="color:${chk.isBlack ? '#ff6666' : '#88ff88'};">${chk.isBlack ? 'ЧЁРНЫЙ' : 'КРАСНЫЙ'}</span></div>`);
    }
  });
  Object.entries(donChecks).forEach(([did, chk]) => {
    const d = state.players.find(x => x.id === +did);
    const t = state.players.find(x => x.id === chk.targetId);
    if (d && t) {
      checkRows.push(`<div class="judge-row"><span class="who">👑 Дон №${d.id + 1} проверил №${t.id + 1}</span><span style="color:${chk.isSheriff ? '#ffdd33' : '#888'};">${chk.isSheriff ? '🎯 ШЕРИФ!' : 'не Шериф'}</span></div>`);
    }
  });

  const killComputed = state.judgeInfo?.nightKillComputed;
  const killInfo = killComputed !== undefined && killComputed !== null
    ? `<div class="info-box warn">🎯 Все чёрные в №${killComputed + 1} — жертва: <b>${state.players.find(x => x.id === killComputed)?.name}</b></div>`
    : `<div class="info-box">💨 Пока промах или не все выстрелили</div>`;

  el.innerHTML = `
    <div class="info-box"><b>Ночь ${state.night}.</b> Ночные действия идут в реальном времени. У игроков 45 сек.</div>

    <h3>🔫 Выстрелы мафии</h3>
    <div class="judge-panel">
      ${shotsRows || '<div class="info-box warn">Нет живых чёрных</div>'}
      ${killInfo}
      <div class="row" style="margin-top:6px;">
        <button onclick="resetMafiaShots()">↩ Сбросить выстрелы</button>
      </div>
    </div>

    <h3>🔍 Проверки этой ночи</h3>
    <div class="judge-panel">
      ${checkRows.length ? checkRows.join('') : '<div class="info-box">Пока никто никого не проверял</div>'}
    </div>

    <div class="row" style="margin-top:12px;">
      <button class="green" onclick="submitNight()">☀️ ЗАВЕРШИТЬ НОЧЬ ДОСРОЧНО</button>
    </div>
  `;
}

function endFirstNight() { socket.emit('endFirstNight', { code: roomCode }); }
function resetMafiaShots() { socket.emit('resetMafiaShots', { code: roomCode }); }
function submitNight() { socket.emit('submitNight', { code: roomCode }); }

function renderJudgeDay(state, el) {
  const sp = state.players.find(p => p.id === state.currentSpeakerId);
  const spIsBot = sp && sp.isBot;

  el.innerHTML = `
    <div class="info-box">
      ${state.lastNightVictimId !== null
        ? `🌙 Ночью убит игрок №${state.lastNightVictimId + 1}.`
        : '🌙 Ночь прошла без жертв.'}
    </div>
    <div class="info-box">
      Сейчас говорит: <b>${sp ? '№' + (sp.id + 1) + ' ' + escapeHtml(sp.name) + (sp.isBot ? ' 🤖' : '') : '— все выступили'}</b>
    </div>
    <div class="info-box"><b>Выставлены:</b> ${state.candidates.length ? state.candidates.map(id => '№' + (id + 1)).join(', ') : 'никого'}</div>
  `;
  renderPlayersList(state, el);
  el.insertAdjacentHTML('beforeend', `
    <div class="row">
      <button class="blue" onclick="nextSpeaker()">➡ СЛЕДУЮЩИЙ</button>
      <button class="green" onclick="startVoting()">🗳 К ГОЛОСОВАНИЮ</button>
      ${spIsBot ? '<button onclick="skipBotsTurn()">🤖 ПРОПУСТИТЬ БОТА (ПАС)</button>' : ''}
    </div>
    <div class="judge-panel">
      <h3>⚖ Панель Судьи — фолы</h3>
      ${state.players.filter(p => p.alive && !p.isJudge).map(p => `
        <div class="judge-row">
          <span class="who">№${p.id + 1} ${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>
          <span class="fouls-count">⚠ ${p.fouls || 0}</span>
          ${p.silenced ? '<span style="color:#ffaa00;">🤐</span>' : ''}
          <button class="foul" onclick="addFoul(${p.id})">+фол</button>
          <button class="foul" onclick="removeFoul(${p.id})">−фол</button>
        </div>
      `).join('')}
    </div>
  `);
}

function renderJudgeVote(state, el) {
  el.innerHTML = `<div class="info-box">🗳 Голосование. Боты голосуют автоматически.</div>`;
  state.candidates.forEach(cid => {
    const c = state.players.find(p => p.id === cid);
    const voters = state.votes[cid] || [];
    const div = document.createElement('div');
    div.className = 'vote-row';
    div.innerHTML = `
      <div class="vote-bar"><div class="vote-fill" style="width:${voters.length / state.players.filter(p => p.alive).length * 100}%"></div></div>
      <div class="vote-count">${voters.length}</div>
      <span>№${cid + 1} ${escapeHtml(c.name)}${c.isBot ? ' 🤖' : ''}</span>
    `;
    el.appendChild(div);
  });
  el.insertAdjacentHTML('beforeend', `
    <div class="row" style="margin-top:12px;">
      <button class="green" onclick="tallyVotes()">📊 ПОДСЧИТАТЬ</button>
      <button onclick="skipVote()">Никто не выбывает</button>
      <button class="blue" onclick="botAutoVote()">🤖 ЗАСТАВИТЬ БОТОВ ГОЛОСОВАТЬ</button>
    </div>
  `);
}

function nextSpeaker() { socket.emit('nextSpeaker', { code: roomCode }); }
function startVoting() { socket.emit('startVoting', { code: roomCode }); }
function tallyVotes() { socket.emit('tallyVotes', { code: roomCode }); }
function skipVote() { socket.emit('skipVote', { code: roomCode }); }
function revote() { socket.emit('revote', { code: roomCode, candidateIds: latestState.candidates }); }
function addFoul(id) { socket.emit('addFoul', { code: roomCode, playerId: id }); }
function removeFoul(id) { socket.emit('removeFoul', { code: roomCode, playerId: id }); }
function skipBotsTurn() {
  const state = latestState;
  if (!state || state.phase !== 'day') return;
  const spId = state.currentSpeakerId;
  const sp = state.players.find(p => p.id === spId);
  if (!sp || !sp.isBot) return showToast('Сейчас говорит не бот', 'foul');
  socket.emit('botPass', { code: roomCode, playerId: spId });
}

// ============ ДЕЙСТВИЯ ============
function submitSpeech() {
  const inp = $('speechInput');
  if (!inp) return;
  const text = (inp.value || '').trim();
  if (!text) return showToast('Напишите текст', 'foul');
  socket.emit('submitSpeech', { code: roomCode, text });
  inp.value = '';
  inp.focus();
}
function endSpeech() {
  const inp = $('speechInput');
  if (inp && (inp.value || '').trim()) {
    socket.emit('submitSpeech', { code: roomCode, text: inp.value.trim() });
    inp.value = '';
  }
  socket.emit('endSpeech', { code: roomCode, pas: false });
}
function passSpeech() {
  socket.emit('endSpeech', { code: roomCode, pas: true });
}
function submitShout() {
  const inp = $('shoutText');
  if (!inp) return;
  const text = (inp.value || '').trim();
  if (!text) return;
  socket.emit('shout', { code: roomCode, text });
  inp.value = '';
  soundFoul();
}
function nominate(targetId) {
  if (!confirm(`Выставить №${targetId + 1}?`)) return;
  socket.emit('nominate', { code: roomCode, targetId });
}
function vote(candidateId) {
  socket.emit('vote', { code: roomCode, candidateId });
}
function mafiaShoot(targetId) {
  if (targetId === null) {
    myShotThisNight = null;
    socket.emit('mafiaShoot', { code: roomCode, targetId: null });
    return;
  }
  if (!confirm(`Стрелять в №${targetId + 1}?`)) return;
  myShotThisNight = targetId;
  socket.emit('mafiaShoot', { code: roomCode, targetId });
}
function donCheck(targetId) {
  if (!confirm(`Проверить №${targetId + 1} на Шерифа? (1 раз за ночь)`)) return;
  socket.emit('donCheck', { code: roomCode, targetId });
}
function sheriffCheck(targetId) {
  if (!confirm(`Проверить №${targetId + 1}? (1 раз за ночь)`)) return;
  socket.emit('sheriffCheck', { code: roomCode, targetId });
}

// ============ ЧАТЫ ============
function renderPublicChat(state) {
  const el = $('speechChat');
  const speeches = state.speeches.filter(s => s.day === state.day);
  if (speeches.length === 0) {
    el.innerHTML = `<div class="info-box">Пока сообщений нет.</div>`;
    return;
  }
  el.innerHTML = speeches.map(s => {
    const p = state.players.find(x => x.id === s.playerId);
    if (!p) return '';
    const timeStr = fmtTime(s.t);
    const meta = `<div class="meta">
      <span class="who">№${s.playerId + 1} ${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>
      <span class="time">${timeStr}</span>
    </div>`;
    if (s.pas) return `<div class="chat-speech">${meta}<span class="pas">ПАС</span></div>`;
    if (s.shout) return `<div class="chat-speech shout">
      ${meta}<span class="shout-tag">⚠ ВЫКРИК ВНЕ МИНУТЫ</span>${escapeHtml(s.text)}
    </div>`;
    return `<div class="chat-speech">${meta}${escapeHtml(s.text)}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function switchChatTab(tab) {
  activeChatTab = tab;
  if (tab === 'public') {
    $('tabPublic').classList.add('active');
    $('tabMafia').classList.remove('active');
    $('speechChat').style.display = 'block';
    $('mafiaChat').style.display = 'none';
  } else {
    $('tabPublic').classList.remove('active');
    $('tabMafia').classList.add('active');
    $('speechChat').style.display = 'none';
    $('mafiaChat').style.display = 'block';
    renderMafiaChat();
  }
}

function renderMafiaChat() {
  const el = $('mafiaChat');
  const me = latestState && latestState.me;
  if (!me || !me.role || me.role.team !== 'black') {
    el.innerHTML = `<div class="info-box warn">Чат мафии.</div>`;
    return;
  }
  const isDon = me.role.name === 'ДОН';
  const msgs = mafiaData.messages || [];

  el.innerHTML = `
    <div class="mafia-chat">
      <div class="mafia-title">🔪 ЧЁРНАЯ КОМАНДА — НОЧЬ ${latestState.night}</div>
      ${msgs.length === 0
        ? '<div class="info-box" style="font-size:0.7rem;">Пока сообщений нет.</div>'
        : msgs.map(m => {
            const p = latestState.players.find(x => x.id === m.playerId);
            const time = fmtTime(m.t);
            const cls = m.isPlan ? 'mafia-msg don-plan' : 'mafia-msg';
            const prefix = m.isPlan ? '👑 ПЛАН ДОНА' : `№${m.playerId + 1} ${escapeHtml(p ? p.name : '?')}`;
            return `<div class="${cls}">
              <div class="meta">
                <span class="who">${prefix}</span>
                <span class="time">${time}</span>
              </div>
              ${escapeHtml(m.text)}
            </div>`;
          }).join('')}
    </div>

    ${isDon ? `
      <div class="mafia-chat">
        <div class="mafia-title">👑 ПЛАН ДОНА</div>
        <textarea class="plan-input" id="donPlanInput" maxlength="400"
          placeholder="Порядок отстрела, кого проверять...">${escapeHtml(mafiaData.donPlan || '')}</textarea>
        <div class="row">
          <button class="green" onclick="saveDonPlan()">💾 ОТПРАВИТЬ ПЛАН</button>
        </div>
      </div>
    ` : ''}

    <div class="mafia-chat">
      <div class="mafia-title">✉ СООБЩЕНИЕ ЧЁРНЫМ</div>
      <textarea class="plan-input" id="mafiaMsgInput" maxlength="400"
        placeholder="Например: стреляем в №5..."></textarea>
      <div class="row">
        <button class="green" onclick="sendMafiaMessage()">📨 ОТПРАВИТЬ</button>
      </div>
    </div>
  `;
}

function saveDonPlan() {
  const inp = $('donPlanInput');
  if (!inp) return;
  const text = (inp.value || '').trim();
  if (!text) return;
  socket.emit('saveDonPlan', { code: roomCode, text });
}
function sendMafiaMessage() {
  const inp = $('mafiaMsgInput');
  if (!inp) return;
  const text = (inp.value || '').trim();
  if (!text) return;
  socket.emit('mafiaMessage', { code: roomCode, text });
  inp.value = '';
}

// ============ КОНЕЦ ============
function renderEnd(state, el) {
  const badge = { red: '🏆 ПОБЕДА КРАСНЫХ', black: '🔪 ПОБЕДА МАФИИ', draw: '⚖ НИЧЬЯ' };
  el.innerHTML = `
    <div class="phase-badge ${state.winner === 'red' ? 'day' : state.winner === 'black' ? 'night' : 'end'}">
      ${badge[state.winner] || 'ИГРА ОКОНЧЕНА'}
    </div>
    <div class="info-box good" style="text-align:center;">${escapeHtml(state.winMessage || '')}</div>
  `;
  if (state.finalRoles) {
    const list = document.createElement('div');
    list.className = 'player-list';
    state.finalRoles.forEach(p => {
      const card = document.createElement('div');
      card.className = 'player-card' + (p.alive ? '' : ' dead');
      card.innerHTML = `
        <div class="num">№${p.id + 1}</div>
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="role-revealed">${p.role.emoji} ${p.role.name}${p.fouls ? ' · ⚠×' + p.fouls : ''}</div>
      `;
      list.appendChild(card);
    });
    el.appendChild(list);
  }
}

// ============ МОДАЛКИ ============
function showMyRoleModal() {
  if (!latestState || !latestState.me || !latestState.me.role) return;
  const r = latestState.me.role;
  const cls = r.team === 'black' ? (r.name === 'ДОН' ? 'don' : 'mafia')
            : r.team === 'red' ? (r.name === 'ШЕРИФ' ? 'sheriff' : 'civilian')
            : 'judge';
  $('myRoleModalContent').innerHTML = `
    <div class="role-big ${cls}">
      <div class="emoji">${r.emoji}</div>
      <div class="title">${r.name}</div>
      <div class="desc">${r.desc || ''}</div>
      <div style="margin-top:10px;font-size:0.7rem;color:#888;">
        Ты — игрок №${latestState.me.id + 1} ${escapeHtml(latestState.me.name)}
      </div>
      <div class="info-box" style="font-size:0.72rem;">Фолов: ${latestState.me.fouls || 0}</div>
    </div>
  `;
  $('myRoleModal').classList.add('active');
}
function closeMyRoleModal() { $('myRoleModal').classList.remove('active'); }
function closeAllRoles() { $('allRolesModal').classList.remove('active'); }

// ============ ENTER В TEXTAREA ============
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target && e.target.tagName === 'TEXTAREA') return;
});

// ============ РЕКОННЕКТ ============
window.addEventListener('load', () => {
  const code = localStorage.getItem('mafia_code');
  const pid = localStorage.getItem('mafia_id');
  if (code && pid !== null) {
    socket.emit('reconnectPlayer', { code, playerId: +pid });
    setTimeout(() => {
      if (!roomCode) {
        localStorage.removeItem('mafia_code');
        localStorage.removeItem('mafia_id');
      }
    }, 1500);
  }
});