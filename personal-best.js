/**
 * personal-best.js — Personal Best（自己ベスト）の記録・保存・表示。
 *
 * 役割の分離:
 *   game.js            → Minesweeperのゲーム本体（無変更）
 *   extras.js          → Recent Games / Feedback（無変更）
 *   theme.css / classic-theme.css → テーマ・デザイン（無変更）
 *   personal-best.js   → このファイル。自己ベストの記録・保存・表示のみ
 *
 * game.js には一切依存・干渉しない。開始/勝利の検知も #board と
 * #ms-message のDOM変化をMutationObserverで監視するだけで行っている
 * （Recent Gamesの勝利検知と同じ手法）。
 *
 * 【保存キーの構造】Mode × Difficulty で完全に分離し、Themeは無関係にする。
 *   {
 *     "classic": { "beginner": {bestMs, recordedAt}, "intermediate": {...}, "expert": {...} },
 *     "meadow":  { "beginner": {...}, "intermediate": {...}, "expert": {...} }
 *   }
 *   内部識別子 "meadow" は既存の方針通りAdventureの内部値をそのまま使う
 *   （表示名はAdventure）。Adventureの難易度は現在の対応関係
 *   （Beginner=Grassland / Intermediate=Desert / Expert=Volcanic）を
 *   そのまま利用しているだけで、マップ名を保存キーにはしていない
 *   （将来マップが変わっても壊れない）。
 *   将来 Best Today / Best This Week / Leaderboard 等を追加する場合は、
 *   各エントリに履歴配列を足す、または並列の別ストレージキーを足す形で
 *   拡張できる（既存データの形は壊さない）。
 *
 * 【タイムの計測方法】
 *   game.jsの経過時間表示（#timer-value）は1秒単位のため、1/100秒までの
 *   精度は出せない。そこでこのファイル自身が、
 *     計測開始 = 盤面のどこかのマスに最初に is-revealed が付いた瞬間
 *     計測終了 = #ms-message に is-win が付いた瞬間
 *   をそれぞれ performance.now() で記録し、その差分をタイムとして使う。
 *   game.js側のタイマーの動作・表示は一切変更していない。
 */
(function () {
  "use strict";

  const STORAGE_KEY = "ms-personal-best";

  const boardEl = document.getElementById("board");
  const messageEl = document.getElementById("ms-message");
  const pbValueEl = document.getElementById("personal-best-value");
  const pbNewEl = document.getElementById("personal-best-new");
  const pbCrownEl = document.querySelector(".personal-best-crown");

  let gameStartTime = null; // performance.now()。このラウンドがまだ始まっていなければnull
  let recorded = false; // このラウンドで既に記録済みかどうか（二重記録防止）

  /* ---------------------------------- モード・難易度の取得 ---------------------------------- */

  function currentMode() {
    const btn = document.querySelector('.pill-btn[data-mode][aria-pressed="true"]');
    return btn ? btn.dataset.mode : null;
  }

  function currentDifficulty() {
    const btn = document.querySelector('.pill-btn[data-difficulty][aria-pressed="true"]');
    return btn ? btn.dataset.difficulty : null;
  }

  /* ---------------------------------- 保存・取得 ---------------------------------- */

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveAll(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      /* localStorageが使えない環境では記録をスキップする（機能自体は壊さない） */
    }
  }

  function getBest(mode, difficulty) {
    if (!mode || !difficulty) return null;
    const data = loadAll();
    return data[mode] && data[mode][difficulty] ? data[mode][difficulty] : null;
  }

  function setBest(mode, difficulty, ms) {
    const data = loadAll();
    if (!data[mode]) data[mode] = {};
    data[mode][difficulty] = { bestMs: ms, recordedAt: Date.now() };
    saveAll(data);
  }

  /* ---------------------------------- 表示 ---------------------------------- */

  function formatMs(ms) {
    const totalCentis = Math.round(ms / 10);
    const centis = totalCentis % 100;
    const totalSeconds = Math.floor(totalCentis / 100);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60);
    return (
      String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "." + String(centis).padStart(2, "0")
    );
  }

  function renderBest() {
    if (!pbValueEl) return;
    const best = getBest(currentMode(), currentDifficulty());
    pbValueEl.textContent = best ? formatMs(best.bestMs) : "--:--";
  }

  function showNewBest(ms) {
    if (!pbNewEl) return;
    pbNewEl.textContent = "NEW PERSONAL BEST! " + formatMs(ms);
    pbNewEl.hidden = false;
    if (pbCrownEl) {
      // クラスを一旦外して再度付け直すことで、同じラウンド内で万一
      // 再トリガーされてもアニメーションが確実に再生されるようにする。
      pbCrownEl.classList.remove("is-celebrating");
      // eslint-disable-next-line no-unused-expressions
      void pbCrownEl.offsetWidth; // 強制リフローでアニメーションの再開始を保証する
      pbCrownEl.classList.add("is-celebrating");
    }
  }

  function hideNewBest() {
    if (!pbNewEl) return;
    pbNewEl.hidden = true;
    if (pbCrownEl) pbCrownEl.classList.remove("is-celebrating");
  }

  /* ---------------------------------- 計測開始の検知 ---------------------------------- */

  function hasAnyRevealedCell() {
    return boardEl.querySelector(".cell.is-revealed") !== null;
  }

  if (boardEl) {
    const boardObserver = new MutationObserver(function () {
      if (gameStartTime === null && hasAnyRevealedCell()) {
        gameStartTime = performance.now();
      }
    });
    boardObserver.observe(boardEl, { subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  /* ---------------------------------- 勝利／リセットの検知 ---------------------------------- */

  if (messageEl) {
    const messageObserver = new MutationObserver(function () {
      if (messageEl.classList.contains("is-win")) {
        if (gameStartTime !== null && !recorded) {
          recorded = true;
          const elapsedMs = performance.now() - gameStartTime;
          const mode = currentMode();
          const difficulty = currentDifficulty();
          const previous = getBest(mode, difficulty);

          if (!previous || elapsedMs < previous.bestMs) {
            setBest(mode, difficulty, elapsedMs);
            showNewBest(elapsedMs);
          }
          renderBest();
        }
      } else if (messageEl.textContent === "") {
        // init()によるリセット（リスタート／モード変更／難易度変更）。
        // Themeの切り替えはmessageEl自体に触れないため、ここは発火しない
        // （＝Personal BestはThemeに影響されない）。
        gameStartTime = null;
        recorded = false;
        hideNewBest();
        renderBest();
      }
    });
    messageObserver.observe(messageEl, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  renderBest();
})();
