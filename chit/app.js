/**
 * app.js — UI-слой: связка интерфейса с ядром (ChitCore) и Speech-адаптером.
 * Загрузка JSON, создание BlockSession (через ядро), обработка событий, экраны.
 * Никакой логики обучения здесь нет — только отображение и ввод.
 */
'use strict';

class SoundEngine {
  constructor() { this.ctx = null; }
  init() { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  _ensureCtx() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  _note(freq, t, dur, type = 'sine', vol = 0.2) {
    if (!this.ctx) return; this._ensureCtx();
    const osc = this.ctx.createOscillator(); const gain = this.ctx.createGain();
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(vol, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.ctx.destination); osc.start(t); osc.stop(t + dur);
  }
  playSuccess() { if (!this.ctx) return; this._ensureCtx(); const t = this.ctx.currentTime;
    this._note(523.25, t, 0.18, 'triangle', 0.22); this._note(659.25, t + 0.09, 0.18, 'triangle', 0.22);
    this._note(783.99, t + 0.18, 0.18, 'triangle', 0.22); this._note(1046.5, t + 0.27, 0.28, 'triangle', 0.25); }
  playError() { if (!this.ctx) return; this._ensureCtx(); const t = this.ctx.currentTime;
    this._note(329.63, t, 0.22, 'sine', 0.15); this._note(261.63, t + 0.14, 0.28, 'sine', 0.12); }
  playFanfare() { if (!this.ctx) return; this._ensureCtx(); const t = this.ctx.currentTime;
    this._note(523.25, t, 0.25, 'triangle', 0.22); this._note(659.25, t + 0.15, 0.25, 'triangle', 0.22);
    this._note(783.99, t + 0.30, 0.25, 'triangle', 0.22);
    this._note(523.25, t + 0.50, 0.60, 'triangle', 0.18); this._note(659.25, t + 0.50, 0.60, 'triangle', 0.18);
    this._note(783.99, t + 0.50, 0.60, 'triangle', 0.18); this._note(1046.5, t + 0.50, 0.70, 'triangle', 0.22); }
}

class App {
  constructor() {
    this.sound = new SoundEngine();
    // Speech-слой: интерфейс + адаптер (замена на Android/IOS — одна строка)
    this.speech = new WebSpeechAdapter();
    // Ядро: данные грузим из подгружаемого файла настройки syllables.json
    this.core = new ChitCore({
      loader: new SyllableLoader('data/syllables.json'),
      store: localStorage,
    });
    this.currentSyllable = null;
    this.nextTimer = null;
    this.recClearTimer = null;
    this.currentScreen = 'start';
    this.isProcessingResult = false;
    this.AFTER_CORRECT_DELAY_MS = 1000;
    this.AFTER_ERROR_SPEAK_DELAY_MS = 600;
    this.successEmojis = ['😀','🎉','⭐','👍','🌟','😎','🥳','💪'];
    this.completeStickers = ['🏆','🦄','🚀','🎊','👑','🌈','🎯','🦁'];
    this.confettiEmojis = ['🎉','⭐','🎈','🎊','✨','💫','🌟','🎀'];
  }

  async init() {
    this.sound.init();
    this.speech.init();
    this.speech.onVoicesLoaded = (v) => this.populateVoiceSelect(v);
    this.speech.onHypothesisUpdate = (hyps) => this.updateRecognitionLogLive(hyps);
    this.speech.onListeningStopped = (hyps) => this.onListeningFinished(hyps);

    this.core.onEvent = (name, payload) => this.onCoreEvent(name, payload);

    try {
      await this.core.loadData();
    } catch (e) {
      console.error('[App] не удалось загрузить syllables.json:', e);
      alert('Не удалось загрузить data/syllables.json.\n' +
        'Открывайте приложение через HTTP-сервер, а не file://:\n\n' +
        '  python -m http.server 8000  →  http://localhost:8000/chit/');
    }

    this.bindEvents();
    this.showScreen('start');
    const v = this.speech.allVoices;
    if (v.length > 0) this.populateVoiceSelect(v);
    await this.runDiagnostics();
    this.registerServiceWorker();
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[SW] регистрация не удалась:', e));
    }
  }

