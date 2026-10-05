/**
 * SyllableLoader.js — загрузка данных о тренировочных слогах (слой Data/Domain).
 * Загружает и валидирует syllables.json. Не зависит от DOM.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();          // Node.js / tests
  } else {
    root.SyllableLoader = factory();     // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function validateSyllablesData(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return ['syllables.json: корень документа должен быть объектом'];
    }
    if (!Array.isArray(data.levels) || data.levels.length === 0) {
      errors.push('syllables.json: отсутствует массив levels');
      return errors;
    }
    const seenBlockIds = new Set();
    data.levels.forEach((level, li) => {
      if (!level || typeof level.title !== 'string') {
        errors.push(`level[${li}]: отсутствует title`);
      }
      if (!Array.isArray(level.blocks) || level.blocks.length === 0) {
        errors.push(`level[${li}] (${level.title || '?'}): отсутствует массив blocks`);
        return;
      }
      level.blocks.forEach((block, bi) => {
        const where = `level[${li}].blocks[${bi}]${block && block.id ? ' (' + block.id + ')' : ''}`;
        if (!block || typeof block.id !== 'string' || !block.id) {
          errors.push(`${where}: отсутствует id блока`);
        } else if (seenBlockIds.has(block.id)) {
          errors.push(`${where}: дублирующийся id блока`);
        } else {
          seenBlockIds.add(block.id);
        }
        if (!Array.isArray(block.letters) || block.letters.length === 0) {
          errors.push(`${where}: отсутствует «гнездо» букв (letters)`);
        }
        if (!Array.isArray(block.syllables) || block.syllables.length === 0) {
          errors.push(`${where}: отсутствует массив syllables`);
          return;
        }
        block.syllables.forEach((s, si) => {
          if (typeof s !== 'string' || !/^[А-ЯЁа-яё]+$/.test(s)) {
            errors.push(`${where}.syllables[${si}]: слог «${s}» должен быть непустой кириллической строкой`);
          }
        });
      });
    });
    return errors;
  }

  class SyllableLoader {
    /**
     * @param {string} url — путь к syllables.json (для браузера)
     * @param {object} [options] — { fetchImpl } для инъекции в тестах
     */
    constructor(url, options = {}) {
      this.url = url;
      this._fetch = options.fetchImpl || ((...args) => fetch(...args));
    }

    /** Асинхронная загрузка JSON по HTTP (браузер). */
    async load() {
      const resp = await this._fetch(this.url);
      if (!resp.ok) {
        throw new Error(`SyllableLoader: не удалось загрузить ${this.url} (HTTP ${resp.status})`);
      }
      const data = await resp.json();
      return SyllableLoader.fromObject(data);
    }

    /** Синхронная загрузка из уже распарсенного объекта (fallback, тесты). */
    static fromObject(data) {
      const errors = validateSyllablesData(data);
      if (errors.length) {
        throw new Error('SyllableLoader: недопустимые данные:\n  - ' + errors.join('\n  - '));
      }
      return {
        meta: data.meta || {},
        levels: data.levels.map((level) => ({
          id: level.id ?? null,
          title: level.title,
          description: level.description || level.title,
          blocks: level.blocks.map((block) => ({
            id: block.id,
            letters: block.letters.slice(),
            syllables: block.syllables.slice(),
          })),
        })),
      };
    }

    /** Плоский список всех блоков всех уровней: [{levelTitle, id, letters, syllables}] */
    static flattenLevels(data) {
      const out = [];
      for (const level of data.levels) {
        for (const block of level.blocks) {
          out.push({ levelTitle: level.title, levelId: level.id, ...block });
        }
      }
      return out;
    }
  }

  SyllableLoader.validate = validateSyllablesData;
  return SyllableLoader;
});
