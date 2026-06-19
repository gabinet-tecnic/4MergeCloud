// main.js — 4 Merge Cloud viewer
import * as THREE from './three/three.module.js';
import { OrbitControls } from './jsm/controls/OrbitControls.js';
import { TransformControls } from './jsm/controls/TransformControls.js';
import { loadPLY, loadXYZ } from './loaders/pointcloud_loaders.js';

// ── Textos UI (CA / EN) ──────────────────────────────────────────────────────
const T = (window.APP_LANG === 'en') ? {
  noCloudLoaded:  'Load a cloud first.',
  noBoxCreated:   'Create a clipping box first.',
  unsupported:    ext  => `Unsupported format: ${ext}`,
  loadError:      (n, m) => `Error loading ${n}: ${m}`,
  noClouds:       'No clouds loaded.',
  resetConfirm:   'Delete all clouds, clipping boxes and measurements?',
  alignPick:      n    => `${n}-point alignment — click the cloud to move · ESC to cancel`,
  alignSrc:       (c, t) => `SOURCE point ${c}/${t} — click the selected cloud · ESC to cancel`,
  alignTgt:       (c, t) => `TARGET point ${c}/${t} — click the reference cloud · ESC to cancel`,
  needTwoClouds:  'Load at least 2 clouds to use alignment.',
} : {
  noCloudLoaded:  'Primer carrega un núvol.',
  noBoxCreated:   'Primer crea una caixa de tall.',
  unsupported:    ext  => `Format no suportat: ${ext}`,
  loadError:      (n, m) => `Error carregant ${n}: ${m}`,
  noClouds:       'No hi ha núvols carregats.',
  resetConfirm:   'Esborrar tots els núvols, caixes de tall i cotes?',
  alignPick:      n    => `Alineació ${n}pt — fes clic al núvol que vols moure · ESC per cancel·lar`,
  alignSrc:       (c, t) => `Punt ORIGEN ${c}/${t} — fes clic al núvol seleccionat · ESC per cancel·lar`,
  alignTgt:       (c, t) => `Punt DESTÍ ${c}/${t} — fes clic al núvol de referència · ESC per cancel·lar`,
  needTwoClouds:  'Cal tenir almenys 2 núvols carregats per alinear.',
};

let scene, camera, renderer, controls, transformControls;

// Càmera ortogràfica (vistes planes)
let orthoCamera = null;
let orthoControls = null;
let useOrtho = false;

const clouds = [];
let selectedCloud = null;
let cloudTCMode = 'translate';

// ── State machine ─────────────────────────────────────────────────────────────
// MODE: 'none' | 'translate' | 'rotate' | 'clipbox_translate' | 'clipbox_rotate' | 'align' | 'measure'
let appMode = 'none';

function setMode(newMode) {
  appMode = newMode;
  updateModeBadge();
}

function updateModeBadge() {
  const badge = document.getElementById('modeBadge');
  if (!badge) return;
  const labels = {
    'none': '',
    'translate': window.APP_LANG === 'en' ? 'MOVE CLOUD' : 'MOURE NÚVOL',
    'rotate': window.APP_LANG === 'en' ? 'ROTATE CLOUD' : 'ROTAR NÚVOL',
    'clipbox_translate': window.APP_LANG === 'en' ? 'MOVE CLIPPING BOX' : 'MOURE CAIXA DE TALL',
    'clipbox_rotate': window.APP_LANG === 'en' ? 'ROTATE CLIPPING BOX' : 'ROTAR CAIXA DE TALL',
    'align': '',   // el badge d'alineació ja ho gestiona
    'measure': '', // el badge de mesura ja ho gestiona
  };
  const label = labels[appMode] || '';
  badge.textContent = label;
  badge.style.display = label ? 'block' : 'none';
}
// ─────────────────────────────────────────────────────────────────────────────

// Clipping en temps real
const LOCAL_CLIP_PLANES = [
  new THREE.Plane(new THREE.Vector3( 1, 0, 0), 0.5),
  new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.5),
  new THREE.Plane(new THREE.Vector3( 0, 1, 0), 0.5),
  new THREE.Plane(new THREE.Vector3( 0,-1, 0), 0.5),
  new THREE.Plane(new THREE.Vector3( 0, 0, 1), 0.5),
  new THREE.Plane(new THREE.Vector3( 0, 0,-1), 0.5),
];

const selectableObjects = [];
const raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 0.1 };

const mouse = new THREE.Vector2();

let measuring = false;
let currentMeasurePoints = [];
let currentMeasureMarkers = [];
let measurements = [];

// Desfer (undo)
const undoStack = [];
const MAX_UNDO = 20;

function pushUndo(cloud, saveGeometry = false) {
  if (!cloud) return;
  undoStack.push({
    cloud,
    position: cloud.position.clone(),
    quaternion: cloud.quaternion.clone(),
    geometry: saveGeometry ? cloud.geometry : null  // referència (no còpia)
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoBtn();
}

function doUndo() {
  if (!undoStack.length) return;
  const state = undoStack.pop();
  const cloud = state.cloud;
  cloud.position.copy(state.position);
  cloud.quaternion.copy(state.quaternion);
  if (state.geometry && state.geometry !== cloud.geometry) {
    cloud.geometry.dispose();
    cloud.geometry = state.geometry;
  }
  cloud.updateMatrixWorld(true);
  const box = cloud.userData.clipBox;
  if (box && cloud.userData.boxRelMatrix) {
    const m = new THREE.Matrix4().multiplyMatrices(cloud.matrixWorld, cloud.userData.boxRelMatrix);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    box.position.copy(p); box.quaternion.copy(q); box.scale.copy(s);
    box.updateMatrixWorld(true);
  }
  if (selectedCloud === cloud) {
    transformControls.attach(cloud);
    syncNumericInputs(cloud);
  }
  updateUndoBtn();
}

function updateUndoBtn() {
  const btn = document.getElementById('btnUndo');
  if (!btn) return;
  btn.disabled = undoStack.length === 0;
  btn.style.color = undoStack.length > 0 ? '#ddd' : '#888';
  btn.style.background = undoStack.length > 0 ? '#333' : '#2a2a2a';
}

// Alineació
let alignMode  = 0;       // 0=off, 2=2pt, 3=3pt
let alignPhase = 'src';   // 'src' | 'tgt'
let alignSrcPts = [];
let alignTgtPts = [];
let alignMarkers = [];
let alignSrcCloud = null;

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────
function init() {
  const container = document.getElementById('viewer');
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202020);
  scene.add(new THREE.AxesHelper(1));

  camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 1e7);
  camera.position.set(0, 0, 5);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = false;
  controls.update();

  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setSize(0.7);
  transformControls.setMode('translate');
  scene.add(transformControls);

  transformControls.addEventListener('dragging-changed', (e) => {
    if (e.value) {
      const obj = transformControls.object;
      if (obj && clouds.includes(obj)) pushUndo(obj);
    }
    if (!e.value) {
      const obj = transformControls.object;
      if (obj && obj.userData.parentCloud) {
        const pc = obj.userData.parentCloud;
        pc.updateMatrixWorld(true);
        obj.updateMatrixWorld(true);
        pc.userData.boxRelMatrix = new THREE.Matrix4()
          .copy(pc.matrixWorld).invert()
          .multiply(obj.matrixWorld);
      }
    }
    if (useOrtho) {
      if (orthoControls) orthoControls.enabled = !e.value;
    } else {
      controls.enabled = !e.value;
    }
  });

  transformControls.addEventListener('change', () => {
    const obj = transformControls.object;
    if (!obj || !clouds.includes(obj)) return;
    const box = obj.userData.clipBox;
    if (!box || !obj.userData.boxRelMatrix) return;
    obj.updateMatrixWorld(true);
    const m = new THREE.Matrix4().multiplyMatrices(obj.matrixWorld, obj.userData.boxRelMatrix);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    box.position.copy(p);
    box.quaternion.copy(q);
    box.scale.copy(s);
    box.updateMatrixWorld(true);
  });

  // Càmera ortogràfica
  const aspect = width / height;
  orthoCamera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, -1e6, 1e6);
  orthoControls = new OrbitControls(orthoCamera, renderer.domElement);
  orthoControls.enableDamping = false;
  orthoControls.enabled = false;

  window.addEventListener('resize', onWindowResize);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('wheel', onMouseWheel, { passive: false });
}

