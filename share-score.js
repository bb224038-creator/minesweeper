/**
 * share-score.js — クリア後の「Share Score / Copy Score」機能。
 *
 * 役割の分離:
 *   game.js            → Minesweeperのゲーム本体（無変更）
 *   extras.js          → Recent Games / Feedback（無変更）
 *   personal-best.js   → 自己ベストの保存・取得・表示（無変更・読み取りのみ利用）
 *   share-score.js     → このファイル。クリア結果の共有・コピーのみ
 *
 * game.jsには一切依存・干渉しない。表示・非表示の切り替えも
 * Recent Games / Personal Bestと同じ手法（#ms-message のクラス変化を
 * MutationObserverで監視するだけ）で行っている。
 *
 * Personal Bestとの連携は、保存ロジック（localStorage）には一切触れず、
 * 既に画面に表示されている #personal-best-value（現在のベストタイム）と
 * #personal-best-new（今回のクリアでベストを更新したかどうか）を
 * 読み取るだけ。personal-best.jsの保存構造・処理は変更していない。
 */
(function () {
  "use strict";

  const MODE_LABELS = { classic: "Classic", meadow: "Adventure" };
  const DIFFICULTY_LABELS = { beginner: "Beginner", intermediate: "Intermediate", expert: "Expert" };
  const MAP_LABELS = { beginner: "Grassland", intermediate: "Desert", expert: "Volcanic" };

  const messageEl = document.getElementById("ms-message");
  const timerEl = document.getElementById("timer-value");
  const barEl = document.getElementById("share-score-bar");
  const btnEl = document.getElementById("share-score-btn");
  const statusEl = document.getElementById("share-score-status");
  const labelEl = document.getElementById("share-score-label");
  const shareIconEl = document.querySelector(".share-score-icon-share");
  const copyIconEl = document.querySelector(".share-score-icon-copy");
  const pbValueEl = document.getElementById("personal-best-value");
  const pbNewEl = document.getElementById("personal-best-new");

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  /* Web Share API非対応の環境では、ボタンの見た目自体を
     「Copy Score」に切り替えておき、押す前から挙動が分かるようにする。
     hidden プロパティはSVG要素では正しく属性と同期しないブラウザが
     あるため、setAttribute/removeAttributeで直接操作する。 */
  if (!canShare && labelEl && shareIconEl && copyIconEl) {
    labelEl.textContent = "Copy Score";
    shareIconEl.setAttribute("hidden", "");
    copyIconEl.removeAttribute("hidden");
  }

  /* ---------------------------------- モード・難易度の取得 ---------------------------------- */

  function currentMode() {
    const btn = document.querySelector('.pill-btn[data-mode][aria-pressed="true"]');
    return btn ? btn.dataset.mode : null;
  }

  function currentDifficulty() {
    const btn = document.querySelector('.pill-btn[data-difficulty][aria-pressed="true"]');
    return btn ? btn.dataset.difficulty : null;
  }

  /* ---------------------------------- 共有テキストの組み立て ---------------------------------- */

  function buildShareText() {
    const mode = currentMode();
    const difficulty = currentDifficulty();
    const modeLabel = MODE_LABELS[mode] || mode || "";
    const difficultyLabel = DIFFICULTY_LABELS[difficulty] || difficulty || "";
    const time = timerEl ? timerEl.textContent : "";
    const best = pbValueEl ? pbValueEl.textContent : "--:--";
    const isNewBest = !!(pbNewEl && !pbNewEl.hidden);

    const lines = ["Minesweeper"];
    if (mode === "meadow") {
      const mapLabel = MAP_LABELS[difficulty] || "";
      lines.push([modeLabel, mapLabel, difficultyLabel].filter(Boolean).join(" · "));
    } else {
      lines.push([modeLabel, difficultyLabel].filter(Boolean).join(" · "));
    }
    lines.push("Time: " + time);
    lines.push("Personal Best: " + best + (isNewBest ? " (New Record!)" : ""));
    lines.push("");
    lines.push("Can you beat my time?");
    return lines.join("\n");
  }

  /* ---------------------------------- 共有 / コピー実行 ---------------------------------- */

  function showStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    window.setTimeout(function () {
      if (statusEl.textContent === text) statusEl.textContent = "";
    }, 2500);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error("clipboard API unavailable"));
  }

  function handleShareClick() {
    const text = buildShareText();

    if (canShare) {
      navigator.share({ text: text }).catch(function () {
        /* ユーザーによるキャンセルなどは通常の操作なのでエラー扱いしない */
      });
      return;
    }

    copyToClipboard(text)
      .then(function () {
        showStatus("Score copied!");
      })
      .catch(function () {
        showStatus("コピーできませんでした。");
      });
  }

  if (btnEl) {
    btnEl.addEventListener("click", handleShareClick);
  }

  /* ---------------------------------- 表示/非表示（クリア後のみ） ---------------------------------- */

  if (messageEl && barEl) {
    const observer = new MutationObserver(function () {
      // personal-best.js側の更新（localStorageへの保存・#personal-best-new
      // の表示切り替え）が同じミューテーションで先に走っている前提だが、
      // 順序に依存しすぎないよう、次のタスクへずらしてから読み取る。
      window.setTimeout(function () {
        if (messageEl.classList.contains("is-win")) {
          barEl.hidden = false;
        } else if (messageEl.textContent === "") {
          // リスタート／モード変更／難易度変更によるリセット。
          // ゲームオーバー（is-lose）のときはここに来ないため、
          // 直前がクリアでなければ常に非表示のまま＝Game Overでは
          // 表示されない。
          barEl.hidden = true;
          if (statusEl) statusEl.textContent = "";
        }
      }, 0);
    });
    observer.observe(messageEl, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
})();
