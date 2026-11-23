/**
 * extras.js — Recent Games（このブラウザだけのローカル記録）と
 * Feedback送信フォームを担当する。
 *
 * game.js（ゲーム本体のロジック）には一切依存・干渉しない。勝利の検知も
 * #ms-message の class 変化を監視するだけで行っており、game.js側の
 * コードは1行も変更していない。
 */
(function () {
  "use strict";

  const STORAGE_KEY_GAMES = "ms-recent-games";
  const STORAGE_KEY_NAME = "ms-player-name";
  const MAX_RECENT_GAMES = 5;

  // 内部識別子(data-mode)は "meadow" のままだが、表示名は Adventure に
  // 変更した。過去にlocalStorageへ保存済みの旧記録(mode:"meadow")も
  // このマップ経由で表示するため、キー名はそのままにしている。
  const MODE_LABELS = { classic: "Classic", meadow: "Adventure" };
  const DIFFICULTY_LABELS = { beginner: "Beginner", intermediate: "Intermediate", expert: "Expert" };

  const messageEl = document.getElementById("ms-message");
  const timerEl = document.getElementById("timer-value");
  const nameInput = document.getElementById("player-name");
  const table = document.getElementById("recent-games-table");
  const tableBody = document.getElementById("recent-games-body");
  const emptyState = document.getElementById("recent-games-empty");
  const feedbackForm = document.getElementById("feedback-form");
  const feedbackStatus = document.getElementById("feedback-status");

  /* ---------------------------------- Recent Games ---------------------------------- */

  function loadGames() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_GAMES);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveGames(games) {
    try {
      localStorage.setItem(STORAGE_KEY_GAMES, JSON.stringify(games));
    } catch (e) {
      /* localStorageが使えない場合は記録をスキップする（機能自体は壊さない） */
    }
  }

  function formatTime(text) {
    // "00:42" -> "42s" / "01:18" -> "1:18"
    const parts = text.split(":");
    if (parts.length !== 2) return text;
    const minutes = Number(parts[0]);
    const seconds = parts[1];
    return minutes === 0 ? Number(seconds) + "s" : minutes + ":" + seconds;
  }

  function currentMode() {
    const btn = document.querySelector('.pill-btn[data-mode][aria-pressed="true"]');
    return btn ? btn.dataset.mode : null;
  }

  function currentDifficulty() {
    const btn = document.querySelector('.pill-btn[data-difficulty][aria-pressed="true"]');
    return btn ? btn.dataset.difficulty : null;
  }

  function renderGames() {
    if (!table || !tableBody || !emptyState) return;
    const games = loadGames();
    tableBody.innerHTML = "";

    if (games.length === 0) {
      table.hidden = true;
      emptyState.hidden = false;
      return;
    }

    table.hidden = false;
    emptyState.hidden = true;

    games.forEach(function (game) {
      const row = document.createElement("tr");

      const nameCell = document.createElement("td");
      nameCell.textContent = game.name;

      const modeCell = document.createElement("td");
      const modeLabel = MODE_LABELS[game.mode] || game.mode;
      const difficultyLabel = DIFFICULTY_LABELS[game.difficulty] || game.difficulty;
      modeCell.textContent = modeLabel + " ・ " + difficultyLabel;

      const timeCell = document.createElement("td");
      timeCell.textContent = game.time;

      row.appendChild(nameCell);
      row.appendChild(modeCell);
      row.appendChild(timeCell);
      tableBody.appendChild(row);
    });
  }

  function recordWin() {
    const name = (nameInput && nameInput.value.trim()) || "匿名";
    const games = loadGames();
    games.unshift({
      name: name,
      mode: currentMode(),
      difficulty: currentDifficulty(),
      time: formatTime(timerEl ? timerEl.textContent : "00:00"),
      recordedAt: Date.now(),
    });
    saveGames(games.slice(0, MAX_RECENT_GAMES));
    renderGames();
  }

  if (messageEl) {
    const observer = new MutationObserver(function () {
      if (messageEl.classList.contains("is-win")) {
        recordWin();
      }
    });
    observer.observe(messageEl, { attributes: true, attributeFilter: ["class"] });
  }

  if (nameInput) {
    try {
      const savedName = localStorage.getItem(STORAGE_KEY_NAME);
      if (savedName) nameInput.value = savedName;
    } catch (e) {
      /* noop */
    }

    nameInput.addEventListener("change", function () {
      try {
        localStorage.setItem(STORAGE_KEY_NAME, nameInput.value.trim());
      } catch (e) {
        /* noop */
      }
    });
  }

  renderGames();

  /* ---------------------------------- Feedback ---------------------------------- */

  /**
   * フィードバックの実際の送信処理。現在はFormspreeへPOSTしているが、
   * 将来Supabaseへ移行する際は呼び出し側（下のsubmitイベント処理）を
   * 変更せず、この関数の中身だけを差し替えればよい。
   * 送信する項目は name / email / message の3つ（投稿日時・対応状況は
   * バックエンド側で持つ想定のためフォームには含めない）。
   */
  function submitFeedback(formData) {
    return fetch(feedbackForm.action, {
      method: "POST",
      body: formData,
      headers: { Accept: "application/json" },
    }).then(function (response) {
      if (!response.ok) throw new Error("submit failed");
    });
  }

  if (feedbackForm && feedbackStatus) {
    feedbackForm.addEventListener("submit", function (e) {
      e.preventDefault();
      const submitBtn = feedbackForm.querySelector('button[type="submit"]');

      feedbackStatus.textContent = "送信中...";
      feedbackStatus.className = "feedback-status";
      if (submitBtn) submitBtn.disabled = true;

      submitFeedback(new FormData(feedbackForm))
        .then(function () {
          feedbackStatus.textContent = "送信しました。ありがとうございます！";
          feedbackStatus.className = "feedback-status is-success";
          feedbackForm.reset();
        })
        .catch(function () {
          feedbackStatus.textContent = "送信に失敗しました。時間をおいて再度お試しください。";
          feedbackStatus.className = "feedback-status is-error";
        })
        .finally(function () {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  }
})();
