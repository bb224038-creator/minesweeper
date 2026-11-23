/**
 * game.js — マインスイーパーのゲームロジック一式。
 * 盤面の生成・地雷配置・開放処理・旗・タイマー・勝敗判定と、
 * マウス（左クリック／右クリック）およびタッチ（タップ／長押し）の
 * 入力処理をまとめている。
 */
(function () {
  "use strict";

  const DIFFICULTIES = {
    beginner: { rows: 9, cols: 9, mines: 10 },
    intermediate: { rows: 16, cols: 16, mines: 40 },
    expert: { rows: 16, cols: 30, mines: 99 },
  };

  /**
   * ゲームモードごとのルール定義。
   * getSafeCells(r, c) は「初回クリック時に地雷を配置してはいけないマス」の
   * 一覧を [row, col] の配列で返す。今後モードを追加する場合はここに
   * エントリを増やすだけでよい（将来的な専用マス・イベントもこの単位で拡張できる）。
   */
  const GAME_MODES = {
    classic: {
      // 一般的なマインスイーパー：安全なのはクリックしたマス自身のみ。
      getSafeCells: function (r, c) {
        return [[r, c]];
      },
    },
    meadow: {
      // クリックしたマス＋周囲8マスを安全域とし、必ず広く開くようにする。
      getSafeCells: function (r, c) {
        const cells = [[r, c]];
        forEachNeighbor(r, c, function (nr, nc) {
          cells.push([nr, nc]);
        });
        return cells;
      },
    },
  };

  /**
   * マスに対して現在選択中のアクションを実行するための登録テーブル。
   * perform(r, c) は左クリック／タップ時に呼ばれる処理そのもの。
   * 右クリックと長押しは常に旗操作なのでここには含めない。
   * 今後アクションを増やす場合はここにエントリを追加するだけでよい。
   */
  const ACTIONS = {
    dig: {
      perform: function (r, c) {
        handleReveal(r, c);
      },
    },
    flag: {
      perform: function (r, c) {
        handleFlagToggle(r, c);
      },
    },
  };

  const TIMER_TICK_MS = 250;
  const LONG_PRESS_MS = 500;
  const MOVE_CANCEL_PX = 10;

  /* 爆発演出のタイミング定数（ms）。style.css の ms-detonate / ms-board-shake /
     ms-debris-fly の duration・delay と対応させている。 */
  const EXPLOSION_TOTAL_MS = 1300;
  const EXPLOSION_SHAKE_DELAY_MS = 350;
  const EXPLOSION_SHAKE_DURATION_MS = 380;
  const DEBRIS_DELAY_MS = 340;
  const DEBRIS_COUNT = 12;
  const DEBRIS_SMOKE_COUNT = 3;
  const DEBRIS_COLORS = ["#6b4f37", "#8a6a4a", "#4f7d52", "#c9c2b8"]; // 土(濃/淡)・草・砂ぼこり

  /* セルサイズ計算用の定数。desktopでの上限は style.css の
     .board[data-difficulty="..."] と対応させている。 */
  const MAX_CELL_SIZE = { beginner: 42, intermediate: 32, expert: 26 };
  const MIN_CELL_SIZE = 20;
  const CELL_GAP = 2;
  const BOARD_INNER_SPACING = 6; // .board の padding(2px×2) + border(1px×2)

  const boardEl = document.getElementById("board");
  const minesCountEl = document.getElementById("mines-count");
  const timerEl = document.getElementById("timer-value");
  const messageEl = document.getElementById("ms-message");
  const restartBtn = document.getElementById("restart-btn");
  const modeButtons = document.querySelectorAll(".pill-btn[data-mode]");
  const difficultyButtons = document.querySelectorAll(".pill-btn[data-difficulty]");
  const actionButtons = document.querySelectorAll(".pill-btn[data-action]");

  let currentMode = "classic";
  let currentDifficulty = "beginner";
  let currentAction = "dig";
  let rows = 0;
  let cols = 0;
  let mineCount = 0;
  let grid = [];
  let cellEls = [];
  let firstClickDone = false;
  let gameOver = false;
  let revealedSafeCount = 0;
  let flaggedCount = 0;
  let timerId = null;
  let timerStartedAt = 0; // performance.now()。計測中(timerId !== null)のみ有効
  let elapsedSeconds = 0;
  let explosionTimerId = null;
  let shakeStartTimerId = null;
  let shakeEndTimerId = null;

  /* ---------------------------------- 初期化 ---------------------------------- */

  function init(mode, difficulty) {
    const modeConfig = GAME_MODES[mode];
    const diffConfig = DIFFICULTIES[difficulty];
    if (!modeConfig || !diffConfig) return;

    currentMode = mode;
    currentDifficulty = difficulty;
    rows = diffConfig.rows;
    cols = diffConfig.cols;
    mineCount = diffConfig.mines;

    stopTimer();
    elapsedSeconds = 0;
    updateTimerDisplay();

    // 爆発演出の途中でリスタート／モード切替／難易度切替が行われた場合、
    // 古い(r, c)を対象にした保留中の finishLoss が新しい盤面に対して
    // 誤って実行されないようキャンセルする。
    if (explosionTimerId !== null) {
      clearTimeout(explosionTimerId);
      explosionTimerId = null;
    }
    // 盤面の揺れも同様に、予約済みの開始・終了をどちらもキャンセルする。
    clearTimeout(shakeStartTimerId);
    clearTimeout(shakeEndTimerId);
    shakeStartTimerId = null;
    shakeEndTimerId = null;
    boardEl.classList.remove("is-shaking");

    firstClickDone = false;
    gameOver = false;
    revealedSafeCount = 0;
    flaggedCount = 0;
    currentAction = "dig"; // 新しいゲームは必ずDIGから始める

    messageEl.textContent = "";
    messageEl.className = "ms-message";
    updateMinesDisplay();

    buildGrid();
    renderBoard();

    modeButtons.forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.mode === mode));
    });
    difficultyButtons.forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.difficulty === difficulty));
    });
    actionButtons.forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.action === currentAction));
    });
  }

  /**
   * 盤面には触れず、現在のアクション（DIG/FLAG）だけを切り替える。
   * ゲームの状態（盤面・タイマー・旗など）はそのまま維持する。
   */
  function setAction(action) {
    if (!ACTIONS[action]) return;
    currentAction = action;
    actionButtons.forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.action === action));
    });
  }

  function buildGrid() {
    grid = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        row.push({ mine: false, revealed: false, flagged: false, adjacent: 0 });
      }
      grid.push(row);
    }
  }

  /* ---------------------------------- 盤面描画 ---------------------------------- */

  function renderBoard() {
    boardEl.innerHTML = "";
    boardEl.dataset.difficulty = currentDifficulty;
    boardEl.style.gridTemplateColumns = "repeat(" + cols + ", var(--cell-size))";
    boardEl.setAttribute("aria-rowcount", String(rows));
    boardEl.setAttribute("aria-colcount", String(cols));
    applyCellSize();

    cellEls = [];
    for (let r = 0; r < rows; r++) {
      const rowEl = document.createElement("div");
      rowEl.className = "row";
      rowEl.setAttribute("role", "row");

      const rowCells = [];
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "cell is-hidden";
        cell.setAttribute("role", "gridcell");
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        cell.setAttribute("aria-label", cellLabel(r, c));
        attachCellEvents(cell, r, c);
        rowEl.appendChild(cell);
        rowCells.push(cell);
      }
      boardEl.appendChild(rowEl);
      cellEls.push(rowCells);
    }
  }

  /**
   * 盤面の実際の表示幅（board-wrapper の幅）から、はみ出さずに
   * 収まるセルサイズを計算して --cell-size に反映する。
   * board-wrapper は CSS 側で width:100% を持つため、盤面が
   * 空(0マス)の状態で呼び出しても正しい幅が取得できる。
   */
  function applyCellSize() {
    const wrapper = boardEl.parentElement;
    if (!wrapper) return;

    // clientWidth は padding を含むため、左右の padding を差し引いて
    // 盤面が実際に使える幅を求める。
    const wrapperStyle = window.getComputedStyle(wrapper);
    const wrapperPadding =
      (parseFloat(wrapperStyle.paddingLeft) || 0) + (parseFloat(wrapperStyle.paddingRight) || 0);
    const available = wrapper.clientWidth - wrapperPadding - BOARD_INNER_SPACING - (cols - 1) * CELL_GAP;
    const maxSize = MAX_CELL_SIZE[currentDifficulty] || 32;
    const rawSize = Math.floor(available / cols);
    const size = Math.max(MIN_CELL_SIZE, Math.min(maxSize, rawSize));

    boardEl.style.setProperty("--cell-size", size + "px");
  }

  function cellLabel(r, c) {
    const state = grid[r][c];
    const pos = (r + 1) + "行" + (c + 1) + "列";
    if (state.flagged) return pos + "、旗";
    if (!state.revealed) return pos + "、未開放";
    if (state.mine) return pos + "、地雷";
    if (state.adjacent === 0) return pos + "、空白";
    return pos + "、周囲に地雷" + state.adjacent + "個";
  }

  /* ---------------------------------- 入力処理 ---------------------------------- */

  function attachCellEvents(cell, r, c) {
    let longPressTimer = null;
    let longPressTriggered = false;
    let touchActive = false;
    let startX = 0;
    let startY = 0;

    cell.addEventListener("click", function () {
      if (longPressTriggered) {
        longPressTriggered = false;
        return;
      }
      ACTIONS[currentAction].perform(r, c);
    });

    cell.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      // Androidなどタッチ環境では長押しでネイティブのcontextmenuも
      // 発火することがある。長押し側で既に旗を切り替え済みなら
      // ここでは二重に切り替えない（立てた直後に外れる不具合を防ぐ）。
      if (longPressTriggered) return;
      // 逆に、指を置いている間に contextmenu が先に発火した場合は、
      // 待機中の長押しタイマーを止めて「処理済み」にする。
      if (touchActive) {
        clearTimeout(longPressTimer);
        longPressTriggered = true;
      }
      handleFlagToggle(r, c);
    });

    cell.addEventListener("touchstart", function (e) {
      if (gameOver) return;
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      longPressTriggered = false;
      touchActive = true;
      clearTimeout(longPressTimer); // 2本目の指などでタイマーが重複しないようにする
      longPressTimer = window.setTimeout(function () {
        longPressTriggered = true;
        if (navigator.vibrate) navigator.vibrate(15);
        handleFlagToggle(r, c);
      }, LONG_PRESS_MS);
    }, { passive: true });

    cell.addEventListener("touchmove", function (e) {
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);
      if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) {
        clearTimeout(longPressTimer);
      }
    }, { passive: true });

    cell.addEventListener("touchend", function (e) {
      clearTimeout(longPressTimer);
      touchActive = false;
      if (longPressTriggered) {
        e.preventDefault();
      }
    });

    cell.addEventListener("touchcancel", function () {
      clearTimeout(longPressTimer);
      touchActive = false;
      longPressTriggered = false;
    });

    cell.addEventListener("keydown", function (e) {
      if (e.key === "f" || e.key === "F" || e.key === "ContextMenu") {
        e.preventDefault();
        handleFlagToggle(r, c);
      }
    });
  }

  /* ---------------------------------- ゲームロジック ---------------------------------- */

  /**
   * safeCells（[row, col] の配列）を除いた全マスから、地雷を配置する。
   * 除外マスが多く地雷を置ききれない場合でも無限ループにはならず、
   * 置ける分だけ配置して mineCount をその実数に合わせる。
   */
  function placeMines(safeCells) {
    const safeSet = new Set(safeCells.map(function (pos) { return pos[0] + "," + pos[1]; }));
    const eligible = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!safeSet.has(r + "," + c)) eligible.push([r, c]);
      }
    }
    shuffle(eligible);

    const placeCount = Math.min(mineCount, eligible.length);
    for (let i = 0; i < placeCount; i++) {
      grid[eligible[i][0]][eligible[i][1]].mine = true;
    }
    mineCount = placeCount;
    updateMinesDisplay();

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!grid[r][c].mine) {
          grid[r][c].adjacent = countAdjacentMines(r, c);
        }
      }
    }
  }

  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
  }

  function forEachNeighbor(r, c, callback) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        callback(nr, nc);
      }
    }
  }

  function countAdjacentMines(r, c) {
    let count = 0;
    forEachNeighbor(r, c, function (nr, nc) {
      if (grid[nr][nc].mine) count++;
    });
    return count;
  }

  function handleReveal(r, c) {
    if (gameOver) return;
    const cell = grid[r][c];
    if (cell.flagged || cell.revealed) return;

    if (!firstClickDone) {
      const safeCells = GAME_MODES[currentMode].getSafeCells(r, c);
      placeMines(safeCells);
      firstClickDone = true;
      startTimer();
    }

    if (cell.mine) {
      // 入力とタイマーは踏んだ瞬間に即ロックする。実際のendGame(盤面の
      // 地雷公開・メッセージ表示)は爆発演出の後に finishLoss で行う。
      cell.revealed = true;
      gameOver = true;
      stopTimer();
      triggerExplosion(r, c);
      return;
    }

    floodReveal(r, c);
    checkWin();
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /**
   * 地雷を踏んだマスの爆発演出（沈み込み→溜め→爆発→余韻）を再生し、
   * 完了後に finishLoss で本来の敗北処理（地雷公開・ゲームオーバー表示）を行う。
   * prefers-reduced-motion では演出をスキップし、即座に敗北処理へ進む。
   */
  function triggerExplosion(r, c) {
    if (prefersReducedMotion()) {
      finishLoss(r, c);
      return;
    }

    const el = cellEls[r][c];
    el.classList.add("is-detonating");
    spawnDebris(el);

    forEachNeighbor(r, c, function (nr, nc) {
      const neighborEl = cellEls[nr][nc];
      neighborEl.classList.add("is-shock-neighbor");
      neighborEl.addEventListener("animationend", function onEnd() {
        neighborEl.classList.remove("is-shock-neighbor");
        neighborEl.removeEventListener("animationend", onEnd);
      });
    });

    shakeStartTimerId = window.setTimeout(function () {
      shakeStartTimerId = null;
      boardEl.classList.add("is-shaking");
      shakeEndTimerId = window.setTimeout(function () {
        shakeEndTimerId = null;
        boardEl.classList.remove("is-shaking");
      }, EXPLOSION_SHAKE_DURATION_MS);
    }, EXPLOSION_SHAKE_DELAY_MS);

    explosionTimerId = window.setTimeout(function () {
      explosionTimerId = null;
      finishLoss(r, c);
    }, EXPLOSION_TOTAL_MS);
  }

  /** 爆発の中心マスから土・草・煙の破片を飛び散らせる（装飾用のDOM、自動でクリーンアップされる）。 */
  function spawnDebris(cellEl) {
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      const isSmoke = i < DEBRIS_SMOKE_COUNT;
      const piece = document.createElement("span");
      piece.className = isSmoke ? "debris debris-smoke" : "debris";
      piece.setAttribute("aria-hidden", "true");

      const angle = Math.random() * Math.PI * 2;
      const distance = isSmoke ? 0.25 + Math.random() * 0.35 : 0.6 + Math.random() * 1.0;
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance - (0.2 + Math.random() * 0.4);
      const rot = Math.round(90 + Math.random() * 450) * (Math.random() < 0.5 ? -1 : 1);

      piece.style.setProperty("--dx", dx.toFixed(2));
      piece.style.setProperty("--dy", dy.toFixed(2));
      piece.style.setProperty("--rot", rot + "deg");
      piece.style.setProperty("--debris-delay", Math.round(DEBRIS_DELAY_MS + Math.random() * 90) + "ms");
      if (!isSmoke) {
        piece.style.setProperty("--debris-color", DEBRIS_COLORS[Math.floor(Math.random() * DEBRIS_COLORS.length)]);
      }

      cellEl.appendChild(piece);
    }
  }

  /**
   * 爆発演出の完了後に呼ばれる、本来の敗北処理。
   * updateCellDisplay が className/textContent をリセットするため、
   * is-detonating クラスや破片の<span>はここで自動的に片付く。
   */
  function finishLoss(r, c) {
    boardEl.classList.remove("is-shaking");
    updateCellDisplay(r, c, true);
    endGame(false);
  }

  function floodReveal(startRow, startCol) {
    const stack = [[startRow, startCol]];
    while (stack.length > 0) {
      const pos = stack.pop();
      const cr = pos[0];
      const cc = pos[1];
      const cell = grid[cr][cc];
      if (cell.revealed || cell.flagged) continue;

      cell.revealed = true;
      revealedSafeCount++;
      updateCellDisplay(cr, cc);

      if (cell.adjacent === 0) {
        forEachNeighbor(cr, cc, function (nr, nc) {
          if (!grid[nr][nc].revealed && !grid[nr][nc].mine) {
            stack.push([nr, nc]);
          }
        });
      }
    }
  }

  function handleFlagToggle(r, c) {
    if (gameOver) return;
    const cell = grid[r][c];
    if (cell.revealed) return;

    cell.flagged = !cell.flagged;
    flaggedCount += cell.flagged ? 1 : -1;
    updateCellDisplay(r, c);
    updateMinesDisplay();
  }

  function checkWin() {
    const safeTotal = rows * cols - mineCount;
    if (revealedSafeCount === safeTotal) {
      endGame(true);
    }
  }

  function endGame(won) {
    gameOver = true;
    stopTimer();

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        const el = cellEls[r][c];

        if (won && cell.mine && !cell.flagged) {
          cell.flagged = true;
          flaggedCount++;
          updateCellDisplay(r, c);
        } else if (!won && cell.mine && !cell.revealed) {
          cell.revealed = true;
          updateCellDisplay(r, c);
        } else if (!won && cell.flagged && !cell.mine) {
          el.classList.add("is-wrong");
          el.textContent = "❌";
          el.setAttribute("aria-label", (r + 1) + "行" + (c + 1) + "列、旗の位置に地雷はありませんでした");
        }
      }
    }

    updateMinesDisplay();
    messageEl.textContent = won ? "クリアしました！おめでとうございます。" : "ゲームオーバーです。";
    messageEl.className = "ms-message " + (won ? "is-win" : "is-lose");
  }

  /* ---------------------------------- 表示更新 ---------------------------------- */

  function updateCellDisplay(r, c, exploded) {
    const cell = grid[r][c];
    const el = cellEls[r][c];

    el.className = "cell";
    el.textContent = "";
    delete el.dataset.count;

    if (cell.flagged) {
      el.classList.add("is-flagged");
      el.textContent = "🚩";
    } else if (cell.revealed) {
      el.classList.add("is-revealed");
      if (cell.mine) {
        el.classList.add("is-mine");
        if (exploded) el.classList.add("is-exploded");
        el.textContent = "💣";
      } else if (cell.adjacent > 0) {
        el.textContent = String(cell.adjacent);
        el.dataset.count = String(cell.adjacent);
      }
    } else {
      el.classList.add("is-hidden");
    }

    el.setAttribute("aria-label", cellLabel(r, c));
  }

  function updateMinesDisplay() {
    minesCountEl.textContent = String(mineCount - flaggedCount);
  }

  function startTimer() {
    stopTimer();
    timerStartedAt = performance.now();
    timerId = window.setInterval(refreshElapsed, TIMER_TICK_MS);
  }

  function stopTimer() {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
      refreshElapsed(); // 最後のtick以降の経過分も反映して確定させる
    }
  }

  /**
   * 経過時間は開始時刻との差分から求める。tickの回数を数えないため、
   * バックグラウンドタブでsetIntervalが間引かれても実時間とずれない。
   */
  function refreshElapsed() {
    const seconds = Math.floor((performance.now() - timerStartedAt) / 1000);
    if (seconds === elapsedSeconds) return;
    elapsedSeconds = seconds;
    updateTimerDisplay();
  }

  function updateTimerDisplay() {
    const m = Math.floor(elapsedSeconds / 60).toString().padStart(2, "0");
    const s = (elapsedSeconds % 60).toString().padStart(2, "0");
    timerEl.textContent = m + ":" + s;
  }

  /* ---------------------------------- イベント登録 ---------------------------------- */

  restartBtn.addEventListener("click", function () {
    init(currentMode, currentDifficulty);
  });

  modeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      init(btn.dataset.mode, currentDifficulty);
    });
  });

  difficultyButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      init(currentMode, btn.dataset.difficulty);
    });
  });

  actionButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setAction(btn.dataset.action);
    });
  });

  document.addEventListener("contextmenu", function (e) {
    if (e.target.closest && e.target.closest(".board")) {
      e.preventDefault();
    }
  });

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    return target.isContentEditable || target.closest("input, textarea, select") !== null;
  }

  // D=DIGモード / G=FLAGモードへの切り替え。
  // 既存の「Fキーでフォーカス中のマスに旗を立てる」操作と競合しないよう
  // Fは使わない（マス単位の操作 と 全体のアクション切り替え を区別する）。
  // 文字入力中や、Ctrl+D などブラウザのショートカットは妨げない。
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
    if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      setAction("dig");
    } else if (e.key === "g" || e.key === "G") {
      e.preventDefault();
      setAction("flag");
    }
  });

  let resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(applyCellSize, 150);
  });

  init(currentMode, currentDifficulty);
})();