// ─────────────────────────────────────────────
// Resize
// ─────────────────────────────────────────────
function onWindowResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const a = w / h;

  camera.aspect = a;
  camera.updateProjectionMatrix();

  if (orthoCamera) {
    const hH = (orthoCamera.top - orthoCamera.bottom) / 2;
    orthoCamera.left   = -hH * a;
    orthoCamera.right  =  hH * a;
    orthoCamera.updateProjectionMatrix();
  }

  renderer.setSize(w, h);
}

// ─────────────────────────────────────────────
// Mida adaptativa de punts
// ─────────────────────────────────────────────
function adaptPointSize(cloud) {
  cloud.material.sizeAttenuation = false;
  cloud.material.size = 3;
  cloud.material.needsUpdate = true;
}

// ─────────────────────────────────────────────
// Clipping en temps real
// ─────────────────────────────────────────────
function updateClipPlanes() {
  clouds.forEach(cloud => {
    const box = cloud.userData.clipBox;
    if (!box) { cloud.material.clippingPlanes = []; return; }
    box.updateMatrixWorld(true);
    cloud.material.clippingPlanes = LOCAL_CLIP_PLANES.map(p =>
      p.clone().applyMatrix4(box.matrixWorld)
    );
    cloud.material.needsUpdate = true;
  });
}

function removeClipBox() {
  const cloud = selectedCloud || clouds.find(c => c.userData.clipBox);
  if (!cloud || !cloud.userData.clipBox) return;
  const box = cloud.userData.clipBox;
  scene.remove(box);
  box.geometry.dispose(); box.material.dispose();
  const si = selectableObjects.indexOf(box);
  if (si >= 0) selectableObjects.splice(si, 1);
  cloud.userData.clipBox = null;
  cloud.userData.boxRelMatrix = null;
  cloud.material.clippingPlanes = [];
  cloud.material.needsUpdate = true;
  if (selectedCloud) transformControls.attach(selectedCloud);
  else transformControls.detach();
  // Torna al mode del núvol
  if (appMode === 'clipbox_translate' || appMode === 'clipbox_rotate') {
    setMode(cloudTCMode);
  }
}

function getActiveClipBox() {
  return selectedCloud?.userData.clipBox ?? null;
}

function syncClipBox(cloud) {
  if (!cloud) return;
  const box = cloud.userData.clipBox;
  if (!box || !cloud.userData.boxRelMatrix) return;
  cloud.updateMatrixWorld(true);
  const m = new THREE.Matrix4().multiplyMatrices(cloud.matrixWorld, cloud.userData.boxRelMatrix);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  box.position.copy(p); box.quaternion.copy(q); box.scale.copy(s);
  box.updateMatrixWorld(true);
}

function resetAll() {
  if (!confirm(T.resetConfirm)) return;

  clouds.forEach(cloud => {
    if (cloud.userData.clipBox) {
      const box = cloud.userData.clipBox;
      scene.remove(box);
      box.geometry.dispose(); box.material.dispose();
      const si = selectableObjects.indexOf(box);
      if (si >= 0) selectableObjects.splice(si, 1);
    }
  });

  [...clouds].forEach(cloud => {
    scene.remove(cloud);
    cloud.geometry.dispose(); cloud.material.dispose();
    const si = selectableObjects.indexOf(cloud);
    if (si >= 0) selectableObjects.splice(si, 1);
  });
  clouds.length = 0;

  clearAllMeasurements();
  clearAlignMarkers();

  selectedCloud = null;
  measuring = false;
  alignMode = 0;
  alignPhase = 'src';
  undoStack.length = 0;
  if (lassoErasing) stopLassoErase();

  transformControls.detach();
  setMode('none');

  const measureBadge = document.getElementById('measureBadge');
  if (measureBadge) measureBadge.style.display = 'none';
  const alignBadge = document.getElementById('alignBadge');
  if (alignBadge) alignBadge.style.display = 'none';

  updateCloudList();
  updateUndoBtn();
  updateMeasureList();
}

// ─────────────────────────────────────────────
// Vistes ortogràfiques
// ─────────────────────────────────────────────
function getSceneBounds() {
  const box = new THREE.Box3();
  clouds.forEach(c => { c.updateMatrixWorld(true); box.expandByObject(c); });
  if (box.isEmpty()) box.set(new THREE.Vector3(-10,-10,-10), new THREE.Vector3(10,10,10));
  return box;
}

function setOrthoView(dir, up) {
  const box    = getSceneBounds();
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 10;
  const W = window.innerWidth, H = window.innerHeight;
  const aspect = W / H;
  const hH = maxDim * 0.6;
  const hW = hH * aspect;

  orthoCamera.left   = -hW;  orthoCamera.right  =  hW;
  orthoCamera.top    =  hH;  orthoCamera.bottom = -hH;
  orthoCamera.near   = -maxDim * 200;
  orthoCamera.far    =  maxDim * 200;
  orthoCamera.updateProjectionMatrix();

  orthoCamera.position.copy(center).addScaledVector(dir.clone().normalize(), maxDim * 2);
  orthoCamera.up.copy(up);
  orthoCamera.lookAt(center);
  orthoControls.target.copy(center);
  orthoControls.update();

  useOrtho = true;
  controls.enabled = false;
  orthoControls.enabled = true;
  transformControls.camera = orthoCamera;

  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('ortho-active'));
}

function activate3DView() {
  useOrtho = false;
  controls.enabled = true;
  orthoControls.enabled = false;
  transformControls.camera = camera;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('ortho-active'));
}

// ─────────────────────────────────────────────
// Alineació estil AutoCAD (2 i 3 punts)
// ─────────────────────────────────────────────
function startAlign(n) {
  if (measuring) return;
  if (clouds.length < 2) { alert(T.needTwoClouds); return; }
  alignMode  = n;
  alignPhase = 'pickCloud';
  alignSrcPts = []; alignTgtPts = [];
  alignSrcCloud = null;
  clearAlignMarkers();
  transformControls.detach();
  setMode('align');
  updateAlignBadge();
}

function cancelAlign() {
  alignMode = 0;
  alignSrcCloud = null;
  clearAlignMarkers();
  updateAlignBadge();
  if (selectedCloud) transformControls.attach(selectedCloud);
  setMode(cloudTCMode);
}

function clearAlignMarkers() {
  alignMarkers.forEach(m => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
  alignMarkers = [];
}

function updateAlignBadge() {
  const badge = document.getElementById('alignBadge');
  if (!badge) return;
  if (!alignMode) { badge.style.display = 'none'; return; }
  badge.style.display = 'block';

  if (alignPhase === 'pickCloud') {
    badge.textContent = T.alignPick(alignMode);
    return;
  }
  if (alignPhase === 'src') {
    const cur = alignSrcPts.length + 1;
    badge.textContent = T.alignSrc(cur, alignMode);
    return;
  }
  const cur = alignTgtPts.length + 1;
  badge.textContent = T.alignTgt(cur, alignMode);
}

function handleAlignClick(pWorld, cloud) {
  if (alignPhase === 'pickCloud') {
    alignSrcCloud = cloud;
    alignPhase = 'src';
    selectCloud(cloud);
    updateAlignBadge();
    return;
  }

  const markerR = getCloudMarkerSize();

  if (alignPhase === 'src') {
    if (cloud !== alignSrcCloud) {
      const badge = document.getElementById('alignBadge');
      if (badge) {
        const prev = badge.style.background;
        badge.style.background = 'rgba(180,0,0,0.95)';
        setTimeout(() => { badge.style.background = prev; }, 350);
      }
      return;
    }
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(markerR * 2, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff4400, depthTest: false })
    );
    m.position.copy(pWorld);
    scene.add(m); alignMarkers.push(m);
    alignSrcPts.push(pWorld.clone());
    if (alignSrcPts.length === alignMode) alignPhase = 'tgt';
    updateAlignBadge();
    return;
  }

  if (cloud === alignSrcCloud) {
    const badge = document.getElementById('alignBadge');
    if (badge) {
      const prev = badge.style.background;
      badge.style.background = 'rgba(180,0,0,0.95)';
      setTimeout(() => { badge.style.background = prev; }, 350);
    }
    return;
  }
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(markerR * 2, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x00cc44, depthTest: false })
  );
  m.position.copy(pWorld);
  scene.add(m); alignMarkers.push(m);
  alignTgtPts.push(pWorld.clone());

  if (alignTgtPts.length === alignMode) {
    pushUndo(alignSrcCloud);
    if (alignMode === 2) applyAlign2pt(alignSrcCloud, alignSrcPts, alignTgtPts);
    else                 applyAlign3pt(alignSrcCloud, alignSrcPts, alignTgtPts);
    cancelAlign();
  } else {
    updateAlignBadge();
  }
}

