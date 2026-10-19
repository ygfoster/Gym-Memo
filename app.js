document.addEventListener('DOMContentLoaded', function() {
  let config = null;
  try {
    const rawData = localStorage.getItem('lifeTrackerConfig');
    if (rawData) config = JSON.parse(rawData);
  } catch (e) {
    console.warn("Save data corrupted. Resetting...");
    config = null;
  }
  if (!config) config = { birth: '', lifeAge: 30, customs: [] };
  if (!config.customs) config.customs = [];

  let flow = []; 
  let currentIndex = 0;
  let animationFrameId = null;

  const swipeWrapper = document.getElementById('swipe-wrapper');
  const tabs = document.querySelectorAll('.tab-item');
  const setupOverlay = document.getElementById('setup-overlay');
  
  // UI要素
  const btnHamburger = document.getElementById('btn-hamburger');
  const settingsDrawer = document.getElementById('settings-drawer');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  
  const btnAddTraining = document.getElementById('btn-add-training');
  const morphModal = document.getElementById('morph-modal');
  const btnCloseMorph = document.getElementById('btn-close-morph');

  // グローバルな通知表示関数 (タイマー0時等に呼び出せる)
  window.showNotification = function(message) {
    const banner = document.getElementById('notification-banner');
    const text = document.getElementById('notification-text');
    text.textContent = message;
    banner.classList.add('show');
    
    // 3.5秒後に滑らかにクロスフェードアウト
    setTimeout(() => {
      banner.classList.remove('show');
    }, 3500);
  };

  function init() {
    // 起動時の初期化
    if (!config.birth || config.birth === '') {
      setupOverlay.style.display = 'flex';
      // initDatePicker等のロジックは既存資産を流用
    } else {
      setupOverlay.style.display = 'none';
      startMainUI();
    }

    setupEventHandlers();
  }

  function startMainUI() {
    buildDOMFlow();
    updateCarousel();
    startRenderLoop();
    renderCustomSettings();
  }

  // ハンバーガーとMorphing（FAB）のイベントリスナー
  function setupEventHandlers() {
    // ハンバーガーメニューでSettings開閉
    btnHamburger.addEventListener('click', () => {
      settingsDrawer.classList.add('active');
    });
    btnCloseSettings.addEventListener('click', () => {
      settingsDrawer.classList.remove('active');
    });

    // FABボタンでMorphingモーダル開閉
    btnAddTraining.addEventListener('click', () => {
      morphModal.classList.add('active');
    });
    btnCloseMorph.addEventListener('click', () => {
      morphModal.classList.remove('active');
    });

    // スワイプ管理 (Settingsが消えたため、Life, Born, Customの3画面のみを管理)
    tabs.forEach(tab => {
      tab.addEventListener('click', function() {
        const targetTab = tab.getAttribute('data-tab');
        if(!targetTab) return; // FAB等にはdata-tabが無い
        const targetIndex = flow.findIndex(f => f.tab === targetTab);
        if (targetIndex !== -1) { 
          currentIndex = targetIndex; 
          updateCarousel(); 
        }
      });
    });

    // スワイプジェスチャー管理
    let touchStartX = 0, touchStartY = 0;
    const mainContent = document.getElementById('main-content');
    if(mainContent) {
      mainContent.addEventListener('touchstart', e => {
        if (e.target.closest('button')) return;
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
      }, {passive: true});
      mainContent.addEventListener('touchend', e => {
        if (e.target.closest('button')) return;
        let dx = e.changedTouches[0].screenX - touchStartX;
        let dy = e.changedTouches[0].screenY - touchStartY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
          if (dx < 0 && currentIndex < flow.length - 1) currentIndex++; 
          else if (dx > 0 && currentIndex > 0) currentIndex--; 
          updateCarousel();
        }
      }, {passive: true});
    }
  }

  function buildDOMFlow() {
    if(!swipeWrapper) return;
    const viewLife = document.getElementById('view-life');
    const viewBorn = document.getElementById('view-born');
    const viewCustomEmpty = document.getElementById('view-custom-empty');
    
    // 動的Customの削除
    document.querySelectorAll('.custom-dynamic-view').forEach(el => el.remove());
    flow = [];
    
    // 順番: Life -> Born -> Custom
    if(viewLife) { swipeWrapper.appendChild(viewLife); flow.push({ id: 'view-life', tab: 'view-life' }); }
    if(viewBorn) { swipeWrapper.appendChild(viewBorn); flow.push({ id: 'view-born', tab: 'view-born' }); }

    const customs = config.customs || [];
    if (customs.length === 0 && viewCustomEmpty) {
      swipeWrapper.appendChild(viewCustomEmpty);
      viewCustomEmpty.style.display = 'flex';
      flow.push({ id: 'view-custom-empty', tab: 'view-custom' });
    } else if (customs.length > 0) {
      if(viewCustomEmpty) viewCustomEmpty.style.display = 'none';
      customs.forEach((c, i) => {
        const customId = 'view-custom-' + i;
        const section = document.createElement('section');
        section.className = 'view-section custom-dynamic-view';
        section.id = customId;
        section.innerHTML = `<h1 class="view-title">${c.title || '名称未設定'}</h1><div class="timer-display" id="timer-${customId}"></div>`;
        swipeWrapper.appendChild(section);
        flow.push({ id: customId, tab: 'view-custom', data: c, index: i });
      });
    }
    // 注: view-settingsはDrawerに移動したためフローには追加しない
  }

  function updateCarousel() {
    if(flow.length === 0 || !swipeWrapper) return;
    if(currentIndex < 0) currentIndex = 0;
    if(currentIndex >= flow.length) currentIndex = flow.length - 1;
    
    swipeWrapper.style.transform = `translateX(-${currentIndex * 100}vw)`;
    
    const activeTabTarget = flow[currentIndex].tab;
    tabs.forEach(t => {
      const dataTab = t.getAttribute('data-tab');
      if(dataTab) {
        t.classList.toggle('active', dataTab === activeTabTarget);
      }
    });
  }

  // ----------------------------------------------------
  // 設定ドロワー内のカスタムタイマーリスト生成
  // (削除ボタンの「文字」を取り除き、アイコンのみにしたバージョン)
  // ----------------------------------------------------
  function renderCustomSettings() {
    const list = document.getElementById('custom-settings-list');
    if(!list) return;
    list.innerHTML = '';
    const customs = config.customs || [];
    customs.forEach((c, index) => {
      const pId = 'picker-custom-' + index;
      const container = document.createElement('div');
      container.className = 'swipe-item-container';
      container.id = 'swipe-item-' + index; 
      
      // ★ 削除テキストを排除し、ゴミ箱SVGアイコンだけに統一
      container.innerHTML = `
        <div class="swipe-actions-bg">
          <button class="swipe-delete-btn" onclick="removeCustom(${index})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </button>
        </div>
        <div class="swipe-content" id="swipe-content-${index}">
          <div style="margin-bottom:12px;">
            <input type="text" class="input-field" placeholder="タイトル (例: 禁煙)" value="${c.title || ''}" id="custom-title-${index}" style="width:100%;">
          </div>
          <!-- ピッカー用要素等 (既存コードを踏襲) -->
        </div>
      `;
      list.appendChild(container);
      
      // スワイプ開閉制御（イージングを統一）
      const swipeContent = container.querySelector('.swipe-content');
      let startX = 0, currentX = 0;
      swipeContent.addEventListener('touchstart', e => {
        if(e.target.closest('input')) return;
        swipeContent.style.transition = 'none';
        startX = e.touches[0].clientX;
      }, {passive: true});
      swipeContent.addEventListener('touchmove', e => {
        if(e.target.closest('input')) return;
        currentX = e.touches[0].clientX - startX;
        if(currentX > 0) currentX = 0; 
        if(currentX < -80) currentX = -80; 
        swipeContent.style.transform = `translateX(${currentX}px)`;
      }, {passive: true});
      swipeContent.addEventListener('touchend', () => {
        if(currentX === 0) return; 
        swipeContent.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
        swipeContent.style.transform = currentX < -30 ? `translateX(-80px)` : `translateX(0)`;
        currentX = 0; 
      }, {passive: true});
    });
  }

  window.removeCustom = function(index) {
    const itemContainer = document.getElementById('swipe-item-' + index);
    if (itemContainer) {
      // 消滅時もバウンスせず、スケールインとフェードに統一
      itemContainer.style.transition = 'opacity 0.4s cubic-bezier(0.32, 0.72, 0, 1), transform 0.4s cubic-bezier(0.32, 0.72, 0, 1)';
      itemContainer.style.opacity = '0';
      itemContainer.style.transform = 'scale(0.95)';
      setTimeout(() => {
        config.customs.splice(index, 1);
        localStorage.setItem('lifeTrackerConfig', JSON.stringify(config));
        renderCustomSettings();
        buildDOMFlow(); // カスタムタイマー画面の再構築
        updateCarousel();
      }, 400);
    }
  };

  // ※タイマーの計算（calculateDiff）、描画ループ（startRenderLoop）などは
  // 既存のコード資産をそのまま組み合わせて動作します。
  
  init();
});
