// ココロカメラ：F値→明暗(1/f²)・BPM→SS(1/BPM秒)・軽量プレビュー/保存・ギャラリー
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

  // ====== 文言 ======
  const T = {
    appTitle: "ココロカメラ",
    splashTagline: "あなたの心のシャッターを切る",
    start: "はじめる",
    next: "次へ",
    howtoTitle: "名前とルームコードの入力",
    howtoText: "あなたの名前（ニックネーム）とルームコードを<br>入力してください。（任意）",
    fInputTitle: "今の心の状態に合わせて<br>円を広げたり縮めたりしてください",
    fHint1: "F値が小さい=開放的",
    fHint2: "F値が大きい＝集中している",
    decide: "決定",
    bpmTitle: "ココロのシャッタースピード",
    bpmPrep_html: 'カメラに<strong>指先を軽く当てて</strong>ください<br>赤みの変化から心拍数を測定します',
    bpmReady: "準備ができたら計測開始を押してください",
    bpmStart: "計測開始",
    skip: "スキップ",
    switchCam: "切り替え",
    shoot: "撮影",
    info: "ギャラリー",
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

  // Canvas2D の filter サポート検出（trueなら ctx.filter が使える）
const CANVAS_FILTER_SUPPORTED = (() => {
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    return ctx && ('filter' in ctx);
  } catch { return false; }
})();

  // ====== 要素参照 ======
  const video = document.getElementById('video');
  const rawCanvas = document.getElementById('canvas');

  // 表示用キャンバス（プレビュー）を重ねる
  const previewCanvas = document.createElement('canvas');
  const previewCtx = previewCanvas.getContext('2d');
  if (screens.camera) {
    Object.assign(previewCanvas.style, {
      position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', zIndex: '1'
    });
    // videoの前に挿入（videoは非表示にするのでOK）
    screens.camera.insertBefore(previewCanvas, screens.camera.firstChild);
  }

  // ====== カメラ/プレビュー制御 ======
  const PREVIEW_FPS = 15;
  let lastPreviewTs = 0;
  let currentStream = null;
  let isFrontCamera = false;
  let rafId = null;

  let currentFacing = 'environment';     // 'user' or 'environment'
  const FORCE_UNMIRROR_FRONT = true;   
  
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

        previewCtx.save();
        previewCtx.imageSmoothingEnabled = true;

       // まずは素の絵を描く（毎フレーム）
previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

// ここでフロントの自動ミラーを“反転描画”で打ち消す
if (currentFacing === 'user' && FORCE_UNMIRROR_FRONT) {
  // ← すでに上で previewCtx.save() 済みなので、その座標系を一時的に反転
  previewCtx.translate(previewCanvas.width, 0);
  previewCtx.scale(-1, 1);
}
previewCtx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);