// Alineació 2D (Kabsch XZ) — força rotació entorn l'eix Y vertical.
// Evita el bug del producte vectorial 3D que podia generar reflexions
// quan l'ordre dels punts és diferent entre núvols.

function applyAlign2pt(srcCloud, sp, tp) {
  if (!srcCloud) return;

  // Translació: sp[0] → tp[0]
  const tr = tp[0].clone().sub(sp[0]);

  // Rotació entorn Y: alinear la projecció XZ de sp[0]→sp[1] amb tp[0]→tp[1]
  const sdx = sp[1].x - sp[0].x, sdz = sp[1].z - sp[0].z;
  const tdx = tp[1].x - tp[0].x, tdz = tp[1].z - tp[0].z;
  const sl = Math.sqrt(sdx*sdx + sdz*sdz);
  const tl = Math.sqrt(tdx*tdx + tdz*tdz);

  let q = new THREE.Quaternion();
  if (sl > 1e-4 && tl > 1e-4) {
    const su = sdx/sl, sv = sdz/sl;
    const tu = tdx/tl, tv = tdz/tl;
    // Angle Kabsch: de (su,sv) a (tu,tv); rotació Three.js Y = -theta
    const phi = -Math.atan2(su*tv - sv*tu, su*tu + sv*tv);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), phi);
  }

  // Translació → rotació entorn tp[0]
  srcCloud.position.add(tr);
  srcCloud.position.sub(tp[0]);
  srcCloud.position.applyQuaternion(q);
  srcCloud.position.add(tp[0]);
  srcCloud.quaternion.premultiply(q);

  srcCloud.updateMatrixWorld(true);
  syncClipBox(srcCloud);
  selectCloud(srcCloud);
}

function applyAlign3pt(srcCloud, sp, tp) {
  if (!srcCloud) return;

  const n = sp.length;

  // Centroids en XZ
  let scx=0, scz=0, tcx=0, tcz=0;
  for (let i=0; i<n; i++) { scx+=sp[i].x; scz+=sp[i].z; tcx+=tp[i].x; tcz+=tp[i].z; }
  scx/=n; scz/=n; tcx/=n; tcz/=n;

  // Kabsch 2D: rotació òptima mínims quadrats en el pla XZ
  let num=0, den=0;
  for (let i=0; i<n; i++) {
    const su=sp[i].x-scx, sv=sp[i].z-scz;
    const tu=tp[i].x-tcx, tv=tp[i].z-tcz;
    num += su*tv - sv*tu;
    den += su*tu + sv*tv;
  }
  // rotació Three.js entorn Y = -theta_Kabsch
  const phi = -Math.atan2(num, den);
  const q   = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), phi);

  // Translació: tc - R·sc
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const trX = tcx - (scx*cosP + scz*sinP);
  const trZ = tcz - (-scx*sinP + scz*cosP);
  let trY = 0;
  for (let i=0; i<n; i++) trY += tp[i].y - sp[i].y;
  trY /= n;

  // Aplica al núvol
  srcCloud.position.applyQuaternion(q);
  srcCloud.quaternion.premultiply(q);
  srcCloud.position.x += trX;
  srcCloud.position.y += trY;
  srcCloud.position.z += trZ;

  srcCloud.updateMatrixWorld(true);
  syncClipBox(srcCloud);
  selectCloud(srcCloud);
}

// ─────────────────────────────────────────────
// Auto-align per color i coordenades (v2 — cel·les locals + RANSAC)
// ─────────────────────────────────────────────

// Detecta cel·les locals de 50cm amb color distintiu.
// Cada cel·la és un punt de referència precís (radi ~25cm vs metres d'un centroide global).
function detectLocalColorFeatures(cloud, cellSize = 0.5, maxSamples = 40000) {
  cloud.updateMatrixWorld(true);
  const mw = cloud.matrixWorld;
  const pos = cloud.geometry.getAttribute('position');
  const col = cloud.geometry.getAttribute('color');
  if (!pos || !col) return [];

  const n = pos.count, step = Math.max(1, Math.floor(n / maxSamples));
  const cells = new Map(), v = new THREE.Vector3();

  for (let i = 0; i < n; i += step) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    const cx = Math.round(v.x / cellSize);
    const cy = Math.round(v.y / cellSize);
    const cz = Math.round(v.z / cellSize);
    const key = `${cx},${cy},${cz}`;
    let c = cells.get(key);
    if (!c) { c = { r: 0, g: 0, b: 0, n: 0, sx: 0, sy: 0, sz: 0 }; cells.set(key, c); }
    c.r += col.getX(i); c.g += col.getY(i); c.b += col.getZ(i);
    c.sx += v.x; c.sy += v.y; c.sz += v.z; c.n++;
  }

  const feats = [];
  for (const [, c] of cells) {
    if (c.n < 3) continue;
    const r = c.r / c.n, g = c.g / c.n, b = c.b / c.n;
    const avg = (r + g + b) / 3;
    const cf = Math.sqrt((r - avg) ** 2 + (g - avg) ** 2 + (b - avg) ** 2);
    if (cf < 0.08) continue; // descarta cel·les grises/blanques
    feats.push({
      centroid: new THREE.Vector3(c.sx / c.n, c.sy / c.n, c.sz / c.n),
      r, g, b, cf
    });
  }
  // Limita a les 300 cel·les més colorides per rendiment
  feats.sort((a, b) => b.cf - a.cf);
  return feats.slice(0, 300);
}

// RANSAC sobre correspondències de color:
// prova parells aleatoris i compta quantes altres correspondències
// són geomètricament consistents (distàncies semblants en src i tgt).
function matchFeaturesRANSAC(srcFeats, tgtFeats, maxIter = 400) {
  const colorDist = (a, b) => Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
  const COLOR_THRESH = 0.15;
  const GEO_THRESH   = 0.5;  // metres — tolerància geomètrica
  const MIN_SEP      = 1.0;  // separació mínima entre ancoratges (metres)

  // Per cada feature src, trobem la millor correspondència tgt per color
  const cands = [];
  for (const s of srcFeats) {
    let bestD = COLOR_THRESH, bestT = null;
    for (const t of tgtFeats) {
      const d = colorDist(s, t);
      if (d < bestD) { bestD = d; bestT = t; }
    }
    if (bestT) cands.push({ src: s, tgt: bestT, cd: bestD });
  }
  if (cands.length < 2) return [];

  // RANSAC
  let bestInliers = [];
  const n = cands.length;
  const iters = Math.min(maxIter, n * (n - 1) / 2);

  for (let it = 0; it < iters; it++) {
    const i = Math.floor(Math.random() * n);
    let j = Math.floor(Math.random() * (n - 1));
    if (j >= i) j++;

    const a = cands[i], b = cands[j];
    const dSrc = a.src.centroid.distanceTo(b.src.centroid);
    const dTgt = a.tgt.centroid.distanceTo(b.tgt.centroid);
    if (dSrc < MIN_SEP || dTgt < MIN_SEP) continue;
    if (Math.abs(dSrc - dTgt) / Math.max(dSrc, dTgt) > 0.3) continue;

    const inliers = [a, b];
    for (let k = 0; k < n; k++) {
      if (k === i || k === j) continue;
      const ck = cands[k];
      const d0s = a.src.centroid.distanceTo(ck.src.centroid);
      const d0t = a.tgt.centroid.distanceTo(ck.tgt.centroid);
      const d1s = b.src.centroid.distanceTo(ck.src.centroid);
      const d1t = b.tgt.centroid.distanceTo(ck.tgt.centroid);
      if (Math.abs(d0s - d0t) < GEO_THRESH && Math.abs(d1s - d1t) < GEO_THRESH) {
        inliers.push(ck);
      }
    }
    if (inliers.length > bestInliers.length) bestInliers = [...inliers];
  }

  // Retorna els 3 millors inliers (els de menor distància de color)
  bestInliers.sort((a, b) => a.cd - b.cd);
  return bestInliers.slice(0, 3);
}