  /* ---------- Ядро → UI ---------- */

  onCoreEvent(name, payload) {
    switch (name) {
      case 'block-start':
        document.getElementById('block-title').textContent = `${payload.level.title} · Блок ${payload.block.id}`;
        document.getElementById('letters-hint').textContent = `Буквы: ${payload.block.letters.join(', ')}`;
        break;
      case 'syllable':
        this.currentSyllable = payload.syllable;
        this.showSyllable();
        break;
      case 'attempt':
        this.updateProgress(payload.states, payload.summary);
        break;
      case 'block-complete':
        this.onBlockComplete(payload.summary);
        break;
      case 'all-complete':
        alert('🎉 Все блоки пройдены!');
        this.showScreen('start');
        break;
    }
  }

  /* ---------- Диагностика окружения ---------- */

  async runDiagnostics() {
    const set = (id, text, cls) => { const el = document.getElementById(id); if (el) { el.textContent = text; el.className = 'diag-status ' + cls; } };
    const hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    set('diag-speech', hasSR ? '✅ API есть' : '❌ Нет API', hasSR ? 'ok' : 'fail');
    const hasSynth = !!window.speechSynthesis;
    set('diag-synth', hasSynth ? '✅ Доступно' : '❌ Нет', hasSynth ? 'ok' : 'fail');
    const hasStorage = this.core.storageAvailable;
    set('diag-storage', hasStorage ? '✅ Работает' : '❌ Заблокировано', hasStorage ? 'ok' : 'fail');
    const isIframe = window.self !== window.top;
    set('diag-env', isIframe ? '⚠️ iframe' : '✅ Прямой доступ', isIframe ? 'warn' : 'ok');
    const micEl = document.getElementById('diag-mic');
    if (micEl) {
      if (this.speech.micGranted) { micEl.textContent = '✅ Разрешён'; micEl.className = 'diag-status ok'; }
      else if (this.speech.micBlocked) { micEl.textContent = '❌ Заблокирован'; micEl.className = 'diag-status fail'; }
      else { micEl.textContent = '⏳ Требуется запрос'; micEl.className = 'diag-status pending'; }
    }
    if (isIframe) { const w = document.getElementById('env-warning'); if (w) w.style.display = 'block'; }
    this.updateMicButton();
  }

  updateMicButton() {
    const btn = document.getElementById('btn-mic');
    if (!btn) return;
    btn.classList.remove('granted', 'denied');
    if (this.speech.micGranted) btn.classList.add('granted');
    else if (this.speech.micBlocked) btn.classList.add('denied');
  }

  async requestMicPermission() {
    const btn = document.getElementById('btn-request-mic');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Запрашиваем разрешение...'; }
    const granted = await this.speech.requestMicPermission();
    if (btn) {
      btn.disabled = false;
      if (granted) { btn.textContent = '✅ Микрофон разрешён!'; btn.style.background = 'linear-gradient(135deg, #4CAF50, #66BB6A)'; }
      else { btn.textContent = '❌ ' + this.speech.micBlockReason; btn.style.background = 'linear-gradient(135deg, #EF5350, #E53935)'; }
    }
    await this.runDiagnostics();
    if (granted) alert('✅ Микрофон разрешён!');
    else alert('❌ Не удалось: ' + this.speech.micBlockReason);
  }

