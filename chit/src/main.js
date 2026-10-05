/**
 * main.js — точка входа ядра (без DOM).
 * Собирает SyllableLoader + BlockSession + хранилище статистики/позиции в единый
 * Core, который UI (app.js) использует через события-колбэки.
 *
 * Domain и Data слои не знают, где запущены: здесь нет обращений к document/window.
 * Хранилище инжектируется (localStorage-адаптер в браузере, Map в тестах).
 */

(function (root, factory) {
  const SyllableLoader = (typeof module === 'object' && module.exports)
    ? require('./domain/SyllableLoader.js')
    : root.SyllableLoader;
  const BlockSession = (typeof module === 'object' && module.exports)
    ? require('./domain/BlockSession.js')
    : root.BlockSession;

  if (typeof module === 'object' && module.exports) {
    module.exports = factory(SyllableLoader, BlockSession);
  } else {
    root.ChitCore = factory(SyllableLoader, BlockSession);
  }
})(typeof self !== 'undefined' ? self : this, function (SyllableLoader, BlockSession) {
  'use strict';

  const KEYS = { stats: 'rt_stats', pos: 'rt_pos' };

  /** Адаптер хранилища поверх любого KV-объекта (localStorage / MemoryStore). */
  class Store {
    constructor(backend) { this.backend = backend; }

    static isAvailable(backend) {
      try {
        const k = '__chit_test__';
        backend.setItem(k, '1');
        backend.removeItem(k);
        return true;
      } catch (e) { return false; }
    }

    load(key, def) {
      try { return JSON.parse(this.backend.getItem(key)) || def; }
      catch (e) { return def; }
    }

    save(key, value) {
      try { this.backend.setItem(key, JSON.stringify(value)); }
      catch (e) { /* квота/заблокировано — молча деградируем */ }
    }

    resetProgress() {
      try {
        this.backend.removeItem(KEYS.stats);
        this.backend.removeItem(KEYS.pos);
      } catch (e) {}
    }
  }

  /** In-memory хранилище для тестов и сред без localStorage. */
  class MemoryStore {
    constructor() { this._m = new Map(); }
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
    setItem(k, v) { this._m.set(k, String(v)); }
    removeItem(k) { this._m.delete(k); }
  }

  /**
   * Чит-ядро: данные → позиция → сессия блока → глобальная статистика.
   * @param {object} opts — { data?, store?, loader? }
   *   data   — уже загруженный объект syllables.json (тогда loader не нужен);
   *   store  — KV-бэкенд (по умолчанию MemoryStore);
   *   loader — экземпляр SyllableLoader для асинхронной загрузки.
   */
  class ChitCore {
    constructor(opts = {}) {
      this.store = new Store(opts.store || new MemoryStore());
      this.storageAvailable = Store.isAvailable(this.store.backend);
      this.loader = opts.loader || null;
      this.data = opts.data ? SyllableLoader.fromObject(opts.data) : null;
      this.session = null;
      this.currentSyllable = null;
      this.globalStats = this.storageAvailable ? this.store.load(KEYS.stats, {}) : {};
      this.pos = this.storageAvailable ? this.store.load(KEYS.pos, { level: 0, block: 0 }) : { level: 0, block: 0 };
      // Колбэки для UI: onEvent(name, payload)
      this.onEvent = null;
    }

    async loadData() {
      if (this.data) return this.data;
      if (!this.loader) throw new Error('ChitCore: не заданы ни data, ни loader');
      this.data = await this.loader.load();
      return this.data;
    }

    _emit(name, payload) { if (this.onEvent) this.onEvent(name, payload || {}); }

    currentBlock() {
      if (!this.data) return null;
      const level = this.data.levels[this.pos.level];
      if (!level) return null;
      return level.blocks[this.pos.block] || null;
    }

    /** Начинает блок на текущей позиции; при необходимости продвигает позицию. */
    startBlock() {
      if (!this.data) throw new Error('ChitCore: данные не загружены');
      const levels = this.data.levels;
      // Позиция за пределами данных = все уровни пройдены → цикл начинается заново
      if (this.pos.level >= levels.length) {
        this.pos = { level: 0, block: 0 };
        this._emit('all-complete');
        return null;
      }
      let level = levels[this.pos.level];
      if (this.pos.block >= level.blocks.length) {
        this.pos.level++; this.pos.block = 0;
        if (this.pos.level >= levels.length) {
          this.pos = { level: 0, block: 0 };
          this._emit('all-complete');
          return null;
        }
        return this.startBlock();
      }
      level = levels[this.pos.level];
      const block = level.blocks[this.pos.block];
      this.session = new BlockSession(block.syllables);
      this.currentSyllable = this.session.getNextSyllable();
      this._emit('block-start', { level, block, session: this.session });
      this._emit('syllable', { syllable: this.currentSyllable });
      return { level, block, session: this.session };
    }

    /**
     * Обрабатывает результат сопоставления гипотез с целевым слогом.
     * @param {?object} match — результат findMatchInHypotheses (null = ошибка)
     * @returns {{kind:'correct'|'error'|'letters'|'skip', finished:boolean, summary:object}}
     */
    submitMatch(match) {
      if (!this.session || !this.currentSyllable) return null;
      const syl = this.currentSyllable;
      let kind;
      if (match && match.type === 'letters') {
        this.session.recordLetter(syl);
        this.saveStat(syl, false, 'letters');
        kind = 'letters';
      } else if (match) {
        this.session.record(syl, true);
        this.saveStat(syl, true);
        kind = 'correct';
      } else {
        this.session.record(syl, false);
        this.saveStat(syl, false);
        kind = 'error';
      }
      return this._afterAttempt(kind);
    }

    /** Ручное «пропустить» (кнопка для ребёнка/родителя). */
    skip() {
      if (!this.session || !this.currentSyllable) return null;
      const syl = this.currentSyllable;
      this.session.record(syl, false);
      this.saveStat(syl, false);
      return this._afterAttempt('skip');
    }

    _afterAttempt(kind) {
      const finished = this.session.isBlockComplete();
      const summary = this.session.getSummary();
      this._emit('attempt', { kind, syllable: this.currentSyllable, summary, states: this.session.getSyllableStates() });
      if (finished) {
        this.completeBlock();
      } else {
        this.currentSyllable = this.session.getNextSyllable();
        if (!this.currentSyllable) { this.completeBlock(); }
        else this._emit('syllable', { syllable: this.currentSyllable });
      }
      return { kind, finished, summary };
    }

    completeBlock() {
      const summary = this.session.getSummary();
      this.pos.block++;
      const level = this.data.levels[this.pos.level];
      if (level && this.pos.block >= level.blocks.length) { this.pos.level++; this.pos.block = 0; }
      if (this.storageAvailable) this.store.save(KEYS.pos, this.pos);
      this._emit('block-complete', { summary, pos: { ...this.pos } });
      return summary;
    }

    nextBlock() { return this.startBlock(); }

    saveStat(syllable, ok, kind) {
      if (!this.storageAvailable) return;
      const block = this.currentBlock();
      const blockId = block ? block.id : 'unknown';
      if (!this.globalStats[blockId]) this.globalStats[blockId] = {};
      if (!this.globalStats[blockId][syllable]) {
        this.globalStats[blockId][syllable] = { errors: 0, correct: 0, letterErrors: 0 };
      }
      const rec = this.globalStats[blockId][syllable];
      if (kind === 'letters') rec.letterErrors++;
      else ok ? rec.correct++ : rec.errors++;
      this.store.save(KEYS.stats, this.globalStats);
    }

    /** Свод по всем блокам для экрана статистики родителя/учителя. */
    getStatsReport() {
      if (!this.data) return null;
      const rows = [];
      let total = 0, done = 0, terr = 0, tok = 0, tlet = 0;
      for (const level of this.data.levels) {
        for (const block of level.blocks) {
          total++;
          const bs = this.globalStats[block.id];
          let be = 0, bc = 0, bl = 0;
          if (bs) for (const s of Object.values(bs)) { be += s.errors; bc += s.correct; bl += s.letterErrors || 0; }
          terr += be; tok += bc; tlet += bl;
          let state = 'not-started';
          if (bc > 0) {
            const ses = new BlockSession(block.syllables);
            if (bs) for (const [s, x] of Object.entries(bs)) if (ses.stats[s]) ses.stats[s] = { ...x };
            state = ses.isBlockComplete() ? 'done' : 'in-progress';
            if (state === 'done') done++;
          }
          rows.push({ levelTitle: level.title, blockId: block.id, letters: block.letters, correct: bc, errors: be, letterErrors: bl, state });
        }
      }
      const accuracy = tok + terr > 0 ? Math.round(tok / (tok + terr) * 100) : 0;
      return { total, done, errors: terr, correct: tok, letterErrors: tlet, accuracy, rows };
    }

    resetProgress() {
      this.globalStats = {};
      this.pos = { level: 0, block: 0 };
      if (this.storageAvailable) this.store.resetProgress();
      this._emit('reset');
    }
  }

  ChitCore.Store = Store;
  ChitCore.MemoryStore = MemoryStore;
  ChitCore.KEYS = KEYS;
  return ChitCore;
});