// ─────────────────────────────────────────────
// Aplicar tall permanent (crop)
// ─────────────────────────────────────────────
// ── Erase tools: rectangle + freehand lasso ──────────────────────────────────
//
// eraseMode: null | 'rect' | 'lasso'
// Canvas (#lassoCanvas) és purament visual (pointer-events:none sempre).
// Els events pointer/touch es registren al #viewer quan un mode és actiu.
// El canvas WebGL (renderer.domElement) rep pointer-events:none mentre dura.
// ─────────────────────────────────────────────────────────────────────────────

let lassoErasing = false; // true quan qualsevol mode esborrat és actiu
let _eraseMode   = null;  // 'rect' | 'lasso'
let _eraseW = 1, _eraseH = 1; // mida del viewer en el moment d'activar

// Estat rectangle
let _rStart = null, _rEnd = null;

// Estat lasso lliure
let _lPath    = [];
let _lDrawing = false;

// ── Helpers comuns ────────────────────────────────────────────────────────────
function _vp(clientX, clientY) {
  const r = document.getElementById('viewer').getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

function _eraseCanvas() { return document.getElementById('lassoCanvas'); }

function _clearCanvas() {
  const lc = _eraseCanvas();
  lc.getContext('2d').clearRect(0, 0, lc.width, lc.height);
}

function _isControlTarget(e) {
  return e.target && e.target.closest && e.target.closest('#controls, #lassoCancel');
}

// ── Activació / desactivació ──────────────────────────────────────────────────
function _startErase(mode) {
  // Si ja hi ha un mode actiu, el parem primer
  if (lassoErasing) _stopErase();

  lassoErasing = true;
  _eraseMode   = mode;
  _rStart = _rEnd = null;
  _lPath = []; _lDrawing = false;

  measuring = false;
  document.getElementById('measureBadge').style.display = 'none';
  transformControls.detach();

  const viewer = document.getElementById('viewer');
  _eraseW = viewer.offsetWidth  || window.innerWidth;
  _eraseH = viewer.offsetHeight || window.innerHeight;

  // Canvas visual
  const lc = _eraseCanvas();
  lc.width  = _eraseW;
  lc.height = _eraseH;
  lc.style.display = 'block';

  // UI
  const badge = document.getElementById('lassoBadge');
  badge.textContent = mode === 'rect'
    ? '⬜ Rectangle erase — drag to select, release to delete'
    : '✏ Freehand erase — draw around area, release to delete';
  badge.style.display = 'block';
  document.getElementById('lassoCancel').style.display = 'block';
  document.getElementById('btnRectErase').classList.toggle('active', mode === 'rect');
  document.getElementById('btnLassoErase').classList.toggle('active', mode === 'lasso');
  viewer.classList.add('lasso-active');

  // Bloquejar canvas Three.js — els events cauen al viewer
  if (renderer) renderer.domElement.style.pointerEvents = 'none';

  // Registrar events
  viewer.addEventListener('pointerdown',   _onEraseDown,   { passive: false });
  viewer.addEventListener('pointermove',   _onEraseMove,   { passive: false });
  viewer.addEventListener('pointerup',     _onEraseUp,     { passive: false });
  viewer.addEventListener('pointercancel', _onEraseCancel, { passive: false });
  viewer.addEventListener('touchstart',    _onEraseTStart, { passive: false });
  viewer.addEventListener('touchmove',     _onEraseTMove,  { passive: false });
  viewer.addEventListener('touchend',      _onEraseTEnd,   { passive: false });
}

function _stopErase() {
  lassoErasing = false;
  _eraseMode   = null;
  _rStart = _rEnd = null;
  _lPath = []; _lDrawing = false;

  const viewer = document.getElementById('viewer');
  viewer.removeEventListener('pointerdown',   _onEraseDown);
  viewer.removeEventListener('pointermove',   _onEraseMove);
  viewer.removeEventListener('pointerup',     _onEraseUp);
  viewer.removeEventListener('pointercancel', _onEraseCancel);
  viewer.removeEventListener('touchstart',    _onEraseTStart);
  viewer.removeEventListener('touchmove',     _onEraseTMove);
  viewer.removeEventListener('touchend',      _onEraseTEnd);

  if (renderer) renderer.domElement.style.pointerEvents = 'auto';
  document.getElementById('viewer').classList.remove('lasso-active');

  const lc = _eraseCanvas();
  lc.style.display = 'none';
  _clearCanvas();
  document.getElementById('lassoBadge').style.display   = 'none';
  document.getElementById('lassoCancel').style.display  = 'none';
  document.getElementById('btnRectErase').classList.remove('active');
  document.getElementById('btnLassoErase').classList.remove('active');
}

// Mantenim l'alias que usa la resta del codi (reset, etc.)
function startLassoErase() { _startErase('rect'); }
function stopLassoErase()   { _stopErase(); }

// ── Handlers d'events ─────────────────────────────────────────────────────────
function _onEraseDown(e) {
  if (!lassoErasing || _isControlTarget(e)) return;
  e.preventDefault(); e.stopPropagation();
  const p = _vp(e.clientX, e.clientY);
  if (_eraseMode === 'rect') {
    _rStart = p; _rEnd = { ...p };
  } else {
    _lDrawing = true; _lPath = [p];
  }
}

function _onEraseMove(e) {
  if (!lassoErasing) return;
  e.preventDefault(); e.stopPropagation();
  const p = _vp(e.clientX, e.clientY);
  if (_eraseMode === 'rect' && _rStart) {
    _rEnd = p; _drawRect();
  } else if (_eraseMode === 'lasso' && _lDrawing) {
    _lPath.push(p); _drawLasso();
  }
}

function _onEraseUp(e) {
  if (!lassoErasing) return;
  e.preventDefault(); e.stopPropagation();
  const p = _vp(e.clientX, e.clientY);
  if (_eraseMode === 'rect' && _rStart) {
    _rEnd = p; _applyErase();
  } else if (_eraseMode === 'lasso' && _lDrawing) {
    _lDrawing = false; _applyErase();
  }
}

function _onEraseCancel() { if (lassoErasing) _stopErase(); }

// Touch fallbacks
function _onEraseTStart(e) {
  if (!lassoErasing || _isControlTarget(e)) return;
  e.preventDefault();
  const p = _vp(e.touches[0].clientX, e.touches[0].clientY);
  if (_eraseMode === 'rect') {
    _rStart = p; _rEnd = { ...p };
  } else {
    _lDrawing = true; _lPath = [p];
  }
}
function _onEraseTMove(e) {
  if (!lassoErasing) return;
  e.preventDefault();
  const p = _vp(e.touches[0].clientX, e.touches[0].clientY);
  if (_eraseMode === 'rect' && _rStart) {
    _rEnd = p; _drawRect();
  } else if (_eraseMode === 'lasso' && _lDrawing) {
    _lPath.push(p); _drawLasso();
  }
}
function _onEraseTEnd(e) {
  if (!lassoErasing) return;
  e.preventDefault();
  if (_eraseMode === 'rect' && _rStart)      _applyErase();
  else if (_eraseMode === 'lasso' && _lDrawing) { _lDrawing = false; _applyErase(); }
}

// ── Dibuix visual ─────────────────────────────────────────────────────────────
function _drawRect() {
  if (!_rStart || !_rEnd) return;
  const lc = _eraseCanvas(), ctx = lc.getContext('2d');
  ctx.clearRect(0, 0, lc.width, lc.height);
  const x = Math.min(_rStart.x, _rEnd.x), y = Math.min(_rStart.y, _rEnd.y);
  const w = Math.abs(_rEnd.x - _rStart.x), h = Math.abs(_rEnd.y - _rStart.y);
  ctx.fillStyle = 'rgba(255,60,60,0.15)'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,80,80,0.9)'; ctx.lineWidth = 2;
  ctx.setLineDash([6, 3]); ctx.strokeRect(x, y, w, h);
}

