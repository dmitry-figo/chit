/**
 * SpeechAdapter.js — интерфейс Speech-слоя (без реализации).
 * Любая платформа (Web Speech, Android native, iOS native) обязана предоставить адаптер
 * с этим контрактом. UI и ядро обращаются только к интерфейсу.
 *
 * События адаптера (через .on<Event> колбэки):
 *   onHypothesisUpdate(hypotheses)  — прилетели новые сырые гипотезы распознавания;
 *   onListeningStopped(hypotheses)  — прослушивание завершено (release/ошибка/конец);
 *   onVoicesLoaded(voices)          — список голосов TTS обновился.
 */
'use strict';

class SpeechAdapter {
  constructor() {
    if (new.target === SpeechAdapter) {
      throw new TypeError('SpeechAdapter — абстрактный интерфейс, используйте конкретный адаптер');
    }
    // состояние доступности (заполняется адаптером)
    this.speechAvailable = false;
    this.micGranted = false;
    this.micBlocked = false;
    this.micBlockReason = '';
    this.isListeningNow = false;
    this.currentHypotheses = [];
    // колбэки-события для UI
    this.onHypothesisUpdate = null;
    this.onListeningStopped = null;
    this.onVoicesLoaded = null;
  }

  /* ---- Обязательный контракт: каждый адаптер обязан переопределить ---- */

  init()            { throw new Error('SpeechAdapter.init() не реализован'); }
  startListening()  { throw new Error('SpeechAdapter.startListening() не реализован'); }
  stopListening()   { throw new Error('SpeechAdapter.stopListening() не реализован'); }
  speak(text)       { throw new Error('SpeechAdapter.speak() не реализован'); }        // -> Promise
  requestMicPermission() { throw new Error('SpeechAdapter.requestMicPermission() не реализован'); } // -> Promise<boolean>
  setVoiceByIndex(idx) { throw new Error('SpeechAdapter.setVoiceByIndex() не реализован'); }
}

if (typeof module === 'object' && module.exports) module.exports = SpeechAdapter;
if (typeof self !== 'undefined') self.SpeechAdapter = SpeechAdapter;