  populateVoiceSelect(voices) {
    const sel = document.getElementById('voice-select');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = ''; auto.textContent = '🤖 Авто (русский)';
    sel.appendChild(auto);
    const ru = [], other = [];
    voices.forEach((v, i) => (v.lang.toLowerCase().startsWith('ru') ? ru : other).push({ v, i }));
    const cmp = (a, b) => a.v.name.localeCompare(b.v.name, 'ru');
    ru.sort(cmp); other.sort(cmp);
    if (ru.length) {
      const g = document.createElement('optgroup');
      g.label = `🇷🇺 Русские (${ru.length})`;
      ru.forEach(({ v, i }) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${v.name}${v.localService ? '' : ' ☁️'}`; g.appendChild(o); });
      sel.appendChild(g);
    }
    if (other.length) {
      const g = document.createElement('optgroup');
      g.label = `🌍 Другие (${other.length})`;
      other.forEach(({ v, i }) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${v.name} (${v.lang})`; g.appendChild(o); });
      sel.appendChild(g);
    }
    if (cur && sel.querySelector(`option[value="${cur}"]`)) sel.value = cur;
  }

  /* ---------- Лог распознавания (отладка ASR) ---------- */

  updateRecognitionLogLive(hypotheses) {
    const box = document.getElementById('recognition-log-box');
    if (!box) return;
    let html = '<div style="margin-bottom:4px;color:#FFB3B3;font-size:11px">🔴 Слушаю... (удерживайте кнопку)</div>';
    html += `<div style="margin-bottom:4px;color:#90CAF9;font-size:10px">Получено гипотез: ${hypotheses.length}</div>`;
    const displayHyps = hypotheses.slice(-6);
    displayHyps.forEach((hyp) => {
      const conf = hyp.confidence ? Math.round(hyp.confidence * 100) + '%' : '?';
      const filtered = hyp.filtered ? ` <span style="color:#EF9A9A">[${hyp.filterReason}]</span>` : '';
      const cls = hyp.filtered ? 'hyp-item hyp-filtered' : (hyp.isFinal ? 'hyp-item hyp-final' : 'hyp-item hyp-interim');
      html += `<div class="${cls}">${hyp.transcript} (${conf})${filtered}</div>`;
    });
    box.innerHTML = html;
    box.className = 'recognition-log-box listening';
  }

  onListeningFinished(hypotheses) {
    console.log('[App] onListeningFinished, гипотез:', hypotheses.length);
    this.setMicState(false);
    if (this.currentScreen !== 'block' || !this.currentSyllable) return;
    if (this.isProcessingResult) return;
    this.isProcessingResult = true;

    // Сопоставление — чистая доменная функция, живёт в BlockSession.findMatchInHypotheses
    const match = BlockSession.findMatchInHypotheses(this.currentSyllable, hypotheses);
    this.showRecognitionResult(hypotheses, this.currentSyllable, match);

    setTimeout(() => {
      this.isProcessingResult = false;
      if (match && match.type === 'letters') { this.onLetterReading(); return; }
      if (match) this.onCorrect();
      else {
        const firstValid = hypotheses.find(h => !h.filtered);
        const firstText = firstValid ? firstValid.transcript : '';
        this.onError(firstText);
      }
    }, 200);
  }

  showRecognitionResult(hypotheses, targetSyllable, match) {
    const box = document.getElementById('recognition-log-box');
    const ind = document.getElementById('rec-indicator');
    if (!box) return;

    if (this.speech.micBlocked) {
      box.innerHTML = '🚫 Микрофон заблокирован';
      box.className = 'recognition-log-box unavailable';
      return;
    }

    if (!hypotheses || !hypotheses.length) {
      box.innerHTML = '......................................................................<div style="margin-top:4px;font-size:11px">Тишина — ничего не распознано</div>';
      box.className = 'recognition-log-box empty';
    } else {
      const total = hypotheses.length;
      const filtered = hypotheses.filter(h => h.filtered).length;
      const cyrillic = total - filtered;
      let html = `<div style="margin-bottom:6px;color:#90CAF9;font-size:11px">Всего: ${total} · Кириллица: ${cyrillic} · Отфильтровано: ${filtered}</div>`;
      const displayHyps = hypotheses.slice(0, 20);
      displayHyps.forEach((hyp, idx) => {
        const isMatch = match && hyp === match.hypothesis;
        const conf = hyp.confidence ? Math.round(hyp.confidence * 100) + '%' : '?';
        const finalMark = hyp.isFinal ? ' [final]' : ' [interim]';
        let cls = 'hyp-item';
        if (isMatch) cls += ' hyp-match';
        else if (hyp.filtered) cls += ' hyp-filtered';
        else if (hyp.isFinal) cls += ' hyp-final';
        else cls += ' hyp-interim';
        const matchMark = isMatch ? ' ✓ СОВПАЛО' : '';
        const filterMark = hyp.filtered ? ` ✗ ${hyp.filterReason}` : '';
        html += `<div class="${cls}">[${idx}] ${hyp.transcript} (${conf})${finalMark}${matchMark}${filterMark}</div>`;
      });
      if (hypotheses.length > 20) html += `<div style="color:#64748B;margin-top:4px">... и ещё ${hypotheses.length - 20}</div>`;
      if (match) html += `<div style="margin-top:8px;color:${match.type === 'letters' ? '#FFD54F' : '#4CAF50'};font-weight:900">${match.type === 'letters' ? '🔤 Побуквенное чтение: ' : '✅ Найдено совпадение: '}${match.matchText} (${match.type})</div>`;
      else if (cyrillic === 0) html += `<div style="margin-top:8px;color:#FFD54F;font-weight:900">⚠️ Все гипотезы отфильтрованы</div>`;
      else html += `<div style="margin-top:8px;color:#EF9A9A;font-weight:900">❌ Совпадение не найдено</div>`;
      box.innerHTML = html;
      box.className = 'recognition-log-box ' + (match ? (match.type === 'letters' ? 'unavailable' : 'success') : (cyrillic === 0 ? 'unavailable' : 'error'));
    }
    if (ind) ind.classList.remove('active');
    if (this.recClearTimer) clearTimeout(this.recClearTimer);
    this.recClearTimer = setTimeout(() => { box.innerHTML = ''; box.className = 'recognition-log-box empty'; this.recClearTimer = null; }, 10000);
  }

  /* ---------- Экраны и события ---------- */

  showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const t = document.getElementById(`screen-${name}`);
    if (t) t.classList.add('active');
    this.currentScreen = name;
    if (name !== 'block') { this.clearAllTimers(); this.stopListening(); }
  }

  bindEvents() {
    const micBtn = document.getElementById('btn-mic');
    if (micBtn) {
      // Аудиопоток: onPress → старт, onRelease → стоп
      const handlePress = (e) => { e.preventDefault(); this.startMicPress(); };
      const handleRelease = (e) => { e.preventDefault(); this.stopMicPress(); };
      micBtn.addEventListener('mousedown', handlePress);
      micBtn.addEventListener('mouseup', handleRelease);
      micBtn.addEventListener('mouseleave', handleRelease);
      micBtn.addEventListener('touchstart', handlePress, { passive: false });
      micBtn.addEventListener('touchend', handleRelease, { passive: false });
      micBtn.addEventListener('touchcancel', handleRelease, { passive: false });
      micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    document.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.id === 'btn-mic') return;
      const id = t.id, demo = t.dataset.demo;
      try {
        if (id === 'btn-start') this.startBlock();
        else if (id === 'btn-stats') this.showStats();
        else if (id === 'btn-stats-back') this.showScreen('start');
        else if (id === 'btn-back') { try { this.speech.synth?.cancel(); } catch (e) {} this.showScreen('start'); }
        else if (id === 'btn-repeat') this.onRepeat();
        else if (id === 'btn-skip') this.onSkip();
        else if (id === 'btn-next-block') this.nextBlock();
        else if (id === 'btn-home') this.showScreen('start');
        else if (id === 'btn-request-mic') this.requestMicPermission();
        else if (id === 'btn-reset') {
          if (confirm('Сбросить весь прогресс?')) {
            this.core.resetProgress();
            alert('Прогресс сброшен!');
          }
        }
        else if (id === 'btn-copy-instruction') {
          const text = document.getElementById('instruction-text')?.textContent || '';
          if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => alert('✅ Скопировано!')).catch(() => alert(text));
          else alert(text);
        }
        else if (demo === 'correct') this.onDemo('correct');
        else if (demo === 'wrong') this.onDemo('wrong');
        else if (demo === 'skip') this.onDemo('skip');
        else if (demo === 'speak') this.onRepeat();
      } catch (err) { console.error('Handler error:', err); }
    });

    const vs = document.getElementById('voice-select');
    if (vs) vs.addEventListener('change', (e) => {
      this.speech.setVoiceByIndex(e.target.value === '' ? -1 : parseInt(e.target.value, 10));
    });
  }

  /* ---------- Микрофон ---------- */

  startMicPress() {
    console.log('[App] startMicPress');
    try { this.speech.synth.cancel(); } catch (e) {}
    if (this.speech.isListeningNow) return;
    if (!this.currentSyllable) return;
    if (this.isProcessingResult) return;
    if (!this.speech.micGranted) { alert('🎤 Сначала разрешите доступ к микрофону!'); return; }
    this.setMicState(true);
    const box = document.getElementById('recognition-log-box');
    const ind = document.getElementById('rec-indicator');
    if (box) { box.innerHTML = '🔴 Слушаю... удерживайте кнопку'; box.className = 'recognition-log-box listening'; }
    if (ind) ind.classList.add('active');
    const started = this.speech.startListening();
    if (!started) {
      this.setMicState(false);
      if (box) { box.innerHTML = '❌ Не удалось запустить микрофон'; box.className = 'recognition-log-box unavailable'; }
    }
  }

  stopMicPress() {
    console.log('[App] stopMicPress');
    if (!this.speech.isListeningNow) return;
    this.speech.stopListening();
  }

  stopListening() {
    if (this.speech.isListeningNow) this.speech.stopListening();
    this.setMicState(false);
  }

  setMicState(listening) {
    const btn = document.getElementById('btn-mic');
    if (!btn) return;
    if (listening) {
      btn.classList.add('listening');
      btn.querySelector('.mic-text').textContent = 'Слушаю...';
      btn.querySelector('.mic-hint').textContent = 'отпустите';
    } else {
      btn.classList.remove('listening');
      btn.querySelector('.mic-text').textContent = 'Говори!';
      btn.querySelector('.mic-hint').textContent = 'удерживай';
    }
  }

  clearAllTimers() {
    if (this.nextTimer) { clearTimeout(this.nextTimer); this.nextTimer = null; }
    if (this.recClearTimer) { clearTimeout(this.recClearTimer); this.recClearTimer = null; }
  }

  /* ---------- Цикл тренировки ---------- */

  startBlock() {
    if (!this.core.data) { alert('Данные (syllables.json) не загружены.'); return; }
    const info = this.core.startBlock(); // ядро эмитит block-start + syllable
    if (!info) return;                    // all-complete уже обработан в onCoreEvent
    this.showScreen('block');
    this.updateProgress(info.session.getSyllableStates(), info.session.getSummary());
  }

  showSyllable() {
    const el = document.getElementById('syllable-display');
    el.textContent = this.currentSyllable;
    el.className = 'syllable-display';
    void el.offsetWidth; // перезапуск анимации popIn
    el.className = 'syllable-display';
    this.hideFeedback();
    this.setMicState(false);
  }

  onCorrect() {
    const res = this.core.submitMatch({ type: 'exact' });
    if (!res) return;
    this.sound.playSuccess();
    document.getElementById('syllable-display').classList.add('correct-flash');
    this.showFeedback(this.pick(this.successEmojis) + ' Верно!', 'success');
    if (!res.finished) {
      this.nextTimer = setTimeout(() => this.hideFeedback(), this.AFTER_CORRECT_DELAY_MS);
    }
  }

  async onError(recognized) {
    const res = this.core.submitMatch(null);
    if (!res) return;
    this.sound.playError();
    document.getElementById('syllable-display').classList.add('shake');
    const rec = recognized ? ` (услышала «${recognized}»)` : '';
    this.showFeedback('Упс' + rec + '. Послушай:', 'error');
    await new Promise(r => setTimeout(r, this.AFTER_ERROR_SPEAK_DELAY_MS));
    await this.speech.speak(this.currentSyllable || '');
    this.nextTimer = setTimeout(() => {
      this.hideFeedback();
      document.getElementById('syllable-display').classList.remove('shake');
    }, 300);
  }

  // Постбукварная стадия: побуквенное чтение — отдельный класс ошибки
  async onLetterReading() {
    const res = this.core.submitMatch({ type: 'letters' });
    if (!res) return;
    this.sound.playError();
    const el = document.getElementById('syllable-display');
    el.classList.add('shake');
    this.showFeedback('Это названия букв. Склей их в слог:', 'error');
    await new Promise(r => setTimeout(r, this.AFTER_ERROR_SPEAK_DELAY_MS));
    await this.speech.speak(this.currentSyllable || '');
    this.nextTimer = setTimeout(() => {
      el.classList.remove('shake');
      this.hideFeedback();
    }, 300);
  }

  onRepeat() { if (!this.currentSyllable) return; this.speech.speak(this.currentSyllable); }

  async onSkip() {
    if (!this.currentSyllable) return;
    const syl = this.currentSyllable;
    const res = this.core.skip();
    if (!res) return;
    this.showFeedback('Это было «' + syl + '»', 'error');
    await this.speech.speak(syl);
    this.nextTimer = setTimeout(() => this.hideFeedback(), 300);
  }

  onDemo(action) {
    if (!this.currentSyllable) return;
    this.clearAllTimers();
    if (action === 'correct') this.onCorrect();
    else if (action === 'wrong') this.onError('демо');
    else if (action === 'skip') this.onSkip();
  }

  onBlockComplete(summary) {
    this.clearAllTimers();
    this.sound.playFanfare();
    document.getElementById('complete-sticker').textContent = this.pick(this.completeStickers);
    document.getElementById('complete-stats').textContent =
      `Ошибок: ${summary.errors}  ·  Побуквенно: ${summary.letterErrors}  ·  Верных: ${summary.correct}`;
    this.showScreen('complete');
    this.spawnConfetti();
  }

  nextBlock() { this.startBlock(); }

  updateProgress(states, summary) {
    if (!states || !summary) return;
    const bar = document.getElementById('progress-bar');
    bar.innerHTML = '';
    for (const st of states) {
      const seg = document.createElement('div');
      seg.className = 'progress-segment';
      if (st.state === 'done') seg.classList.add('done');
      else if (st.state === 'trouble') seg.classList.add('trouble');
      else if (st.state === 'in-progress') seg.classList.add('in-progress');
      bar.appendChild(seg);
    }
    document.getElementById('progress-text').textContent = `${summary.done} / ${summary.total} слогов освоено`;
  }

  showFeedback(text, type) { const el = document.getElementById('feedback'); el.textContent = text; el.className = 'feedback ' + type; }
  hideFeedback() { document.getElementById('feedback').className = 'feedback hidden'; }

  spawnConfetti() {
    const c = document.getElementById('confetti'); c.innerHTML = '';
    for (let i = 0; i < 30; i++) {
      const p = document.createElement('div'); p.className = 'confetti-piece';
      p.textContent = this.pick(this.confettiEmojis);
      p.style.left = Math.random() * 100 + '%';
      p.style.animationDuration = (2 + Math.random() * 3) + 's';
      p.style.animationDelay = Math.random() * 1.5 + 's';
      p.style.fontSize = (20 + Math.random() * 20) + 'px';
      c.appendChild(p);
    }
    setTimeout(() => c.innerHTML = '', 6000);
  }

  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  /* ---------- Статистика для родителя/учителя ---------- */

  showStats() {
    this.showScreen('stats');
    const report = this.core.getStatsReport();
    if (!report) return;
    const sum = document.getElementById('stats-summary');
    const tbl = document.getElementById('stats-table');
    tbl.innerHTML = '';
    for (const row of report.rows) {
      const stxt = { done: '✅ Пройден', 'in-progress': '🔄 В процессе', 'not-started': 'Не начат' }[row.state];
      const el = document.createElement('div');
      el.className = 'stats-row';
      el.innerHTML = `<span class="block-name">${row.blockId} ${row.letters.join('')}</span>
        <span style="color:#999;font-size:13px">✓${row.correct} ✗${row.errors} 🔤${row.letterErrors}</span>
        <span class="block-status ${row.state}">${stxt}</span>`;
      tbl.appendChild(el);
    }
    sum.innerHTML = `📚 Блоков пройдено: <strong>${report.done} / ${report.total}</strong><br>
      ✅ Верных: <strong>${report.correct}</strong><br>❌ Ошибок: <strong>${report.errors}</strong><br>🔤 Побуквенно: <strong>${report.letterErrors}</strong><br>📈 Точность: <strong>${report.accuracy}%</strong>
      ${!this.core.storageAvailable ? '<br><br>⚠️ <em>Сохранение недоступно</em>' : ''}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
  document.addEventListener('click', () => app.sound._ensureCtx(), { once: true });
});