function _drawLasso() {
  if (_lPath.length < 2) return;
  const lc = _eraseCanvas(), ctx = lc.getContext('2d');
  ctx.clearRect(0, 0, lc.width, lc.height);
  ctx.beginPath();
  ctx.moveTo(_lPath[0].x, _lPath[0].y);
  for (let i = 1; i < _lPath.length; i++) ctx.lineTo(_lPath[i].x, _lPath[i].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,60,60,0.15)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,80,80,0.9)'; ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]); ctx.stroke();
}

// ── Test de contenció ─────────────────────────────────────────────────────────
function _inRect(sx, sy) {
  const x1 = Math.min(_rStart.x, _rEnd.x), x2 = Math.max(_rStart.x, _rEnd.x);
  const y1 = Math.min(_rStart.y, _rEnd.y), y2 = Math.max(_rStart.y, _rEnd.y);
  return sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2;
}

function _inPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// ── Aplicar esborrat ──────────────────────────────────────────────────────────
function _applyErase() {
  // Validació mínima
  if (_eraseMode === 'rect') {
    if (!_rStart || !_rEnd) { _stopErase(); return; }
    if (Math.abs(_rEnd.x - _rStart.x) < 5 || Math.abs(_rEnd.y - _rStart.y) < 5) { _stopErase(); return; }
  } else {
    if (_lPath.length < 6) { _stopErase(); return; } // mínim ~6 punts per un traç útil
  }

  const W = _eraseW, H = _eraseH;
  const activeCam = (useOrtho && orthoCamera) ? orthoCamera : camera;
  const targets   = selectedCloud ? [selectedCloud] : clouds.filter(c => c.visible);
  if (targets.length === 0) { _stopErase(); return; }

  document.getElementById('loadingBadge').style.display = 'block';
  document.getElementById('lassoBadge').style.display   = 'none';

  // Capturem aquí perquè _stopErase() els esborra
  const mode  = _eraseMode;
  const rS = _rStart ? { ..._rStart } : null;
  const rE = _rEnd   ? { ..._rEnd }   : null;
  const lP = [..._lPath];

  _stopErase(); // tanquem el mode visualment mentre processem

  setTimeout(() => {
    const vProj = new THREE.Vector3();
    for (const cloud of targets) {
      cloud.updateMatrixWorld(true);
      const mw  = cloud.matrixWorld;
      const pos = cloud.geometry.getAttribute('position');
      const col = cloud.geometry.getAttribute('color');
      if (!pos) continue;

      const newPos = [], newCol = [];
      for (let i = 0; i < pos.count; i++) {
        vProj.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mw).project(activeCam);
        // Punt darrere la càmera → conservar sempre
        if (vProj.z > 1) {
          newPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
          if (col) newCol.push(col.getX(i), col.getY(i), col.getZ(i));
          continue;
        }
        const sx = (vProj.x + 1) / 2 * W;
        const sy = (1 - vProj.y) / 2 * H;
        const inside = mode === 'rect'
          ? (sx >= Math.min(rS.x,rE.x) && sx <= Math.max(rS.x,rE.x) &&
             sy >= Math.min(rS.y,rE.y) && sy <= Math.max(rS.y,rE.y))
          : _inPolygon(sx, sy, lP);
        if (inside) continue; // esborrar
        newPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (col) newCol.push(col.getX(i), col.getY(i), col.getZ(i));
      }

      if (newPos.length === pos.count * 3) continue; // res eliminat

      pushUndo(cloud, true);
      const ng = new THREE.BufferGeometry();
      ng.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
      if (newCol.length) ng.setAttribute('color', new THREE.Float32BufferAttribute(newCol, 3));
      ng.computeBoundingBox(); ng.computeBoundingSphere();
      cloud.geometry.dispose();
      cloud.geometry = ng;
      cloud.material.needsUpdate = true;
    }

    updateRaycasterThreshold();
    document.getElementById('loadingBadge').style.display = 'none';
  }, 20);
}

// Alias per a applyLassoErase (usat externament)
function applyLassoErase() { _applyErase(); }

// Escape per cancel·lar
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && lassoErasing) _stopErase();
});
// ─────────────────────────────────────────────────────────────────────────────

function applyAndKeepClip() {
  const cloud = selectedCloud || clouds.find(c => c.userData.clipBox);
  if (!cloud || !cloud.userData.clipBox) { alert(T.noBoxCreated); return; }

  const box = cloud.userData.clipBox;
  box.updateMatrixWorld(true);
  const planes = LOCAL_CLIP_PLANES.map(p => p.clone().applyMatrix4(box.matrixWorld));

  cloud.updateMatrixWorld(true);
  const mw   = cloud.matrixWorld;
  const pos  = cloud.geometry.getAttribute('position');
  const col  = cloud.geometry.getAttribute('color');
  if (!pos) return;

  const v = new THREE.Vector3();
  const newPos = [], newCol = [];

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    if (!planes.every(p => p.distanceToPoint(v) >= 0)) continue;
    newPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (col) newCol.push(col.getX(i), col.getY(i), col.getZ(i));
  }

  if (newPos.length === 0) { alert('La caixa no conté cap punt.'); return; }

  // Guardem geometria anterior per poder fer undo
  pushUndo(cloud, true);

  const newGeom = new THREE.BufferGeometry();
  newGeom.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  if (newCol.length) newGeom.setAttribute('color', new THREE.Float32BufferAttribute(newCol, 3));
  newGeom.computeBoundingBox();
  newGeom.computeBoundingSphere();

  // Substituïm la geometria (l'antiga queda guardada a l'undo stack)
  cloud.geometry = newGeom;
  cloud.material.clippingPlanes = [];
  cloud.material.needsUpdate = true;

  // Eliminem la caixa
  removeClipBox();
  updateRaycasterThreshold();
  selectCloud(cloud);

  const kept = newPos.length / 3;
  console.log(`Crop aplicat: ${kept.toLocaleString()} punts conservats`);
}

// ─────────────────────────────────────────────
// Exportar secció de la caixa de tall com a DXF
// ─────────────────────────────────────────────
function exportClipSectionDXF() {
  const cloud = selectedCloud || clouds.find(c => c.userData.clipBox);
  if (!cloud || !cloud.userData.clipBox) { alert(T.noBoxCreated); return; }

  // Determina els eixos de projecció segons la vista actual
  const cam = useOrtho ? orthoCamera : camera;
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  let a0, a1, viewName;
  if (ay >= ax && ay >= az) { a0 = 'x'; a1 = 'z'; viewName = 'TOP'; }
  else if (az >= ax && az >= ay) { a0 = 'x'; a1 = 'y'; viewName = 'FRONT'; }
  else { a0 = 'y'; a1 = 'z'; viewName = 'SIDE'; }

  const box = cloud.userData.clipBox;
  box.updateMatrixWorld(true);
  const planes = LOCAL_CLIP_PLANES.map(p => p.clone().applyMatrix4(box.matrixWorld));

  cloud.updateMatrixWorld(true);
  const mw = cloud.matrixWorld;
  const pos = cloud.geometry.getAttribute('position');
  if (!pos) return;

  const badge = document.getElementById('loadingBadge');
  if (badge) badge.style.display = 'block';

  setTimeout(() => {
    const v = new THREE.Vector3();
    const grid = new Map();
    const RES = 0.02; // cel·la 2cm

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mw);
      if (!planes.every(p => p.distanceToPoint(v) >= 0)) continue;
      const gx = Math.round(v[a0] / RES), gy = Math.round(v[a1] / RES);
      const k = `${gx},${gy}`;
      if (!grid.has(k)) grid.set(k, [v[a0], v[a1]]);
    }

    if (grid.size === 0) {
      if (badge) badge.style.display = 'none';
      alert('Cap punt dins la caixa de tall.');
      return;
    }

    const pts = [...grid.values()].slice(0, 100000);
    // $PDMODE=3 → punts visibles com a creu; $PDSIZE negatiu = % viewport
    let dxf  = '0\nSECTION\n2\nHEADER\n';
    dxf += '9\n$ACADVER\n1\nAC1015\n';
    dxf += '9\n$PDMODE\n70\n3\n';
    dxf += '9\n$PDSIZE\n40\n-1.0\n';
    dxf += '0\nENDSEC\n';
    dxf += '0\nSECTION\n2\nENTITIES\n';
    for (const [x, y] of pts) {
      dxf += `0\nPOINT\n8\nSECCIO\n10\n${x.toFixed(4)}\n20\n${y.toFixed(4)}\n30\n0.0\n`;
    }
    dxf += '0\nENDSEC\n0\nEOF\n';

    const blob = new Blob([dxf], { type: 'application/dxf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `seccio_${viewName}.dxf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    if (badge) badge.style.display = 'none';
    console.log(`DXF: ${pts.length} punts (vista ${viewName})`);
  }, 20);
}