// ★ Canvas2D.filter 非対応端末では、プレビューも手動合成で明暗を適用
if (!CANVAS_FILTER_SUPPORTED) {
  applyBrightnessComposite(
    previewCtx,
    currentBrightness,
    previewCanvas.width,
    previewCanvas.height,
    CONTRAST_GAIN
  );
}
        previewCtx.restore();
      }
    }
    rafId = requestAnimationFrame(render);
  };
  rafId = requestAnimationFrame(render);
}

  function stopPreviewLoop(){ if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

async function startCamera(facingMode = 'environment') {
  try {
    if (currentStream) currentStream.getTracks().forEach(t => t.stop());

    const constraints = {
      video: {
        // まずは facingMode を素直に要求
        facingMode: (facingMode === 'user') ? { ideal: 'user' } : { ideal: 'environment' },
        width: { ideal: 1280 }, height: { ideal: 720 }
      },
      audio: false
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();

    currentStream = stream;
    currentFacing = facingMode;

    // 実videoは非表示。プレビューCanvasに描く
    video.style.display = 'none';
    startPreviewLoop();
  } catch (err) {
    console.error('カメラエラー:', err);
    alert(T.cameraError);
  }
}

// ====== F値→明暗 (強化版 1/f² + 共通フィルタ) ======
let selectedFValue = 32.0;
const MIN_F = 1.0, MAX_F = 32.0;

const BRIGHT_MIN = 0.12;      // 暗側の下限
const BRIGHT_MAX = 3.6;       // 明側の上限
const BRIGHT_STRENGTH = 1.35; // カーブ強調（↑で暗側がより暗く）
const CONTRAST_GAIN = 1.10;   // ほんの少しコントラスト

let currentBrightness = 1.0;

const clamp = (x,a,b)=>Math.min(Math.max(x,a),b);

function brightnessFromF(f){
  const t = Math.max(0, Math.min(1, (f - MIN_F) / (MAX_F - MIN_F)));
  const t2 = Math.pow(t, BRIGHT_STRENGTH);
  const lnMin = Math.log(BRIGHT_MIN), lnMax = Math.log(BRIGHT_MAX);
  return Math.exp( lnMax + (lnMin - lnMax) * t2 );
}

// プレビュー/保存 共通：同じフィルタ文字列を返す
function buildFilterString(){
  return `brightness(${currentBrightness}) contrast(${CONTRAST_GAIN})`;
}

// F値変更時：プレビューに反映
function applyFnumberLight(f){
  currentBrightness = brightnessFromF(f);
  if (previewCanvas) {
    if (CANVAS_FILTER_SUPPORTED) {
      // 対応端末：CSSフィルタで軽く＆見やすく
      previewCanvas.style.filter = buildFilterString();
    } else {
      // 未対応端末：CSSフィルタは外し、描画側で合成（後述）に任せる
      previewCanvas.style.filter = 'none';
    }
  }
}

  // ====== 画面遷移 ======
  document.getElementById('initial-next-btn')?.addEventListener('click', () => showScreen('introduction'));
  document.getElementById('intro-next-btn')?.addEventListener('click', () => showScreen('fvalue'));

  // ====== F値（ピンチ操作） ======
  const apertureControl = document.querySelector('.aperture-control');
  const fValueDisplay   = document.getElementById('f-value-display');
  const apertureInput   = document.getElementById('aperture');

  const MIN_SIZE = 100, MAX_SIZE = 250;
  const fToSize = f => MIN_SIZE + ((MAX_F - f) / (MAX_F - MIN_F)) * (MAX_SIZE - MIN_SIZE);
  const sizeToF = size => MAX_F - ((size - MIN_SIZE) / (MAX_SIZE - MIN_SIZE)) * (MAX_F - MIN_F);

  if (apertureControl && fValueDisplay && apertureInput) {
    const initialSize = fToSize(selectedFValue);
    apertureControl.style.width = apertureControl.style.height = `${initialSize}px`;
    fValueDisplay.textContent = String(selectedFValue);
    apertureInput.value = String(selectedFValue);
    applyFnumberLight(selectedFValue);
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
      const roundedF = Math.round(newF);
      const snappedSize = fToSize(roundedF);

      apertureControl.style.width = apertureControl.style.height = `${snappedSize}px`;
      fValueDisplay.textContent = String(roundedF);
      apertureInput.value = String(roundedF);

      applyFnumberLight(roundedF); // 即時反映
      lastDistance = current;
    }
  }, { passive: false });
  document.body.addEventListener('touchend', () => { lastDistance = null; });

  // F値決定 → BPM計測へ
  document.getElementById('f-value-decide-btn')?.addEventListener('click', async () => {
    const f = Math.round(parseFloat(apertureInput.value));
    selectedFValue = f;
    document.querySelector('.aperture-control')?.setAttribute('aria-valuenow', String(f));
    applyFnumberLight(f);
    showScreen('bpm');
    await startBpmCamera();
  });

  // ====== BPM 計測 ======
  const bpmVideo = document.getElementById('bpm-video');
  const bpmCanvas = document.getElementById('bpm-canvas');
  const bpmCtx = bpmCanvas.getContext('2d');
  const bpmStatus = document.getElementById('bpm-status');
  let bpmStream = null;
  let bpmLoopId = null;
  const defaultBpm = 60;
  let lastMeasuredBpm = 0;

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
      let sumR = 0;
      for (let i = 0; i < frame.length; i += 4) sumR += frame[i];
      vals.push(sumR / (frame.length / 4));

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

  // ====== SS(1/BPM) と HUD ======
  const shutterBtn = document.getElementById('camera-shutter-btn');
  const bpmHud = document.getElementById('bpm-display-camera');

  function displayShutterLabelFromBpm(bpm) {
    const d = Math.max(1, Math.round(bpm || 60));
    return `1/${d}s`;
  }
  function exposureTimeSec() {
    const bpm = lastMeasuredBpm || defaultBpm;
    const sec = 1 / Math.max(1, bpm);
    return Math.max(1/2000, Math.min(2.0, sec)); // 安全クリップ
  }
  function updateCameraHudBpm() {
    const bpm = lastMeasuredBpm || defaultBpm;
    const label = displayShutterLabelFromBpm(bpm);
    if (bpmHud) bpmHud.textContent = `BPM: ${bpm || '--'} / SS: ${label}`;
  }
  updateCameraHudBpm();

  // 残像フェード（低BPM→長／高BPM→短）
  function trailFadeFromBpm(bpm) {
    const B = Math.max(1, bpm || 60);
    const t = clamp((B - 60) / (200 - 60), 0, 1);
    return clamp(0.06 + (0.20 - 0.06) * t, 0.04, 0.24);
  }
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  // ====== ファイル名 ======
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

  // ====== 撮影履歴 ======
  const savedPhotos = []; // { url, filename }
  
  document.getElementById('camera-switch-btn')?.addEventListener('click', async () => {
    const next = (currentFacing === 'user') ? 'environment' : 'user';
    await startCamera(next);
  });
  // ====== シャッター処理（1/BPMの擬似露光 + 1/f²の明暗を焼き込み） ======
  shutterBtn?.addEventListener('click', async () => {
    try {
      if (!video.videoWidth) return;

      const maxW = 1600;
      const scale = Math.min(1, maxW / video.videoWidth);

      const captureCanvas = rawCanvas || document.createElement('canvas');
      captureCanvas.width  = Math.round(video.videoWidth  * scale);
      captureCanvas.height = Math.round(video.videoHeight * scale);
      const ctx = captureCanvas.getContext('2d', { willReadFrequently: false });

      const sec = exposureTimeSec();  // 1/BPM 秒
      const frameRate = 40;
      const frameCount = Math.max(1, Math.round(sec * frameRate));
      const fade = trailFadeFromBpm(lastMeasuredBpm || defaultBpm);

ctx.clearRect(0, 0, captureCanvas.width, captureCanvas.height);
for (let i = 0; i < frameCount; i++) {
  // 残像フェード
  ctx.globalAlpha = 1;
  ctx.fillStyle = `rgba(0,0,0,${fade})`;
  ctx.fillRect(0, 0, captureCanvas.width, captureCanvas.height);

  // ★ 端末対応で分岐：見た目＝保存を一致させる
// ★ 端末対応で分岐：見た目＝保存を一致させる（B＝どちらも非反転）
if (CANVAS_FILTER_SUPPORTED) {
  ctx.filter = buildFilterString(); // 例: brightness(...) contrast(...)
  ctx.globalAlpha = 1;

  if (currentFacing === 'user' && FORCE_UNMIRROR_FRONT) {
    ctx.save();
    ctx.translate(captureCanvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    ctx.restore();
  } else {
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  }

  ctx.filter = 'none';
} else {
  ctx.globalAlpha = 1;

  if (currentFacing === 'user' && FORCE_UNMIRROR_FRONT) {
    ctx.save();
    ctx.translate(captureCanvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    ctx.restore();
  } else {
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  }

  applyBrightnessComposite(
    ctx,
    currentBrightness,
    captureCanvas.width,
    captureCanvas.height,
    CONTRAST_GAIN
  );
}
  
  await sleep(1000 / frameRate);
}
      ctx.globalAlpha = 1;

      // 共有・保存
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
      savedPhotos.push({ url: objectURL, filename });

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

  // ====== 情報ボタン：ギャラリーモーダル ======
  const infoBtn = document.getElementById('camera-info-btn');
  infoBtn?.addEventListener('click', showGalleryModal);

  function showGalleryModal() {
    const modal = document.getElementById('gallery-modal');
    if (!modal) return;
    const grid = modal.querySelector('#gallery-grid');
    const closeBtn = modal.querySelector('#gallery-close-btn');

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

    const backdrop = modal.querySelector('.cc-modal-backdrop');
    const close = () => {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    };
    if (closeBtn) closeBtn.onclick = close;
    if (backdrop) backdrop.onclick = close;

    grid.onclick = async (e) => {
      const btn = e.target.closest('button[data-share]');
      if (!btn) return;
      const url = btn.getAttribute('data-share');
      const name = btn.getAttribute('data-name') || 'photo.png';
      try {
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

  // ====== 手動合成（filter非対応端末向け）：明るさ＆コントラスト近似 ======
function applyBrightnessComposite(ctx, brightness, w, h, contrastGain = 1.0){
  // 明るさ：b<1 は黒で multiply、b>1 は白で screen
  if (brightness < 1) {
    const a = Math.max(0, Math.min(1, 1 - brightness));
    if (a > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = a;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  } else if (brightness > 1) {
    const a = Math.max(0, Math.min(1, 1 - (1/brightness)));
    if (a > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = a;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  // コントラスト：overlay 相当を薄く（過度に強くしない）
  if (Math.abs(contrastGain - 1.0) > 1e-3) {
    const a = Math.min(0.5, (contrastGain - 1.0) * 0.6);
    if (a > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgb(127,127,127)';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  // 後始末
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

  // ====== 初期表示 ======
  showScreen('initial');
});




