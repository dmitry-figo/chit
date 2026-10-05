/**
 * domain.test.js — тесты ядра (Domain + Data). Запуск: npm test
 * Формат CommonJS (.cjs) — чтобы работать и при "type":"module" в package.json.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SyllableLoader = require('../src/domain/SyllableLoader.js');
const BlockSession = require('../src/domain/BlockSession.js');
const ChitCore = require('../src/main.js');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

(async function main() {
  /* ==================== SyllableLoader ==================== */

  console.log('\nSyllableLoader');

  const REAL_DATA_PATH = path.join(__dirname, '..', 'data', 'syllables.json');

  test('валидный syllables.json загружается и содержит ожидаемые уровни/блоки', () => {
    const raw = JSON.parse(fs.readFileSync(REAL_DATA_PATH, 'utf8'));
    const data = SyllableLoader.fromObject(raw);
    assert.ok(Array.isArray(data.levels));
    assert.strictEqual(SyllableLoader.validate(raw).length, 0, 'не должно быть ошибок валидации реального файла');
    const blocks = SyllableLoader.flattenLevels(data);
    assert.ok(blocks.length >= 20, 'ожидаем не менее 20 блоков');
    const b11 = blocks.find(b => b.id === '1.1');
    assert.deepStrictEqual(b11.syllables, ['МА', 'АМ', 'АМА', 'МАА']);
    assert.deepStrictEqual(b11.letters, ['М', 'А']);
  });

  test('meta присутствует в файле настроек (служебное описание для методиста)', () => {
    const raw = JSON.parse(fs.readFileSync(REAL_DATA_PATH, 'utf8'));
    assert.ok(raw.meta && typeof raw.meta.app === 'string');
  });

  test('отклоняет данные без levels', () => {
    assert.throws(() => SyllableLoader.fromObject({}), /levels/);
  });

  test('отклоняет блок с пустым списком слогов', () => {
    assert.throws(() => SyllableLoader.fromObject({
      levels: [{ title: 'X', blocks: [{ id: '1.1', letters: ['М'], syllables: [] }] }],
    }), /syllables/);
  });

  test('отклоняет слог с латиницей', () => {
    assert.throws(() => SyllableLoader.fromObject({
      levels: [{ title: 'X', blocks: [{ id: '1.1', letters: ['М'], syllables: ['MA'] }] }],
    }), /кириллическ/);
  });

  test('отклоняет дублирующиеся id блоков', () => {
    assert.throws(() => SyllableLoader.fromObject({
      levels: [{ title: 'X', blocks: [
        { id: '1.1', letters: ['М'], syllables: ['МА'] },
        { id: '1.1', letters: ['О'], syllables: ['МО'] },
      ] }],
    }), /дублирующ/);
  });

  await testAsync('load() через fetch-адаптер возвращает валидированные данные', async () => {
    const raw = JSON.parse(fs.readFileSync(REAL_DATA_PATH, 'utf8'));
    const fakeFetch = async (url) => ({ ok: true, status: 200, json: async () => raw });
    const loader = new SyllableLoader('/data/syllables.json', { fetchImpl: fakeFetch });
    const data = await loader.load();
    assert.ok(data.levels.length > 0);
  });

  await testAsync('load() бросает ошибку при HTTP-ошибке', async () => {
    const fakeFetch = async () => ({ ok: false, status: 404 });
    const loader = new SyllableLoader('/missing.json', { fetchImpl: fakeFetch });
    await assert.rejects(() => loader.load(), /HTTP 404/);
  });

  /* ==================== BlockSession ==================== */

  console.log('\nBlockSession');

  test('правило завершения: correct >= max(2, 2·errors)', () => {
    const s = new BlockSession(['МА', 'АМ']);
    s.record('МА', true);
    assert.strictEqual(s.isComplete('МА'), false, '1 верного мало');
    s.record('МА', true);
    assert.strictEqual(s.isComplete('МА'), true, '2 верных достаточно');
    s.record('МА', false); // errors=1 → нужно correct>=2 уже выполнено? max(2,2)=2, correct=2 → да
    assert.strictEqual(s.isComplete('МА'), true);
    s.record('МА', false); // errors=2 → нужно correct>=4
    assert.strictEqual(s.isComplete('МА'), false, 'при 2 ошибках надо 4 верных');
  });

  test('блок завершён, когда все слоги прошли правило', () => {
    const s = new BlockSession(['МА', 'АМ']);
    for (const syl of s.syllables) { s.record(syl, true); s.record(syl, true); }
    assert.strictEqual(s.isBlockComplete(), true);
    assert.strictEqual(s.getNextSyllable(), null, 'после закрытия блока слоги не выдаются');
  });

  test('взвешенный выбор: слог с N ошибками всплывает чаще (вес 1+N·k)', () => {
    // Детерминированная проверка кумулятивного выбора: веса [МА=5, АМ=1, УМ=1], total=7
    const det = (r) => {
      const rs = new BlockSession(['МА', 'АМ', 'УМ'], { errorWeight: 2, rng: () => r });
      rs.record('МА', false); rs.record('МА', false); // у МА две ошибки → вес 1+2*2=5
      return rs.getNextSyllable();
    };
    assert.strictEqual(det(0.1), 'МА', 'малый r выбирает тяжёлый проблемный слог');
    assert.strictEqual(det(6.3 / 7), 'УМ'); // хвостовой интервал — fallback на последний непройденный

    // Статистическая проверка: при равных шансах ошибочный слог выпадает заметно чаще
    const s2 = new BlockSession(['МА', 'АМ'], { errorWeight: 2 });
    s2.record('МА', false); s2.record('МА', false); // МА вес 5, АМ вес 1
    let maCount = 0;
    for (let i = 0; i < 2000; i++) if (s2.getNextSyllable() === 'МА') maCount++;
    assert.ok(maCount > 2000 * 0.6, `ожидали >60% выбросов МА, получили ${(maCount / 20).toFixed(1)}%`);
  });

  test('побуквенное чтение учитывается в весе (letterErrors)', () => {
    const s = new BlockSession(['МА', 'АМ']);
    s.recordLetter('АМ');
    assert.strictEqual(s.stats['АМ'].letterErrors, 1);
    assert.strictEqual(s.isComplete('АМ'), false, 'побуквенное не считается верным');
  });

  test('getSummary агрегирует статистику', () => {
    const s = new BlockSession(['МА', 'АМ']);
    s.record('МА', true); s.record('МА', false); s.recordLetter('АМ');
    const sum = s.getSummary();
    assert.strictEqual(sum.total, 2);
    assert.strictEqual(sum.correct, 1);
    assert.strictEqual(sum.errors, 1);
    assert.strictEqual(sum.letterErrors, 1);
  });

  test('record бросает ошибку на неизвестный слог', () => {
    const s = new BlockSession(['МА']);
    assert.throws(() => s.record('БХ', true), /неизвестный слог/);
  });

  test('getSyllableStates возвращает состояния всех слогов', () => {
    const s = new BlockSession(['МА', 'АМ', 'УМ']);
    s.record('МА', true); s.record('МА', true);
    s.record('АМ', false); s.record('АМ', false);
    const states = Object.fromEntries(s.getSyllableStates().map(x => [x.syllable, x.state]));
    assert.strictEqual(states['МА'], 'done');
    assert.strictEqual(states['АМ'], 'trouble');
    assert.strictEqual(states['УМ'], 'new');
  });

  /* ==================== Сравнение гипотез ==================== */

  console.log('\nСравнение/нормализация гипотез');

  test('normalizeForComparison: lowercase, Ё→Е, удаление мусора', () => {
    const n = BlockSession.normalizeForComparison;
    assert.strictEqual(n(' МЁД '), 'мед');
    assert.strictEqual(n('ма-а!'), 'маа');
  });

  test('exact: точное совпадение после нормализации', () => {
    const m = BlockSession.findMatchInHypotheses('МА', [{ transcript: ' ма' }]);
    assert.strictEqual(m.type, 'exact');
  });

  test('латиница отсекается как класс гипотез', () => {
    const hyps = [{ transcript: 'ma' }, { transcript: 'ма' }];
    const m = BlockSession.findMatchInHypotheses('МА', hyps);
    assert.strictEqual(hyps[0].filtered, true);
    assert.strictEqual(hyps[0].filterReason, 'латиница');
    assert.strictEqual(m.type, 'exact');
  });

  test('phonetic: близкое расстояние Левенштейна засчитывается', () => {
    const m = BlockSession.findMatchInHypotheses('МА', [{ transcript: 'мо' }]);
    assert.strictEqual(m.type, 'phonetic');
  });

  test('truncated: «мама» при целевом «ма» — начало совпадает', () => {
    const m = BlockSession.findMatchInHypotheses('МА', [{ transcript: 'мам' }]);
    assert.ok(['truncated', 'phonetic', 'exact'].includes(m.type));
  });

  test('letters: «эм-а» детектируется как побуквенное чтение слога АМ', () => {
    assert.strictEqual(BlockSession.detectLetterReading('АМ', 'эм-а'), true);
    assert.strictEqual(BlockSession.detectLetterReading('АМ', 'а-эм'), true);
    assert.strictEqual(BlockSession.detectLetterReading('АМ', 'ам'), false, 'обычное «ам» — не побуквенное');
    const m = BlockSession.findMatchInHypotheses('АМ', [{ transcript: 'а эм' }]);
    assert.strictEqual(m.type, 'letters');
  });

  test('пустые/безкирилличные гипотезы помечаются filtered', () => {
    const hyps = [{ transcript: '   ' }, { transcript: '!!!' }];
    const m = BlockSession.findMatchInHypotheses('МА', hyps);
    assert.strictEqual(m, null);
    assert.strictEqual(hyps[0].filtered, true);
    assert.strictEqual(hyps[1].filtered, true);
  });

  /* ==================== ChitCore (main.js) ==================== */

  console.log('\nChitCore (точка входа ядра)');

  const miniData = {
    meta: { app: 'test' },
    levels: [
      { id: 1, title: 'Уровень 1', blocks: [
        { id: '1.1', letters: ['М', 'А'], syllables: ['МА', 'АМ'] },
        { id: '1.2', letters: ['М', 'О'], syllables: ['МО'] },
      ]},
      { id: 2, title: 'Уровень 2', blocks: [
        { id: '2.1', letters: ['Т', 'А'], syllables: ['ТА'] },
      ]},
    ],
  };

  test('старт блока создаёт сессию и выдаёт слог', () => {
    const core = new ChitCore({ data: miniData });
    const info = core.startBlock();
    assert.strictEqual(info.block.id, '1.1');
    assert.ok(core.currentSyllable);
    assert.ok(['МА', 'АМ'].includes(core.currentSyllable));
  });

  test('прохождение блока двигает позицию и пишет статистику', () => {
    const store = new ChitCore.MemoryStore();
    const core = new ChitCore({ data: miniData, store });
    const events = [];
    core.onEvent = (name, p) => events.push({ name, p });

    // Блок 1.1: МА и АМ — по 2 верных each
    core.startBlock();
    const exact = (syl) => ({ type: 'exact', hypothesis: { transcript: syl.toLowerCase() }, matchText: syl.toLowerCase() });
    let guard = 0;
    while (core.session && !core.session.isBlockComplete() && guard++ < 50) {
      core.submitMatch(exact(core.currentSyllable));
    }
    assert.ok(events.some(e => e.name === 'block-complete'), 'должно быть событие block-complete');
    assert.deepStrictEqual(core.pos, { level: 0, block: 1 }, 'позиция продвинута к блоку 1.2');

    const report = core.getStatsReport();
    assert.strictEqual(report.done, 1);
    assert.strictEqual(report.rows.find(r => r.blockId === '1.1').state, 'done');

    // Сохранено в персистентном хранилище
    const restored = new ChitCore({ data: miniData, store });
    assert.deepStrictEqual(restored.pos, { level: 0, block: 1 }, 'позиция восстановлена из storage');
    assert.ok(Object.keys(restored.globalStats).length > 0, 'статистика восстановлена из storage');
  });

  test('ошибка и побуквенное чтение различаются в статистике', () => {
    const core = new ChitCore({ data: miniData });
    core.startBlock();
    const syl = core.currentSyllable;
    core.submitMatch(null); // ошибка
    assert.strictEqual(core.globalStats['1.1'][syl].errors, 1);
    core.submitMatch({ type: 'letters', hypothesis: {}, matchText: 'эм а' }); // побуквенно
    assert.strictEqual(core.globalStats['1.1'][syl].letterErrors, 1);
    core.submitMatch({ type: 'exact', hypothesis: {}, matchText: syl.toLowerCase() });
    assert.strictEqual(core.globalStats['1.1'][syl].correct, 1);
  });

  test('skip помечает слог ошибкой и не блокирует продолжение', () => {
    const core = new ChitCore({ data: { meta: {}, levels: [{ id: 1, title: 'L', blocks: [{ id: '1.1', letters: ['М'], syllables: ['МА'] }] }] } });
    core.startBlock();
    const res = core.skip();
    assert.strictEqual(res.kind, 'skip');
    assert.strictEqual(res.finished, false, 'после пропуска блок не закрыт (нужны 2 верных)');
  });

  test('последний блок последнего уровня → сброс позиции и all-complete', () => {
    const oneLevelData = { meta: {}, levels: [{ id: 1, title: 'L', blocks: [{ id: '1.1', letters: ['М'], syllables: ['МА'] }] }] };
    const core = new ChitCore({ data: oneLevelData });
    const events = [];
    core.onEvent = (n) => events.push(n);
    core.startBlock();
    core.completeBlock(); // блок пройден «руками» теста
    assert.deepStrictEqual(core.pos, { level: 1, block: 0 });
    const again = core.startBlock();
    assert.strictEqual(again, null);
    assert.ok(events.includes('all-complete'));
    assert.deepStrictEqual(core.pos, { level: 0, block: 0 }, 'цикл начинается заново');
  });

  test('resetProgress очищает статистику и позицию', () => {
    const store = new ChitCore.MemoryStore();
    const core = new ChitCore({ data: miniData, store });
    core.startBlock();
    core.submitMatch({ type: 'exact', hypothesis: {}, matchText: 'ма' });
    core.resetProgress();
    assert.deepStrictEqual(core.globalStats, {});
    assert.deepStrictEqual(core.pos, { level: 0, block: 0 });
    const revived = new ChitCore({ data: miniData, store });
    assert.deepStrictEqual(revived.globalStats, {});
  });

  /* ==================== Итог ==================== */

  console.log(`\nИтог: ${passed} прошло, ${failed} упало.`);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log('ALL TESTS PASSED ✅');
  }
})();