// ─────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────
function setupUI() {
  const fileInput = document.getElementById('fileInput');

  // ── Càrrega de fitxers ──
  fileInput.value = '';
  let _loading = false;

  async function handleFiles(files) {
    if (_loading || !files || files.length === 0) return;
    _loading = true;
    const badge = document.getElementById('loadingBadge');
    try {
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase();
        let cloud = null;
        if (badge) badge.style.display = 'block';
        try {
          if (ext === 'ply')                       cloud = await loadPLY(file);
          else if (ext === 'xyz' || ext === 'txt') cloud = await loadXYZ(file);
          else { alert(T.unsupported(ext)); continue; }
        } catch (err) {
          console.error('Error carregant núvol:', err);
          alert(T.loadError(file.name, err.message));
          continue;
        } finally {
          if (badge) badge.style.display = 'none';
        }

        adaptPointSize(cloud);
        scene.add(cloud);
        clouds.push(cloud);
        selectableObjects.push(cloud);

        selectCloud(cloud);
        onWindowResize();
        fitCameraToObject(cloud);
        updateRaycasterThreshold();
      }
    } finally {
      _loading = false;
      fileInput.value = '';
    }
  }

  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

  // ── Transformació numèrica ──
  document.getElementById('toggleNumeric').onclick = () => {
    const div = document.getElementById('numericTransform');
    const visible = div.style.display === 'block';
    div.style.display = visible ? 'none' : 'block';
    if (!visible && selectedCloud) syncNumericInputs(selectedCloud);
  };

  document.getElementById('applyTransform').onclick = () => {
    const target = selectedCloud || clouds[clouds.length - 1];
    if (!target) return;
    pushUndo(target);
    target.position.set(
      parseFloat(document.getElementById('tx').value) || 0,
      parseFloat(document.getElementById('ty').value) || 0,
      parseFloat(document.getElementById('tz').value) || 0
    );
    target.rotation.set(
      degToRad(document.getElementById('rx').value),
      degToRad(document.getElementById('ry').value),
      degToRad(document.getElementById('rz').value)
    );
    target.updateMatrixWorld();
    syncClipBox(target);
    transformControls.attach(target);
  };

  // ── Caixa de tall (live, per núvol) ──
  document.getElementById('createClipBox').onclick = createClippingBoxAroundSelected;

  function setClipBoxBtnActive(mode) {
    document.getElementById('moveClipBox').classList.toggle('active', mode === 'translate');
    document.getElementById('rotateClipBox').classList.toggle('active', mode === 'rotate');
  }

  function withClipBox(mode) {
    const box = getActiveClipBox();
    if (!box) { alert(T.noBoxCreated); return; }
    transformControls.attach(box);
    transformControls.setMode(mode);
    setClipBoxBtnActive(mode);
    setMode(mode === 'translate' ? 'clipbox_translate' : 'clipbox_rotate');
  }

  function exitClipBoxMode() {
    setClipBoxBtnActive(null);
    if (selectedCloud) transformControls.attach(selectedCloud);
    else transformControls.detach();
    transformControls.setMode(cloudTCMode);
    setMode(cloudTCMode);
  }

  document.getElementById('modeTranslate').onclick = () => {
    cloudTCMode = 'translate';
    exitClipBoxMode();
    if (selectedCloud) transformControls.attach(selectedCloud);
    transformControls.setMode('translate');
    setMode('translate');
  };
  document.getElementById('modeRotate').onclick = () => {
    cloudTCMode = 'rotate';
    exitClipBoxMode();
    if (selectedCloud) transformControls.attach(selectedCloud);
    transformControls.setMode('rotate');
    setMode('rotate');
  };

  document.getElementById('moveClipBox').onclick   = () => withClipBox('translate');
  document.getElementById('rotateClipBox').onclick = () => withClipBox('rotate');
  document.getElementById('applyClipBox').onclick  = applyAndKeepClip;
  document.getElementById('removeClipBox').onclick = () => { removeClipBox(); setClipBoxBtnActive(null); };
  document.getElementById('btnUndo').onclick = doUndo;

  // ── Exportar secció DXF ──
  document.getElementById('btnExportSection').onclick = exportClipSectionDXF;

  // ── Alineació ──
  document.getElementById('align2pt').onclick = () => startAlign(2);
  document.getElementById('align3pt').onclick = () => startAlign(3);

  // ── Auto-align per color ──
  let _autoAlignPending = null;

  document.getElementById('btnAutoAlign').onclick = () => {
    if (!selectedCloud || clouds.length < 2) { alert(T.needTwoClouds); return; }
    const src = selectedCloud;
    const panel = document.getElementById('autoAlignPanel');
    const res   = document.getElementById('autoAlignResult');
    panel.style.display = 'block';
    res.textContent = 'Analitzant colors...';
    document.getElementById('btnApplyAutoAlign').style.display = 'none';

    setTimeout(() => {
      const srcF = detectLocalColorFeatures(src);
      const tgtF = clouds.filter(c => c !== src).flatMap(c => detectLocalColorFeatures(c));
      res.textContent = `${srcF.length} + ${tgtF.length} punts de color... cercant RANSAC`;

      setTimeout(() => {
        const matches = matchFeaturesRANSAC(srcF, tgtF);
        _autoAlignPending = matches.length >= 2 ? { src, matches } : null;

        if (!_autoAlignPending) {
          res.innerHTML = '<span style="color:#f88">No s\'han trobat prou coincidències.<br>'
            + '<small>Assegura\'t que els dos núvols comparteixen zones de color distintiu.</small></span>';
          return;
        }

        document.getElementById('btnApplyAutoAlign').style.display = '';
        let html = `<b>${matches.length} coincidències geomètriques:</b><br>`;
        for (const m of matches) {
          const rv = Math.round(m.src.r * 255), gv = Math.round(m.src.g * 255), bv = Math.round(m.src.b * 255);
          const d0 = m.src.centroid.distanceTo(m.tgt.centroid).toFixed(2);
          html += `<span style="display:inline-block;width:10px;height:10px;background:rgb(${rv},${gv},${bv});`
                + `border:1px solid #888;margin-right:3px;vertical-align:middle"></span>Δ${d0}m&nbsp; `;
        }
        res.innerHTML = html;
      }, 20);
    }, 20);
  };

  document.getElementById('btnApplyAutoAlign').onclick = () => {
    if (!_autoAlignPending) return;
    const { src, matches } = _autoAlignPending;
    const sp = matches.map(m => m.src.centroid.clone());
    const tp = matches.map(m => m.tgt.centroid.clone());
    pushUndo(src);
    if (matches.length >= 3) applyAlign3pt(src, sp, tp);
    else                     applyAlign2pt(src, sp, tp);
    document.getElementById('autoAlignPanel').style.display = 'none';
    _autoAlignPending = null;
  };

  document.getElementById('btnCancelAutoAlign').onclick = () => {
    document.getElementById('autoAlignPanel').style.display = 'none';
    _autoAlignPending = null;
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (alignMode) cancelAlign();
      if (measuring) {
        measuring = false;
        clearCurrentMeasure();
        updateMeasureList();
        const badge = document.getElementById('measureBadge');
        if (badge) badge.style.display = 'none';
        setMode(cloudTCMode);
      }
    }
  });

  // ── Erase tools ──
  document.getElementById('btnRectErase').onclick = () => {
    if (lassoErasing && _eraseMode === 'rect') { _stopErase(); return; }
    cancelAlign();
    _startErase('rect');
  };
  document.getElementById('btnLassoErase').onclick = () => {
    if (lassoErasing && _eraseMode === 'lasso') { _stopErase(); return; }
    cancelAlign();
    _startErase('lasso');
  };
  document.getElementById('lassoCancel').onclick = _stopErase;

  // ── Mode mesura ──
  document.getElementById('toggleMeasure').onclick = () => {
    cancelAlign();
    measuring = !measuring;
    if (measuring) {
      transformControls.detach();
      setMode('measure');
    } else {
      setMode(cloudTCMode);
    }
    clearCurrentMeasure();
    updateMeasureList();
    const badge = document.getElementById('measureBadge');
    if (badge) badge.style.display = measuring ? 'block' : 'none';
    if (measuring) updateRaycasterThreshold();
  };

  document.getElementById('clearMeasures').onclick = () => {
    clearAllMeasurements();
    updateMeasureList();
  };

  // ── Merge / descàrrega ──
  document.getElementById('merge').onclick = () => {
    if (clouds.length === 0) { alert(T.noClouds); return; }
    const pts = mergeCloudsToXYZPoints(clouds);
    downloadXYZ(pts);
  };

  document.getElementById('btnReset').onclick = resetAll;

  // ── Vistes A (ortogràfiques) ──
  function orthoBtn(id, dir, up) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.onclick = () => {
      setOrthoView(dir, up);
      btn.classList.add('ortho-active');
    };
  }
  const btn3d = document.getElementById('viewA_3d');
  if (btn3d) btn3d.onclick = () => {
    activate3DView();
    btn3d.classList.add('ortho-active');
  };
  orthoBtn('viewA_top',   new THREE.Vector3( 0, 1, 0), new THREE.Vector3(0, 0,-1));
  orthoBtn('viewA_front', new THREE.Vector3( 0, 0, 1), new THREE.Vector3(0, 1, 0));
  orthoBtn('viewA_back',  new THREE.Vector3( 0, 0,-1), new THREE.Vector3(0, 1, 0));
  orthoBtn('viewA_right', new THREE.Vector3( 1, 0, 0), new THREE.Vector3(0, 1, 0));
  orthoBtn('viewA_left',  new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0));
}

