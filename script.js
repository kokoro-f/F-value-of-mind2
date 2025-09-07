// ココロカメラ：F値 → BPM → シャッタースピード反映（保存=プレビュー一致）+ 情報モーダル
document.addEventListener('DOMContentLoaded', () => {
  // ====== 画面管理 ======
  const screens = {
    initial: document.getElementById('screen-initial'),
    introduction: document.getElementById('screen-introduction'),
    fvalue: document.getElementById('screen-fvalue-input'),
    bpm: document.getElementById('screen-bpm'),
    camera: document.getElementById('screen-camera'),
  };
  function showScreen(key) {
    Object.values(screens).forEach(s => s?.classList.remove('active'));
    Object.values(screens).forEach(s => s?.setAttribute('aria-hidden','true'));
    screens[key]?.classList.add('active');
    screens[key]?.setAttribute('aria-hidden','false');
  }

  // ====== 文言（辞書） ======
  const T = {
    appTitle: "ココロカメラ",
    splashTagline: "あなたの心のシャッターを切る",
    start: "はじめる",
    next: "次へ",

    howtoTitle: "名前とルームコードの入力",
    howtoText: "あなたの名前（ニックネーム）とルームコードを入力してください。（任意）",

    fInputTitle: "今の心の状態に合わせて円を広げたり縮めたりしてください",
    fHint1: "F値が小さい=開放的",
    fHint2: "F値が大きい＝集中している",
    decide: "決定",

    bpmTitle: "ココロのシャッタースピード",
    bpmPrep_html: 'カメラに<strong>指先を軽く当てて</strong>ください赤みの変化から心拍数を測定します',
    bpmReady: "準備ができたら計測開始を押してください",
    bpmStart: "計測開始",
    skip: "スキップ",

    switchCam: "切り替え",
    shoot: "撮影",
    info: "情報",

    bpmMeasuring: (remain) => `計測中… 残り ${remain} 秒`,
    bpmResult: (bpm) => `推定BPM: ${bpm}`,
    cameraError: "カメラを起動できません。端末の設定からカメラ権限を許可してください。"
  };
  function applyTexts(dict) {
    document.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.dataset.i18n;
      const val = dict[key];
      if (typeof val === "string") el.textContent = val;
    });
    document.querySelectorAll("[data-i18n-html]").forEach(el => {
      const key = el.dataset.i18nHtml;
      const val = dict[key];
      if (typeof val === "string") el.innerHTML = val;
    });
  }
  applyTexts(T);

  // ====== カメラ（撮影プレビュー） ======
  const video = document.getElementById('video');
  const rawCanvas = document.getElementById('canvas');

  // 実表示キャンバス
  const previewCanvas = document.createElement('canvas');
  const previewCtx = previewCanvas.getContext('2d');
  if (screens.camera) {
    Object.assign(previewCanvas.style, {
      position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', zIndex: '1'
    });
    screens.camera.insertBefore(previewCanvas, screens.camera.firstChild);
  }

  // 軽量処理キャンバス
  const procCanvas = document.createElement('canvas');
  const procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
  const PREVIEW_MAX_W = 640;
  const PREVIEW_FPS   = 15;
  let lastPreviewTs = 0;

  let currentStream = null;
  let isFrontCamera = false;
  let selectedFValue = 32.0;
  let lastMeasuredBpm = 0;
  const defaultBpm = 60;

  // ====== F値 → パラメータ／ぼけ半径 ======
  function fParams(f) {
    // F=1 → ガンマ 0.2（すごく明るい／白飛び気味）
    // F=32 → ガンマ 3.0（すごく暗い／露出不足っぽい）
    const gamma = 0.2 + (f - 1) * (2.8 / 31);
    return {
      brightness: gamma,   // brightness をガンマ値として利用
      contrast: 1.0,
      saturate: 1.0
    };
  }

  function fToBlurRadius(f) {
    return Math.max(0, Math.round(18 * (1.2 / f)));
  }

  // ====== プレビューループ（保存と同じ処理パス） ======
  let rafId = null;
  function startPreviewLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    const render = (ts) => {
      if (video.videoWidth && video.videoHeight) {
        if (previewCanvas.width !== video.videoWidth || previewCanvas.height !== video.videoHeight) {
          previewCanvas.width  = video.videoWidth;
          previewCanvas.height = video.videoHeight;
        }
        const interval = 1000 / PREVIEW_FPS;
        if ((ts - lastPreviewTs) >= interval) {
          lastPreviewTs = ts;
          const scale = Math.min(1, PREVIEW_MAX_W / video.videoWidth);
          const w = Math.max(1, Math.round(video.videoWidth  * scale));
          const h = Math.max(1, Math.round(video.videoHeight * scale));
          if (procCanvas.width !== w || procCanvas.height !== h) {
            procCanvas.width = w; procCanvas.height = h;
          }
          // 1) ソース
          procCtx.clearRect(0, 0, w, h);
          procCtx.drawImage(video, 0, 0, w, h);
          // 2) F値（明るさ/コントラスト/彩度）
          applyFValuePixels(procCtx, w, h, selectedFValue);
          // 3) F値ぼけ
          const blurRadius = fToBlurRadius(selectedFValue);
          if (blurRadius > 0 && window.StackBlur?.canvasRGBA) {
            StackBlur.canvasRGBA(procCanvas, 0, 0, w, h, blurRadius);
          }
          // 4) 実表示
          previewCtx.imageSmoothingEnabled = true;
          previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
          previewCtx.drawImage(procCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
        }
      }
      rafId = requestAnimationFrame(render);
    };
    rafId = requestAnimationFrame(render);
  }
  function stopPreviewLoop(){ if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  // カメラ起動
  async function startCamera(facingMode = 'environment') {
    try {
      if (currentStream) currentStream.getTracks().forEach(t => t.stop());
      const constraints = {
        video: {
          facingMode: facingMode === 'environment' ? { ideal: 'environment' } : 'user',
          width: { ideal: 1280 }, height: { ideal: 720 }
        },
        audio: false
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      currentStream = stream;
      isFrontCamera = (facingMode === 'user');
      video.style.display = 'none';
      startPreviewLoop();
    } catch (err) {
      console.error('カメラエラー:', err);
      alert(T.cameraError);
    }
  }

  // ====== 画面遷移 ======
  document.getElementById('initial-next-btn')?.addEventListener('click', () => showScreen('introduction'));
  document.getElementById('intro-next-btn')?.addEventListener('click', () => showScreen('fvalue'));

  // ====== F値（ピンチ） ======
  const apertureControl = document.querySelector('.aperture-control');
  const fValueDisplay   = document.getElementById('f-value-display');
  const apertureInput   = document.getElementById('aperture');
  const MIN_F = 1.0, MAX_F = 32.0, MIN_SIZE = 100, MAX_SIZE = 250;

  const fToSize = f => MIN_SIZE + ((MAX_F - f) / (MAX_F - MIN_F)) * (MAX_SIZE - MIN_SIZE);
  const sizeToF = size => MAX_F - ((size - MIN_SIZE) / (MAX_SIZE - MIN_SIZE)) * (MAX_F - MIN_F);

  if (apertureControl && fValueDisplay && apertureInput) {
    const initialSize = fToSize(selectedFValue);
    apertureControl.style.width = apertureControl.style.height = `${initialSize}px`;
    fValueDisplay.textContent = Math.round(selectedFValue);
    apertureInput.value = Math.round(selectedFValue);
  }

  let lastDistance = null;
  const getDistance = (t1, t2) => Math.hypot(t1.pageX - t2.pageX, t1.pageY - t2.pageY);

  document.body.addEventListener('touchstart', e => {
    if (!screens.fvalue?.classList.contains('active')) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      lastDistance = getDistance(e.touches[0], e.touches[1]);
    }
  }, { passive: false });

  document.body.addEventListener('touchmove', e => {
    if (!screens.fvalue?.classList.contains('active')) return;
    if (e.touches.length === 2 && lastDistance) {
      e.preventDefault();
      const current = getDistance(e.touches[0], e.touches[1]);
      const delta = current - lastDistance;
      const newSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, apertureControl.offsetWidth + delta));
      const newF = sizeToF(newSize);
      const roundedF = Math.round(newF);      // 整数にスナップ
      const snappedSize = fToSize(roundedF);  // 円サイズもスナップ

      apertureControl.style.width = apertureControl.style.height = `${snappedSize}px`;
      fValueDisplay.textContent = roundedF;
      apertureInput.value = roundedF;

      lastDistance = current;
    }
  }, { passive: false });
  document.body.addEventListener('touchend', () => { lastDistance = null; });

  // F値決定 → BPM計測へ
  document.getElementById('f-value-decide-btn')?.addEventListener('click', async () => {
    const f = Math.round(parseFloat(apertureInput.value));
    selectedFValue = f;
    document.querySelector('.aperture-control')?.setAttribute('aria-valuenow', String(f));
    showScreen('bpm');
    await startBpmCamera();
  });

  // カメラ切替
  document.getElementById('camera-switch-btn')?.addEventListener('click', async () => {
    const newMode = isFrontCamera ? 'environment' : 'user';
    await startCamera(newMode);
  });

  // ====== BPM 計測 ======
  const bpmVideo = document.getElementById('bpm-video');
  const bpmCanvas = document.getElementById('bpm-canvas');
  const bpmCtx = bpmCanvas.getContext('2d');
  const bpmStatus = document.getElementById('bpm-status');
  let bpmStream = null;
  let bpmLoopId = null;

  async function startBpmCamera() {
    try {
      if (bpmStream) bpmStream.getTracks().forEach(t => t.stop());
      bpmStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width:{ideal:640}, height:{ideal:480} },
        audio: false
      });
      bpmVideo.srcObject = bpmStream;
      await bpmVideo.play();
      bpmStatus.textContent = T.bpmReady;
    } catch (e) {
      console.error(e);
      bpmStatus.textContent = 'カメラ起動に失敗しました。スキップも可能です。';
    }
  }
  function stopBpmCamera() {
    if (bpmLoopId) cancelAnimationFrame(bpmLoopId);
    bpmLoopId = null;
    if (bpmStream) {
      bpmStream.getTracks().forEach(t => t.stop());
      bpmStream = null;
    }
  }

  function estimateBpmFromSeries(values, durationSec) {
    const k = 4;
    const smooth = values.map((_, i, arr) => {
      let s = 0, c = 0;
      for (let j = -k; j <= k; j++) {
        const idx = i + j;
        if (arr[idx] != null) { s += arr[idx]; c++; }
      }
      return s / c;
    });
    const diffs = smooth.map((v, i) => i ? v - smooth[i - 1] : 0);
    const peaks = [];
    for (let i = 1; i < diffs.length - 1; i++) {
      if (diffs[i - 1] > 0 && diffs[i] <= 0) peaks.push(i);
    }
    if (peaks.length < 2) return null;
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) intervals.push(peaks[i] - peaks[i - 1]);
    const avgInterval = intervals.reduce((a,b)=>a+b,0) / intervals.length;
    const fps = values.length / durationSec;
    const bpm = Math.round((60 * fps) / avgInterval);
    if (!isFinite(bpm) || bpm <= 20 || bpm >= 220) return null;
    return bpm;
  }

  async function measureBpm(durationSec = 15) {
    if (!bpmVideo) return;
    const vals = [];
    const start = performance.now();
    const loop = () => {
      if (!bpmVideo.videoWidth || !bpmVideo.videoHeight) {
        bpmLoopId = requestAnimationFrame(loop); return;
      }
      const w = 160, h = 120;
      bpmCanvas.width = w; bpmCanvas.height = h;
      bpmCtx.drawImage(
        bpmVideo,
        (bpmVideo.videoWidth - w) / 2, (bpmVideo.videoHeight - h) / 2, w, h,
        0, 0, w, h
      );
      const frame = bpmCtx.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < frame.length; i += 4) sum += frame[i];
      vals.push(sum / (frame.length / 4));

      const t = (performance.now() - start) / 1000;
      if (t < durationSec) {
        const remain = Math.max(0, durationSec - t);
        bpmStatus.textContent = T.bpmMeasuring(Math.ceil(remain));
        bpmLoopId = requestAnimationFrame(loop);
      } else {
        const bpm = estimateBpmFromSeries(vals, durationSec) ?? defaultBpm;
        lastMeasuredBpm = bpm;
        bpmStatus.textContent = T.bpmResult(bpm);
        setTimeout(async () => {
          showScreen('camera');
          const fHud = document.getElementById('fvalue-display-camera');
          if (fHud) fHud.textContent = `F: ${Math.round(parseFloat(apertureInput.value))}`;
          updateCameraHudBpm();
          await startCamera('environment');
        }, 800);
        stopBpmCamera();
      }
    };
    loop();
  }
  document.getElementById('bpm-start-btn')?.addEventListener('click', () => {
    bpmStatus.textContent = '計測中…';
    measureBpm(15);
  });
  document.getElementById('bpm-skip-btn')?.addEventListener('click', async () => {
    lastMeasuredBpm = defaultBpm;
    stopBpmCamera();
    showScreen('camera');
    updateCameraHudBpm();
    await startCamera('environment');
  });

  // ====== シャッター（BPM→SS + F値焼き込み） ======
  const shutterBtn = document.getElementById('camera-shutter-btn');
  const bpmHud = document.getElementById('bpm-display-camera');

  // 表示用（HUD）：1/BPM をそのまま
  function displayShutterLabelFromBpm(bpm) {
    const d = Math.max(1, Math.round(bpm || 60));
    return `1/${d}s`;
  }

  // 実際の露光（ブレ量）：BPM=50→1s, BPM=200→1/200s を基準に “過敏” に
  function actualExposureSecFromBpm(bpm, sensitivity = 3.0) {
    const B = Math.max(1, bpm || 60);
    const B2 = 200;
    const SS2 = 1 / 200;

    const kBase = Math.log(200) / Math.log(4); // ≈3.82
    const k = kBase * sensitivity;             // 感度↑で差が大きくなる（2.0〜3.5）

    const ss = SS2 * Math.pow(B2 / B, k);
    return Math.max(1/2000, Math.min(3.5, ss)); // 最大3.5sまで許可
  }

  function exposureTimeSec() {
    const bpm = lastMeasuredBpm || defaultBpm;
    return actualExposureSecFromBpm(bpm, 3.5);  // 強めにブレを出す
  }

  // HUD更新（表示は 1/BPM）
  function updateCameraHudBpm() {
    const bpm = lastMeasuredBpm || defaultBpm;
    const label = displayShutterLabelFromBpm(bpm);
    bpmHud.textContent = `BPM: ${bpm || '--'} / SS: ${label}`;
  }
  updateCameraHudBpm();

  // 残像の消え方（フェード）をBPMで変える：低BPM→残像長い / 高BPM→短い
  function trailFadeFromBpm(bpm) {
    const B = Math.max(1, bpm || 60);
    // 60..200 を 0..1 に正規化して、0.06 → 0.20 へ遷移（クランプ 0.04..0.24）
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const t = clamp((B - 60) / (200 - 60), 0, 1);
    return clamp(0.06 + (0.20 - 0.06) * t, 0.04, 0.24);
  }

  const sleep = ms => new Promise(res => setTimeout(res, ms));

  // StackBlur の存在確認
  if (!window.StackBlur || !StackBlur.canvasRGBA) {
    console.warn('StackBlurが読み込まれていません（プレビュー/保存時のボケはスキップされます）');
  }

  // ====== ファイル名（メタ） ======
  function fmtShutterLabel(sec) { return sec >= 1 ? `${sec.toFixed(1)}s` : `1-${Math.round(1/sec)}`; }
  function safeNum(n) { return String(n).replace('.', '-'); }
  function buildFilename({ fValue, bpm, shutterSec, when = new Date(), who = 'anon', room = 'room' }) {
    const pad = (x) => x.toString().padStart(2, '0');
    const y = when.getFullYear(), m = pad(when.getMonth()+1), d = pad(when.getDate());
    const hh = pad(when.getHours()), mm = pad(when.getMinutes()), ss = pad(when.getSeconds());
    const fStr = safeNum(Number(fValue).toFixed(1));
    const bpmStr = bpm ?? '--';
    const ssStr = fmtShutterLabel(shutterSec);
    return `cocoro_${y}-${m}-${d}_${hh}-${mm}-${ss}_${room}_${who}_F${fStr}_BPM${bpmStr}_SS${ssStr}.png`;
  }

  // ====== 撮影履歴（モーダルに表示） ======
  const savedPhotos = []; // { url, filename }

  // ====== シャッター処理 ======
  shutterBtn?.addEventListener('click', async () => {
    try {
      if (!video.videoWidth) return;

      const maxW = 1600;
      const scale = Math.min(1, maxW / video.videoWidth);

      const captureCanvas = rawCanvas || document.createElement('canvas');
      captureCanvas.width  = Math.round(video.videoWidth  * scale);
      captureCanvas.height = Math.round(video.videoHeight * scale);
      const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });

      // ① 露光シミュレーション（ブレのみ・光の積算なし：残像方式＋微ブラー）
      const sec = exposureTimeSec();
      const frameRate = 40; // 30→40にアップ（サンプル密度↑）
      const frameCount = Math.max(1, Math.round(sec * frameRate));

      // 残像の消え方（BPMに応じて変化）：低BPMほど長く残す
      const fade = trailFadeFromBpm(lastMeasuredBpm || defaultBpm); // 例: 0.06〜0.20

      ctx.clearRect(0, 0, captureCanvas.width, captureCanvas.height);
      for (let i = 0; i < frameCount; i++) {
        // 前フレームを少しだけ暗くして残像を伸ばす（光は積算しない）
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(0,0,0,${fade})`;
        ctx.fillRect(0, 0, captureCanvas.width, captureCanvas.height);

        // “なめらかブレ”のための軽いブラー（軌跡をぬるっと繋ぐ）
        ctx.filter = 'blur(0.6px)';   // 0.4〜1.0px 好みで
        ctx.globalAlpha = 1;
        ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
        ctx.filter = 'none';

        await sleep(1000 / frameRate);
      }
      ctx.globalAlpha = 1;

      // ② F値の明暗/コントラスト/彩度
      applyFValuePixels(ctx, captureCanvas.width, captureCanvas.height, selectedFValue);

      // ③ F値ぼけ
      const blurRadius = fToBlurRadius(selectedFValue);
      if (blurRadius > 0 && window.StackBlur?.canvasRGBA) {
        StackBlur.canvasRGBA(captureCanvas, 0, 0, captureCanvas.width, captureCanvas.height, blurRadius);
      }

      // 共有・保存用データ準備
      const who  = (document.getElementById('participant-name')?.value || 'anon').trim() || 'anon';
      const room = (document.getElementById('room-code')?.value || 'room').trim() || 'room';
      const filename = buildFilename({
        fValue: selectedFValue,
        bpm: (lastMeasuredBpm || null),
        shutterSec: sec,
        who, room,
      });

      const blob = await new Promise((resolve) => {
        if (captureCanvas.toBlob) {
          captureCanvas.toBlob(b => resolve(b), 'image/png', 1.0);
        } else {
          const dataURL = captureCanvas.toDataURL('image/png');
          fetch(dataURL).then(r => r.blob()).then(resolve);
        }
      });
      if (!blob) throw new Error('blob 生成に失敗');

      const objectURL = URL.createObjectURL(blob);

      // 撮影履歴へ保存（下部サムネは作らない）
      savedPhotos.push({ url: objectURL, filename });

      // 共有シート → だめならDL
      const file = new File([blob], filename, { type: 'image/png' });
      try {
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: 'ココロカメラ', text: '今日の一枚' });
        } else {
          const a = document.createElement('a');
          a.href = objectURL; a.download = filename;
          document.body.appendChild(a); a.click(); a.remove();
        }
      } catch {
        const a = document.createElement('a');
        a.href = objectURL; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
      }

    } catch (err) {
      console.error('Capture error:', err);
      alert('撮影に失敗しました。ページを再読み込みしてもう一度お試しください。');
    }
  });

  // ====== 画像処理（保存/プレビュー共通） ======
  function applyFValuePixels(ctx, w, h, f) {
    const { brightness, contrast, saturate } = fParams(f);
    const id = ctx.getImageData(0, 0, w, h);
    const data = id.data;
    const adj = (v) => {
      const gamma = brightness; // brightness をガンマ値として利用
      let x = 255 * Math.pow(v / 255, gamma);
      x = ((x - 128) * contrast) + 128; // コントラスト適用
      return x < 0 ? 0 : x > 255 ? 255 : x;
    };

    for (let i = 0; i < data.length; i += 4) {
      let r = adj(data[i]), g = adj(data[i+1]), b = adj(data[i+2]);
      const avg = (r + g + b) / 3;
      r = avg + (r - avg) * saturate;
      g = avg + (g - avg) * saturate;
      b = avg + (b - avg) * saturate;
      data[i]   = r < 0 ? 0 : r > 255 ? 255 : r;
      data[i+1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[i+2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    ctx.putImageData(id, 0, 0);
  }

  // ====== 情報ボタン：撮影履歴モーダル ======
  const infoBtn = document.getElementById('camera-info-btn');
  infoBtn?.addEventListener('click', showGalleryModal);

  function showGalleryModal() {
    const modal = document.getElementById('gallery-modal');
    if (!modal) return;
    const grid = modal.querySelector('#gallery-grid');
    const closeBtn = modal.querySelector('#gallery-close-btn');
    // グリッド描画
    grid.innerHTML = savedPhotos.length
      ? savedPhotos.map(p => `
          <div class="cc-grid-item">
            <img src="${p.url}" alt="${p.filename}" class="cc-grid-img" />
            <p class="cc-grid-name">${p.filename}</p>
            <div class="cc-grid-actions">
              <a href="${p.url}" download="${p.filename}" class="cc-btn cc-btn--light">保存</a>
              <button data-share="${p.url}" data-name="${p.filename}" class="cc-btn">共有</button>
            </div>
          </div>
        `).join('')
      : `<p class="cc-empty">まだ写真がありません。撮影してみましょう。</p>`;

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    // 閉じる
    const backdrop = modal.querySelector('.cc-modal-backdrop');
    const close = () => {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    };
    closeBtn.onclick = close;
    backdrop.onclick = close;

    // 共有（イベント委任）
    grid.onclick = async (e) => {
      const btn = e.target.closest('button[data-share]');
      if (!btn) return;
      const url = btn.getAttribute('data-share');
      const name = btn.getAttribute('data-name') || 'photo.png';
      try {
        // URL から blob を得る（ObjectURLでもOK）
        const blob = await fetch(url).then(r => r.blob());
        const file = new File([blob], name, { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: 'ココロカメラ', text: name });
        } else {
          const a = document.createElement('a');
          a.href = url; a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
        }
      } catch (err) {
        console.error(err);
      }
    };
  }

  // ====== 初期表示 ======
  showScreen('initial');
});
