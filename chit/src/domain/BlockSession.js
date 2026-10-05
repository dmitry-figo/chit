/**
 * BlockSession.js — логика прохождения тренировочного блока слогов (слой Domain).
 * Чистый JS, без DOM. Правила:
 *  - взвешенный выбор слога: вес = 1 + N·k (N — число ошибок, k ≈ 2);
 *  - блок закрыт, когда для каждого слога correct >= max(minCorrect, correctMult·errors);
 *  - побуквенное чтение («эм-а» вместо «АМ») — отдельный класс ошибки (letterErrors),
 *    тоже утяжеляющий взвешенный выбор.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();          // Node.js / tests
  } else {
    root.BlockSession = factory();       // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- Нормализация и сравнение (без DOM) ---------- */

  function containsLatin(text) { return /[a-zA-Z]/.test(text); }
  function containsCyrillic(text) { return /[а-яёА-ЯЁ]/.test(text); }

  /** Нормализация для сравнения: lowercase, Ё→Е, удаление пробелов/дефисов/точек, только кириллица. */
  function normalizeForComparison(text) {
    return String(text).toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[\s\-\.]/g, '')
      .replace(/[^а-я]/g, '');
  }

  /** Расстояние Левенштейна. */
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]);
      }
    }
    return dp[m][n];
  }

  /* ---------- Детектор побуквенного чтения ---------- */

  // Названия букв (алфавит приложения + запас)
  const LETTER_NAMES = {
    'а': 'а', 'о': 'о', 'у': 'у', 'э': 'э', 'ы': 'ы', 'и': 'и', 'й': 'й', 'я': 'я', 'е': 'е', 'ё': 'ё', 'ю': 'ю',
    'м': 'эм', 'т': 'тэ', 'н': 'эн', 'к': 'ка', 'л': 'эль', 'с': 'эс', 'р': 'эр',
    'б': 'бэ', 'в': 'вэ', 'г': 'гэ', 'д': 'дэ', 'ж': 'жэ', 'з': 'зэ', 'п': 'пэ', 'ф': 'эф',
    'х': 'ха', 'ч': 'че', 'ш': 'ша', 'щ': 'ща', 'ь': ''
  };

  /**
   * Детектор побуквенного чтения: «а-эм» / «эм-а» для слога АМ и т.п.
   * @returns {boolean}
   */
  function detectLetterReading(targetSyllable, transcript) {
    const norm = normalizeForComparison(transcript); // «а-эм» → «аэм»
    if (!norm) return false;
    const letters = String(targetSyllable).toLowerCase().replace(/ь/g, '').split('');
    const names = letters.map(l => LETTER_NAMES[l] ?? l);
    const forms = [names.join(''), [...names].reverse().join('')];
    // Маркеры названий согласных: «эм», «эн», «эс», «эль», «эр» — без них «ам» ≠ «аэм»
    const hasNameMarker = /э|ль/.test(norm);
    return forms.some(f => norm === f ||
      (hasNameMarker && Math.abs(norm.length - f.length) <= 1 && levenshtein(norm, f) <= 1));
  }

  /**
   * Поиск совпадения целевого слога среди сырых гипотез распознавания.
   * Отсекает латиницу и безкирилличные гипотезы (помечает их filtered).
   * @param {string} targetSyllable
   * @param {Array<{transcript:string, filtered?:boolean, filterReason?:string}>} hypotheses
   * @returns {?{type:'exact'|'letters'|'truncated'|'phonetic', hypothesis:object, matchText:string}}
   */
  function findMatchInHypotheses(targetSyllable, hypotheses) {
    const target = normalizeForComparison(targetSyllable);
    for (const hyp of hypotheses) {
      if (containsLatin(hyp.transcript)) { hyp.filtered = true; hyp.filterReason = 'латиница'; continue; }
      if (!containsCyrillic(hyp.transcript)) { hyp.filtered = true; hyp.filterReason = 'нет кириллицы'; continue; }
      const transcript = normalizeForComparison(hyp.transcript);
      if (!transcript) { hyp.filtered = true; hyp.filterReason = 'пусто'; continue; }
      if (transcript === target) return { type: 'exact', hypothesis: hyp, matchText: transcript };
      if (detectLetterReading(targetSyllable, hyp.transcript))
        return { type: 'letters', hypothesis: hyp, matchText: transcript };
      if (transcript.startsWith(target) && transcript.length <= target.length + 2)
        return { type: 'truncated', hypothesis: hyp, matchText: transcript };
      const dist = levenshtein(target, transcript);
      const allowed = target.length <= 3 ? 1 : 2;
      if (dist <= allowed) return { type: 'phonetic', hypothesis: hyp, matchText: transcript };
    }
    return null;
  }

  /* ---------- Сессия блока ---------- */

  class BlockSession {
    /**
     * @param {string[]} syllables — слоги блока (порядок задан методистом в JSON)
     * @param {object} [opts] — { errorWeight=k≈2, minCorrect=2, correctMult=2, rng }
     */
    constructor(syllables, opts = {}) {
      if (!Array.isArray(syllables) || syllables.length === 0) {
        throw new Error('BlockSession: нужен непустой массив слогов');
      }
      this.syllables = syllables.slice();
      this.stats = {};
      for (const s of this.syllables) this.stats[s] = { errors: 0, correct: 0, letterErrors: 0 };
      this.errorWeight = opts.errorWeight || 2;   // k ≈ 2 из методики
      this.minCorrect = opts.minCorrect || 2;     // минимум 2 верных
      this.correctMult = opts.correctMult || 2;   // correct >= 2·errors
      this._rng = opts.rng || Math.random;
    }

    /** Взвешенный случайный выбор следующего непройденного слога. */
    getNextSyllable() {
      const pending = this.syllables.filter(s => !this.isComplete(s));
      if (!pending.length) return null;
      const weights = pending.map(s => 1 + (this.stats[s].errors + this.stats[s].letterErrors) * this.errorWeight);
      const total = weights.reduce((a, b) => a + b, 0);
      let r = this._rng() * total;
      for (let i = 0; i < pending.length; i++) {
        r -= weights[i];
        if (r <= 0) return pending[i];
      }
      return pending[pending.length - 1];
    }

    record(syllable, ok) {
      const st = this.stats[syllable];
      if (!st) throw new Error(`BlockSession: неизвестный слог «${syllable}»`);
      ok ? st.correct++ : st.errors++;
    }

    recordLetter(syllable) {
      const st = this.stats[syllable];
      if (!st) throw new Error(`BlockSession: неизвестный слог «${syllable}»`);
      st.letterErrors++;
    }

    /** Правило завершения по слогу: correct >= max(minCorrect, correctMult·errors). */
    isComplete(syllable) {
      const st = this.stats[syllable];
      if (!st) return false;
      return st.correct >= Math.max(this.minCorrect, this.correctMult * st.errors);
    }

    isBlockComplete() {
      return this.syllables.every(s => this.isComplete(s));
    }

    getSummary() {
      const values = Object.values(this.stats);
      return {
        total: this.syllables.length,
        done: this.syllables.filter(s => this.isComplete(s)).length,
        errors: values.reduce((a, s) => a + s.errors, 0),
        letterErrors: values.reduce((a, s) => a + s.letterErrors, 0),
        correct: values.reduce((a, s) => a + s.correct, 0),
      };
    }

    /** Индикаторы прогресса по каждому слогу (для полоски под слогом). */
    getSyllableStates() {
      return this.syllables.map(s => {
        const st = this.stats[s];
        let state = 'new';
        if (this.isComplete(s)) state = 'done';
        else if (st.errors > 1) state = 'trouble';
        else if (st.correct > 0 || st.errors > 0 || st.letterErrors > 0) state = 'in-progress';
        return { syllable: s, state, ...st };
      });
    }
  }

  BlockSession.containsLatin = containsLatin;
  BlockSession.containsCyrillic = containsCyrillic;
  BlockSession.normalizeForComparison = normalizeForComparison;
  BlockSession.levenshtein = levenshtein;
  BlockSession.detectLetterReading = detectLetterReading;
  BlockSession.findMatchInHypotheses = findMatchInHypotheses;
  BlockSession.LETTER_NAMES = LETTER_NAMES;
  return BlockSession;
});