// ─────────────────────────────────────────────
// Selecció i gestió de núvols
// ─────────────────────────────────────────────
function selectCloud(cloud) {
  selectedCloud = cloud;
  if (cloud) transformControls.attach(cloud);
  else       transformControls.detach();
  updateCloudList();
  syncNumericInputs(cloud);
}

function deleteCloud(cloud) {
  const idx = clouds.indexOf(cloud);
  if (idx < 0) return;

  if (cloud.userData.clipBox) {
    const box = cloud.userData.clipBox;
    scene.remove(box);
    box.geometry.dispose(); box.material.dispose();
    const bi = selectableObjects.indexOf(box);
    if (bi >= 0) selectableObjects.splice(bi, 1);
  }

  scene.remove(cloud);
  cloud.geometry.dispose();
  cloud.material.dispose();
  clouds.splice(idx, 1);

  const si = selectableObjects.indexOf(cloud);
  if (si >= 0) selectableObjects.splice(si, 1);

  undoStack.splice(0, undoStack.length, ...undoStack.filter(s => s.cloud !== cloud));
  updateUndoBtn();

  if (alignSrcCloud === cloud) cancelAlign();

  if (clouds.length === 0 && measuring) {
    measuring = false;
    const badge = document.getElementById('measureBadge');
    if (badge) badge.style.display = 'none';
    clearCurrentMeasure();
    updateMeasureList();
    setMode('none');
  }

  if (selectedCloud === cloud) {
    selectCloud(clouds.length > 0 ? clouds[clouds.length - 1] : null);
  }
  updateCloudList();
}

function updateCloudList() {
  const panel = document.getElementById('cloudListPanel');
  if (!panel) return;
  panel.innerHTML = '';

  clouds.forEach((cloud) => {
    const item = document.createElement('div');
    item.className = 'cloud-item' + (cloud === selectedCloud ? ' selected' : '');

    const name = document.createElement('span');
    name.className = 'cloud-name';
    const posCount = cloud.geometry.getAttribute('position')?.count ?? 0;
    name.textContent = cloud.name || 'Núvol';
    name.title = `${cloud.name} — ${posCount.toLocaleString()} punts`;

    const del = document.createElement('span');
    del.className = 'cloud-del';
    del.textContent = '✕';
    del.title = 'Eliminar';
    del.onclick = (e) => { e.stopPropagation(); deleteCloud(cloud); };

    item.appendChild(name);
    item.appendChild(del);
    item.onclick = () => selectCloud(cloud);
    panel.appendChild(item);
  });
}

function syncNumericInputs(cloud) {
  if (!cloud) return;
  const p = cloud.position;
  const r = cloud.rotation;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v.toFixed(4); };
  set('tx', p.x); set('ty', p.y); set('tz', p.z);
  set('rx', THREE.MathUtils.radToDeg(r.x));
  set('ry', THREE.MathUtils.radToDeg(r.y));
  set('rz', THREE.MathUtils.radToDeg(r.z));
}

// ─────────────────────────────────────────────
// Pointer / raycaster
// ─────────────────────────────────────────────
function onPointerDown(event) {
  const ctrl = document.getElementById('controls');
  if (ctrl && (event.target === ctrl || ctrl.contains(event.target))) return;
  if (event.button !== 0) return;

  const rect = renderer.domElement.getBoundingClientRect();
  const nx = ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  const ny = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
  mouse.set(nx, ny);

  const activeCam = useOrtho ? orthoCamera : camera;

  // ── Mode alineació ──
  if (alignMode) {
    raycaster.setFromCamera(mouse, activeCam);
    const hits = raycaster.intersectObjects(clouds, false);
    if (hits.length === 0) return;
    const hit = hits[0];
    let pWorld;
    if (hit.index != null && hit.object.geometry?.attributes?.position) {
      pWorld = new THREE.Vector3()
        .fromBufferAttribute(hit.object.geometry.attributes.position, hit.index)
        .applyMatrix4(hit.object.matrixWorld);
    } else {
      pWorld = hit.point.clone();
    }
    handleAlignClick(pWorld, hit.object);
    return;
  }

  // ── Mode mesura ──
  if (measuring) {
    raycaster.setFromCamera(mouse, activeCam);
    const hits = raycaster.intersectObjects(clouds, false);
    if (hits.length === 0) return;
    const hit = hits[0];
    let pWorld;
    if (hit.index != null && hit.object.geometry?.attributes?.position) {
      pWorld = new THREE.Vector3()
        .fromBufferAttribute(hit.object.geometry.attributes.position, hit.index)
        .applyMatrix4(hit.object.matrixWorld);
    } else {
      pWorld = hit.point.clone();
    }
    handleMeasureClick(pWorld);
    return;
  }

  // ── Mode caixa de tall activa: clic fora de la caixa torna al núvol ──
  if (appMode === 'clipbox_translate' || appMode === 'clipbox_rotate') {
    raycaster.setFromCamera(mouse, activeCam);
    const box = getActiveClipBox();
    if (box) {
      const hitsBox = raycaster.intersectObject(box, false);
      if (hitsBox.length === 0) {
        // Clic fora de la caixa → torna al mode núvol
        transformControls.attach(selectedCloud);
        transformControls.setMode(cloudTCMode);
        setMode(cloudTCMode);
        document.getElementById('moveClipBox')?.classList.remove('active');
        document.getElementById('rotateClipBox')?.classList.remove('active');
      }
    }
    return;
  }

  // ── Selecció normal ──
  if (transformControls.dragging) return;
  if (transformControls.object && transformControls.object.userData.parentCloud) return;

  raycaster.setFromCamera(mouse, activeCam);
  const hits = raycaster.intersectObjects(selectableObjects, false);
  if (!hits.length) { selectCloud(null); return; }

  for (const h of hits) {
    const boxCloud = clouds.find(c => c.userData.clipBox === h.object);
    if (boxCloud) { selectCloud(boxCloud); return; }
    if (clouds.includes(h.object)) { selectCloud(h.object); return; }
  }
}

