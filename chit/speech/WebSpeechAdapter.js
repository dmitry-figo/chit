/**
 * WebSpeechAdapter.js — адаптер Speech-слоя на Web Speech API (Chrome/Edge/Safari).
 * Реализует контракт SpeechAdapter. Позже появятся AndroidSpeechAdapter / IOSSpeechAdapter.
 *
 * Поведение (по README):
 *  - lang='ru-RU', interimResults=true, maxAlternatives — собираем ВСЕ сырые кириллические
 *    гипотезы до вмешательства языковой модели; латиница помечается filtered;
 *  - аудиопоток стартует по onPress и прекращается по onRelease кнопки микрофона
 *    (stop() откладывается на 500 мс, чтобы recognition успел отдать последние interim-гипотезы);
 *  - подробное логирование всех вариантов ASR для отладки (console + события UI).
 */
'use strict';

(function (root) {
  const Base = (typeof module === 'object' && module.exports)
    ? require('./SpeechAdapter.js')
    : root.SpeechAdapter;

  // Переозвучка проблемных слогов: акут «а́м» / финальный «ъ» «умъ» — против побуквенного чтения TTS
  const TTS_OVERRIDES = {
    'ам': '́амъ', 'ат': '́атъ', 'ан': '́анъ', 'ас': '́асъ', 'ар': '́аръ', 'ак': '́акъ', 'ал': '́алъ',
    'ум': '́умъ', 'ул': '́улъ', 'он': '́онъ', 'от': '́отъ', 'ок': '́окъ', 'ор': '́оръ', 'ос': '́осъ'
  };

  function containsLatin(text) { return /[a-zA-Z]/.test(text); }
  function containsCyrillic(text) { return /[а-яёА-ЯЁ]/.test(text); }

  class WebSpeechAdapter extends Base {
    constructor() {
      super();
      this.recognition = null;
      this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
      this.voice = null;
      this.allVoices = [];
      this.stopTimer = null;       // таймер для отложенного stop()
      this._userPicked = false;
    }

    init() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        try {
          this.recognition = new SR();
          this.recognition.lang = 'ru-RU';
          this.recognition.continuous = true;
          this.recognition.interimResults = true;
          this.recognition.maxAlternatives = 25;   // максимум сырых гипотез
          this.speechAvailable = true;

          this.recognition.onresult = (event) => this._handleResult(event);
          this.recognition.onerror = (e) => this._handleError(e);
          this.recognition.onend = () => this._handleEnd();
        } catch (e) {
          console.warn('[Speech] SpeechRecognition init failed:', e);
        }
      }
      this._loadVoices();
      if (this.synth) this.synth.onvoiceschanged = () => this._loadVoices();
      return this.speechAvailable;
    }

    _handleResult(event) {
      console.log('[Speech] onresult, resultIndex:', event.resultIndex, 'results.length:', event.results.length);
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const result = event.results[i];
        for (let j = 0; j < result.length; j++) {
          const hyp = {
            transcript: result[j].transcript,
            confidence: result[j].confidence,
            isFinal: result.isFinal,
            resultIndex: i,
            altIndex: j,
            time: Date.now(),
          };
          if (containsLatin(hyp.transcript)) { hyp.filtered = true; hyp.filterReason = 'латиница'; }
          else if (!containsCyrillic(hyp.transcript)) { hyp.filtered = true; hyp.filterReason = 'нет кириллицы'; }

          const existingIdx = this.currentHypotheses.findIndex(
            h => h.resultIndex === hyp.resultIndex && h.altIndex === hyp.altIndex
          );
          if (existingIdx >= 0) this.currentHypotheses[existingIdx] = hyp;
          else this.currentHypotheses.push(hyp);

          console.log('[Speech] гипотеза:', hyp.transcript, 'final:', hyp.isFinal,
            'conf:', hyp.confidence, hyp.filtered ? '[фильтр: ' + hyp.filterReason + ']' : '');
        }
      }
      if (this.onHypothesisUpdate) this.onHypothesisUpdate([...this.currentHypotheses]);
    }

    _handleError(e) {
      console.warn('[Speech] error:', e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.micBlocked = true;
        this.micBlockReason = 'Доступ запрещён (' + e.error + ')';
      }
      if (this.isListeningNow) {
        this.isListeningNow = false;
        if (this.onListeningStopped) this.onListeningStopped([...this.currentHypotheses]);
      }
    }

    _handleEnd() {
      console.log('[Speech] onend, гипотез:', this.currentHypotheses.length);
      if (this.isListeningNow) {
        this.isListeningNow = false;
        if (this.onListeningStopped) this.onListeningStopped([...this.currentHypotheses]);
      }
    }

    _loadVoices() {
      if (!this.synth) return;
      try {
        this.allVoices = this.synth.getVoices();
        if (!this._userPicked) {
          // Приятный мягкий женский русский голос — из коробки лучшие эвристики имён
          this.voice = this.allVoices.find(v => v.lang.startsWith('ru') && /female|milena|alena|irina|katya|tatyana|svetlana/i.test(v.name))
                    || this.allVoices.find(v => v.lang.startsWith('ru')) || null;
        }
        if (this.onVoicesLoaded) this.onVoicesLoaded(this.allVoices);
      } catch (e) { /* голоса ещё не готовы — придут через onvoiceschanged */ }
    }

    setVoiceByIndex(idx) {
      if (idx < 0 || idx >= this.allVoices.length) {
        this._userPicked = false;
        this.voice = this.allVoices.find(v => v.lang.startsWith('ru')) || null;
      } else {
        this._userPicked = true;
        this.voice = this.allVoices[idx];
      }
    }

    async requestMicPermission() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.micBlocked = true;
        this.micBlockReason = 'getUserMedia не поддерживается';
        return false;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        this.micGranted = true;
        this.micBlocked = false;
        return true;
      } catch (e) {
        this.micGranted = false;
        this.micBlocked = true;
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') this.micBlockReason = 'Отклонено или заблокировано политикой';
        else if (e.name === 'NotFoundError') this.micBlockReason = 'Микрофон не найден';
        else if (e.name === 'NotReadableError') this.micBlockReason = 'Микрофон занят';
        else this.micBlockReason = e.message || String(e);
        return false;
      }
    }

    startListening() {
      if (!this.recognition) return false;
      if (this.isListeningNow) return false;
      if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
      this.currentHypotheses = [];
      this.isListeningNow = true;
      try {
        this.recognition.start();
        console.log('[Speech] start() called');
        return true;
      } catch (e) {
        console.warn('[Speech] start() failed:', e);
        this.isListeningNow = false;
        return false;
      }
    }

    /** Отложенный stop(): 500 мс, чтобы recognition отдал последние interim-гипотезы. */
    stopListening() {
      if (!this.recognition) return;
      if (!this.isListeningNow) return;
      if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
      console.log('[Speech] stop() scheduled in 500ms');
      this.stopTimer = setTimeout(() => {
        console.log('[Speech] stop() executing');
        try {
          this.recognition.stop();
        } catch (e) {
          console.warn('[Speech] stop() failed, trying abort:', e);
          try { this.recognition.abort(); } catch (e2) { /* noop */ }
          this.isListeningNow = false;
          if (this.onListeningStopped) this.onListeningStopped([...this.currentHypotheses]);
        }
        this.stopTimer = null;
      }, 500);
    }

    /** Против побуквенного чтения TTS: lowercase + переопределения (акут/ъ). */
    _ttsPrepare(text) {
      const t = String(text).toLowerCase();
      return TTS_OVERRIDES[t] || t;
    }

    speak(text) {
      return new Promise((resolve) => {
        if (!this.synth) return resolve();
        try { this.synth.cancel(); } catch (e) { /* noop */ }
        const u = new SpeechSynthesisUtterance(this._ttsPrepare(text));
        u.lang = 'ru-RU';
        u.rate = 0.6;
        u.pitch = 1.15;
        u.volume = 0.95;
        if (this.voice) u.voice = this.voice;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        this.synth.speak(u);
      });
    }
  }

  WebSpeechAdapter.TTS_OVERRIDES = TTS_OVERRIDES;

  if (typeof module === 'object' && module.exports) module.exports = WebSpeechAdapter;
  root.WebSpeechAdapter = WebSpeechAdapter;
})(typeof self !== 'undefined' ? self : this);