// ─────────────────────────────────────────────
// Mesures
// ─────────────────────────────────────────────
function handleMeasureClick(pWorld) {
  const markerR = getCloudMarkerSize();

  const sphereGeom = new THREE.SphereGeometry(markerR, 8, 8);
  const sphereMat  = new THREE.MeshBasicMaterial({ color: 0xff2200 });
  const marker     = new THREE.Mesh(sphereGeom, sphereMat);
  marker.position.copy(pWorld);
  scene.add(marker);
  currentMeasureMarkers.push(marker);
  currentMeasurePoints.push(pWorld.clone());

  if (currentMeasurePoints.length === 2) {
    const p1 = currentMeasurePoints[0];
    const p2 = currentMeasurePoints[1];
    const dist = p1.distanceTo(p2);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dz = p2.z - p1.z;

    const lineGeom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const lineMat  = new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2 });
    const line     = new THREE.Line(lineGeom, lineMat);
    scene.add(line);

    const mid    = p1.clone().add(p2).multiplyScalar(0.5);
    const label  = createLabelSprite(`${dist.toFixed(3)} m`, markerR);
    label.position.copy(mid);
    scene.add(label);

    measurements.push({ p1, p2, dx, dy, dz, dist, line, markers: [...currentMeasureMarkers], label });

    currentMeasurePoints  = [];
    currentMeasureMarkers = [];
    updateMeasureList();
  }
}

function clearCurrentMeasure() {
  for (const m of currentMeasureMarkers) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  currentMeasureMarkers = [];
  currentMeasurePoints  = [];
}

function clearAllMeasurements() {
  for (const m of measurements) {
    if (m.line)  { scene.remove(m.line);  m.line.geometry.dispose();  m.line.material.dispose(); }
    if (m.label) { scene.remove(m.label); m.label.material.map?.dispose(); m.label.material.dispose(); }
    for (const mk of m.markers ?? []) { scene.remove(mk); mk.geometry.dispose(); mk.material.dispose(); }
  }
  measurements = [];
  clearCurrentMeasure();
}

function updateMeasureList() {
  const div = document.getElementById('measureList');
  if (!div) return;

  if (!measuring && measurements.length === 0) {
    div.style.display = 'none';
    div.textContent = '';
    return;
  }

  div.style.display = 'block';
  let txt = measuring ? 'MODE MESURA ACTIU\n' : 'Mides guardades:\n';

  if (measurements.length === 0) {
    txt += '(cap mida)';
  } else {
    measurements.forEach((m, i) => {
      txt += `#${i + 1}: ${m.dist.toFixed(3)} m  `
           + `ΔX=${m.dx.toFixed(3)}  ΔY=${m.dy.toFixed(3)}  ΔZ=${m.dz.toFixed(3)}\n`;
    });
  }
  div.textContent = txt;
}

function createLabelSprite(text, markerR = 0.05) {
  const fontSize = 64;
  const pad = 10;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  ctx.font = `bold ${fontSize}px sans-serif`;
  const tw = ctx.measureText(text).width;
  canvas.width  = tw + pad * 2;
  canvas.height = fontSize + pad * 2;

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, canvas.height / 2);

  const tex  = new THREE.CanvasTexture(canvas);
  const mat  = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false });
  const spr  = new THREE.Sprite(mat);

  const scale = markerR * 5;
  spr.scale.set((canvas.width / canvas.height) * scale, scale, 1);
  return spr;
}

// ─────────────────────────────────────────────
// Helpers geomètrics
// ─────────────────────────────────────────────
function degToRad(v) { return (parseFloat(v) || 0) * Math.PI / 180; }

function getCloudBounds(cloud) {
  if (!cloud) return { center: new THREE.Vector3(), maxDim: 1 };
  const box  = new THREE.Box3().setFromObject(cloud);
  const size = box.getSize(new THREE.Vector3());
  return { center: box.getCenter(new THREE.Vector3()), maxDim: Math.max(size.x, size.y, size.z) || 1 };
}

function getCloudMarkerSize() {
  const obj = selectedCloud || (clouds.length > 0 ? clouds[clouds.length - 1] : null);
  const { maxDim } = getCloudBounds(obj);
  return maxDim * 0.004;
}

function updateRaycasterThreshold() {
  const obj = selectedCloud || (clouds.length > 0 ? clouds[clouds.length - 1] : null);
  const { maxDim } = getCloudBounds(obj);
  raycaster.params.Points = { threshold: maxDim * 0.004 };
}

function fitCameraToObject(object, offset = 1.8) {
  const box    = new THREE.Box3().setFromObject(object);
  const size   = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSz  = Math.max(size.x, size.y, size.z) || 1;

  const fitH   = maxSz / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const fitW   = fitH / camera.aspect;
  const dist   = Math.max(fitH, fitW) * offset;

  camera.position.copy(center).addScalar(dist * 0.6);
  camera.position.y += dist * 0.4;
  camera.near = dist / 100;
  camera.far  = dist * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

// ─────────────────────────────────────────────
// Caixa de tall
// ─────────────────────────────────────────────
function createClippingBoxAroundSelected() {
  const cloud = selectedCloud || (clouds.length > 0 ? clouds[clouds.length - 1] : null);
  if (!cloud) { alert(T.noCloudLoaded); return; }

  if (cloud.userData.clipBox) removeClipBox();

  cloud.updateMatrixWorld(true);
  const worldBounds = new THREE.Box3().setFromObject(cloud);
  const size   = worldBounds.getSize(new THREE.Vector3());
  const center = worldBounds.getCenter(new THREE.Vector3());
  size.x = Math.max(size.x, 0.001);
  size.y = Math.max(size.y, 0.001);
  size.z = Math.max(size.z, 0.001);

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffcc00, wireframe: true, transparent: true, opacity: 0.35 })
  );
  box.position.copy(center);
  box.scale.copy(size);

  scene.add(box);
  box.userData.parentCloud = cloud;
  cloud.userData.clipBox = box;

  box.updateMatrixWorld(true);
  cloud.userData.boxRelMatrix = new THREE.Matrix4()
    .copy(cloud.matrixWorld).invert()
    .multiply(box.matrixWorld);

  selectableObjects.push(box);

  transformControls.attach(cloud);
  transformControls.setMode('translate');
}

// ─────────────────────────────────────────────
// Merge i descàrrega
// ─────────────────────────────────────────────
function mergeCloudsToXYZPoints(cloudList) {
  const result = [];
  const v = new THREE.Vector3();

  for (const cloud of cloudList) {
    if (!cloud?.geometry) continue;
    const pos = cloud.geometry.getAttribute('position');
    const col = cloud.geometry.getAttribute('color');
    if (!pos) continue;

    cloud.updateWorldMatrix(true, false);
    const mw = cloud.matrixWorld;

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mw);
      const pt = { x: v.x, y: v.y, z: v.z };
      if (col) {
        pt.r = col.getX(i) * 255;
        pt.g = col.getY(i) * 255;
        pt.b = col.getZ(i) * 255;
      }
      result.push(pt);
    }
  }
  return result;
}

function downloadXYZ(points) {
  const lines = points.map(p =>
    p.r !== undefined
      ? `${p.x} ${p.y} ${p.z} ${Math.round(p.r)} ${Math.round(p.g)} ${Math.round(p.b)}`
      : `${p.x} ${p.y} ${p.z}`
  );
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'merged.xyz';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ─────────────────────────────────────────────
// Roda (zoom)
// ─────────────────────────────────────────────
function onMouseWheel(event) {
  event.preventDefault();

  if (useOrtho) {
    const factor = event.deltaY > 0 ? 1.1 : 0.9;
    orthoCamera.left   *= factor; orthoCamera.right *= factor;
    orthoCamera.top    *= factor; orthoCamera.bottom *= factor;
    orthoCamera.updateProjectionMatrix();
    return;
  }

  const factor = event.deltaY > 0 ? 1.1 : 0.9;
  const target = controls.target.clone();
  const offset = new THREE.Vector3().subVectors(camera.position, target);
  offset.multiplyScalar(factor);
  camera.position.copy(target).add(offset);
  camera.updateProjectionMatrix();
  controls.update();
}

// ─────────────────────────────────────────────
// Render loop
// ─────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  try {
    if (useOrtho) {
      if (orthoControls) orthoControls.update();
    } else {
      controls.update();
    }
    updateClipPlanes();

    const W = window.innerWidth;
    const H = window.innerHeight;
    const camA = useOrtho ? orthoCamera : camera;

    if (!useOrtho) { camera.aspect = W / H; camera.updateProjectionMatrix(); }
    renderer.setViewport(0, 0, W, H);
    renderer.setScissor(0, 0, W, H);
    renderer.setScissorTest(true);
    renderer.render(scene, camA);
  } catch(err) { console.error('animate error:', err); }
}

// ─────────────────────────────────────────────
// Arrencada
// ─────────────────────────────────────────────
init();
setupUI();
animate();