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
let secondaryCamera = null;
let secondaryControls = null;
let splitScreen = false;

// Càmera ortogràfica (vistes planes)
let orthoCamera = null;
let orthoControls = null;
let useOrtho = false;

const clouds = [];
let selectedCloud = null;
let cloudTCMode = 'translate';

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

function pushUndo(cloud) {
  if (!cloud) return;
  undoStack.push({
    cloud,
    position: cloud.position.clone(),
    quaternion: cloud.quaternion.clone()
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
  cloud.updateMatrixWorld(true);
  // Sincronitza la caixa de tall si n'hi ha
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
      // Drag comença — desa estat per a undo (només si és un núvol)
      const obj = transformControls.object;
      if (obj && clouds.includes(obj)) pushUndo(obj);
    }
    if (!e.value) {
      // Quan s'acaba de moure la caixa directament, actualitza la relació relativa
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

  // Quan es mou el núvol via TC, sincronitza la caixa de tall
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

  secondaryCamera = new THREE.PerspectiveCamera(60, width / height, 0.01, 1e7);
  setSecondaryViewTop();

  // Càmera ortogràfica
  const aspect = width / height;
  orthoCamera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, -1e6, 1e6);
  orthoControls = new OrbitControls(orthoCamera, renderer.domElement);
  orthoControls.enableDamping = false;
  orthoControls.enabled = false;

  // Controls per al visor B (pantalla dividida)
  secondaryControls = new OrbitControls(secondaryCamera, renderer.domElement);
  secondaryControls.enableDamping = false;
  secondaryControls.enableZoom = false; // zoom gestionat manualment a onMouseWheel
  secondaryControls.enabled = false;

  // Activa els controls del panel correcte segons on és el punter
  renderer.domElement.addEventListener('pointerdown', e => {
    if (!splitScreen) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const inRight = (e.clientX - rect.left) > rect.width / 2;
    secondaryControls.enabled   = inRight;
    controls.enabled     = !inRight && !useOrtho;
    if (orthoControls) orthoControls.enabled = !inRight && useOrtho;
  }, { capture: true });

  renderer.domElement.addEventListener('pointermove', e => {
    if (!splitScreen) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const inRight = (e.clientX - rect.left) > rect.width / 2;
    secondaryControls.enabled   = inRight;
    controls.enabled     = !inRight && !useOrtho;
    if (orthoControls) orthoControls.enabled = !inRight && useOrtho;
  }, { passive: true });

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
  secondaryCamera.aspect = a;
  secondaryCamera.updateProjectionMatrix();

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
  if (selectedCloud) transformControls.attach(selectedCloud);
  else transformControls.detach();
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

  // Elimina caixes de tall
  clouds.forEach(cloud => {
    if (cloud.userData.clipBox) {
      const box = cloud.userData.clipBox;
      scene.remove(box);
      box.geometry.dispose(); box.material.dispose();
      const si = selectableObjects.indexOf(box);
      if (si >= 0) selectableObjects.splice(si, 1);
    }
  });

  // Elimina núvols
  [...clouds].forEach(cloud => {
    scene.remove(cloud);
    cloud.geometry.dispose(); cloud.material.dispose();
    const si = selectableObjects.indexOf(cloud);
    if (si >= 0) selectableObjects.splice(si, 1);
  });
  clouds.length = 0;

  // Elimina mesures i marcadors d'alineació
  clearAllMeasurements();
  clearAlignMarkers();

  // Reinicia estat
  selectedCloud = null;
  measuring = false;
  alignMode = 0;
  alignPhase = 'src';
  undoStack.length = 0;

  transformControls.detach();

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
// Fases: 'pickCloud' → 'src' → 'tgt'

function startAlign(n) {
  if (measuring) return;
  if (clouds.length < 2) { alert(T.needTwoClouds); return; }
  alignMode  = n;
  alignPhase = 'pickCloud';
  alignSrcPts = []; alignTgtPts = [];
  alignSrcCloud = null;
  clearAlignMarkers();
  transformControls.detach();
  updateAlignBadge();
}

function cancelAlign() {
  alignMode = 0;
  alignSrcCloud = null;
  clearAlignMarkers();
  updateAlignBadge();
  if (selectedCloud) transformControls.attach(selectedCloud);
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
  // Fase 1: selecció del núvol a moure
  if (alignPhase === 'pickCloud') {
    alignSrcCloud = cloud;
    alignPhase = 'src';
    // Ressalta el núvol seleccionat
    selectCloud(cloud);
    updateAlignBadge();
    return;
  }

  const markerR = getCloudMarkerSize();

  // Fase 2: punts origen (han de ser del núvol a moure)
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

  // Fase 3: punts destí (qualsevol núvol excepte l'origen)
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

function applyAlign2pt(srcCloud, sp, tp) {
  if (!srcCloud) return;
  // Pas 1: translació → sp[0] va a tp[0]
  const tr = tp[0].clone().sub(sp[0]);
  // Pas 2: rotació al voltant de tp[0] → sp[1] (transladat) s'alinea amb tp[1]
  const srcDir = sp[1].clone().add(tr).sub(tp[0]).normalize();
  const tgtDir = tp[1].clone().sub(tp[0]).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(srcDir, tgtDir);

  srcCloud.position.add(tr);
  srcCloud.position.sub(tp[0]);
  srcCloud.position.applyQuaternion(q);
  srcCloud.position.add(tp[0]);
  srcCloud.quaternion.premultiply(q);
  srcCloud.updateMatrixWorld();
  syncClipBox(srcCloud);
  selectCloud(srcCloud);
}

function applyAlign3pt(srcCloud, sp, tp) {
  if (!srcCloud) return;

  // Construeix un sistema de referència local a partir de 3 punts
  function makeFrame(pts) {
    const x = pts[1].clone().sub(pts[0]).normalize();
    const n = new THREE.Vector3().crossVectors(
      pts[1].clone().sub(pts[0]),
      pts[2].clone().sub(pts[0])
    ).normalize();
    const y = new THREE.Vector3().crossVectors(n, x).normalize();
    return { o: pts[0].clone(), x, y, z: n };
  }

  const sf = makeFrame(sp); // frame origen (punts font, en espai món)
  const tf = makeFrame(tp); // frame destí

  // Rotació: alinea els eixos del frame origen amb els del destí
  const sm = new THREE.Matrix4().makeBasis(sf.x, sf.y, sf.z);
  const tm = new THREE.Matrix4().makeBasis(tf.x, tf.y, tf.z);
  const R  = new THREE.Matrix4().multiplyMatrices(tm, new THREE.Matrix4().copy(sm).invert());
  const q  = new THREE.Quaternion().setFromRotationMatrix(R);

  // Translació: sp[0] (rotat) ha d'anar a tp[0]
  const spOriginRotated = sf.o.clone().applyQuaternion(q);
  const tr = tp[0].clone().sub(spOriginRotated);

  srcCloud.quaternion.premultiply(q);
  srcCloud.position.applyQuaternion(q);
  srcCloud.position.add(tr);
  srcCloud.updateMatrixWorld();
  syncClipBox(srcCloud);
  selectCloud(srcCloud);
}

// ─────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────
function setupUI() {
  const fileInput = document.getElementById('fileInput');
  const divider   = document.getElementById('splitDivider');
  const labelB    = document.getElementById('labelB');

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
        fitSecondaryCameraToObject(cloud);
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
  }

  function exitClipBoxMode() {
    setClipBoxBtnActive(null);
    if (selectedCloud) transformControls.attach(selectedCloud);
    else transformControls.detach();
    transformControls.setMode(cloudTCMode);
  }

  document.getElementById('modeTranslate').onclick = () => {
    cloudTCMode = 'translate';
    exitClipBoxMode();
    if (selectedCloud) transformControls.attach(selectedCloud);
    transformControls.setMode('translate');
  };
  document.getElementById('modeRotate').onclick = () => {
    cloudTCMode = 'rotate';
    exitClipBoxMode();
    if (selectedCloud) transformControls.attach(selectedCloud);
    transformControls.setMode('rotate');
  };

  document.getElementById('moveClipBox').onclick   = () => withClipBox('translate');
  document.getElementById('rotateClipBox').onclick = () => withClipBox('rotate');
  document.getElementById('removeClipBox').onclick = () => { removeClipBox(); setClipBoxBtnActive(null); };
  document.getElementById('btnUndo').onclick = doUndo;

  // ── Alineació ──
  document.getElementById('align2pt').onclick = () => startAlign(2);
  document.getElementById('align3pt').onclick = () => startAlign(3);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { cancelAlign(); } });

  // ── Mode mesura ──
  document.getElementById('toggleMeasure').onclick = () => {
    cancelAlign();
    measuring = !measuring;
    if (measuring) transformControls.detach();
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

  // ── Vistes B ──
  function secBtn(id, fn) {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = fn;
  }
  secBtn('viewB_3d', () => {
    const t = getSecondaryTarget(), d = getSecondaryDistance();
    secondaryCamera.position.set(t.x+d, t.y+d, t.z+d);
    secondaryCamera.up.set(0, 1, 0); secondaryCamera.lookAt(t); syncSecCam(t);
  });
  secBtn('viewB_top',   setSecondaryViewTop);
  secBtn('viewB_front', setSecondaryViewFront);
  secBtn('viewB_back',  () => { const t=getSecondaryTarget(),d=getSecondaryDistance(); secondaryCamera.position.set(t.x,t.y,t.z-d); secondaryCamera.up.set(0,1,0); secondaryCamera.lookAt(t); syncSecCam(t); });
  secBtn('viewB_right', setSecondaryViewSide);
  secBtn('viewB_left',  () => { const t=getSecondaryTarget(),d=getSecondaryDistance(); secondaryCamera.position.set(t.x-d,t.y,t.z); secondaryCamera.up.set(0,1,0); secondaryCamera.lookAt(t); syncSecCam(t); });

  // ── Pantalla dividida ──
  document.getElementById('splitView').onclick = () => {
    splitScreen = true;
    if (divider) divider.style.display = 'block';
    if (labelB)  labelB.style.display  = 'block';
    updateViewBButtons();
  };

  document.getElementById('singleView').onclick = () => {
    splitScreen = false;
    if (secondaryControls) secondaryControls.enabled = false;
    controls.enabled = !useOrtho;
    if (orthoControls) orthoControls.enabled = useOrtho;
    if (divider) divider.style.display = 'none';
    if (labelB)  labelB.style.display  = 'none';
    updateViewBButtons();
  };

  function updateViewBButtons() {
    ['viewB_3d','viewB_top','viewB_front','viewB_back','viewB_right','viewB_left'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.classList.toggle('hidden', !splitScreen);
    });
  }
  updateViewBButtons();
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

  const inRightHalf = splitScreen && (event.clientX - rect.left) > rect.width / 2;
  if (inRightHalf) return;

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
    // En fase pickCloud, pWorld no s'usa però cal el cloud
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

  // ── Selecció normal ──

  // Si TC està en mig d'un drag, no interferim (el gizmo gestiona els seus events)
  if (transformControls.dragging) return;

  // Si TC està fixat a una caixa de tall, els clics al visor no canvien la selecció
  // (l'usuari ha de clicar "Moure núvol" o "Rotar núvol" per sortir del mode caixa)
  if (transformControls.object && transformControls.object.userData.parentCloud) return;

  raycaster.setFromCamera(mouse, activeCam);
  const hits = raycaster.intersectObjects(selectableObjects, false);
  if (!hits.length) { selectCloud(null); return; }

  for (const h of hits) {
    // Clic sobre una caixa de tall → selecciona el núvol pare
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

function fitSecondaryCameraToObject(object, offset = 3) {
  const box    = new THREE.Box3().setFromObject(object);
  const size   = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSz  = Math.max(size.x, size.y, size.z) || 1;
  const dist   = maxSz * offset;

  secondaryCamera.position.set(center.x, center.y + dist, center.z);
  secondaryCamera.up.set(0, 0, -1);
  secondaryCamera.lookAt(center);
  secondaryCamera.near = dist / 100;
  secondaryCamera.far  = dist * 100;
  secondaryCamera.updateProjectionMatrix();
  if (secondaryControls) { secondaryControls.target.copy(center); secondaryControls.update(); }
}

// ─────────────────────────────────────────────
// Vistes predefinides
// ─────────────────────────────────────────────
function setPresetViewMain(direction) {
  const dir  = direction.clone().normalize();
  let target = controls.target.clone();
  if (selectedCloud) {
    const box = new THREE.Box3().setFromObject(selectedCloud);
    target = box.getCenter(new THREE.Vector3());
  }
  const dist = camera.position.distanceTo(target) || 10;
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.up.set(0, 1, 0);
  // Corregim "up" per a la vista de planta
  if (Math.abs(direction.y) > 0.9) camera.up.set(0, 0, -1);
  camera.lookAt(target);
  controls.target.copy(target);
  controls.update();
}

function getSecondaryTarget() {
  const obj = selectedCloud || (clouds.length > 0 ? clouds[clouds.length - 1] : null);
  if (!obj) return new THREE.Vector3(0, 0, 0);
  return new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
}

function getSecondaryDistance() {
  const obj = selectedCloud || (clouds.length > 0 ? clouds[clouds.length - 1] : null);
  if (!obj) return 10;
  const box  = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z) * 3 || 10;
}

function syncSecCam(t) {
  if (secondaryControls) { secondaryControls.target.copy(t); secondaryControls.update(); }
}

function setSecondaryViewTop() {
  const t = getSecondaryTarget(), d = getSecondaryDistance();
  secondaryCamera.position.set(t.x, t.y + d, t.z);
  secondaryCamera.up.set(0, 0, -1); secondaryCamera.lookAt(t); syncSecCam(t);
}

function setSecondaryViewFront() {
  const t = getSecondaryTarget(), d = getSecondaryDistance();
  secondaryCamera.position.set(t.x, t.y, t.z + d);
  secondaryCamera.up.set(0, 1, 0); secondaryCamera.lookAt(t); syncSecCam(t);
}

function setSecondaryViewSide() {
  const t = getSecondaryTarget(), d = getSecondaryDistance();
  secondaryCamera.position.set(t.x + d, t.y, t.z);
  secondaryCamera.up.set(0, 1, 0); secondaryCamera.lookAt(t); syncSecCam(t);
}

// ─────────────────────────────────────────────
// Caixa de tall
// ─────────────────────────────────────────────
function createClippingBoxAroundSelected() {
  const cloud = selectedCloud || (clouds.length > 0 ? clouds[clouds.length - 1] : null);
  if (!cloud) { alert(T.noCloudLoaded); return; }

  if (cloud.userData.clipBox) removeClipBox();

  // Bounds en espai món
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

  // Afegim al scene (no com a fill del núvol) perquè TransformControls funcioni correctament
  scene.add(box);
  box.userData.parentCloud = cloud;
  cloud.userData.clipBox = box;

  // Matriu relativa cloud→box per sincronitzar quan el núvol es mogui
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
// Roda (zoom) — càmera A o B
// ─────────────────────────────────────────────
function onMouseWheel(event) {
  event.preventDefault();

  const rect = renderer.domElement.getBoundingClientRect();
  const x    = event.clientX - rect.left;
  const inB  = splitScreen && x > rect.width / 2;

  if (!inB && useOrtho) {
    // Zoom ortogràfic: ampliar/reduir el frustum
    const factor = event.deltaY > 0 ? 1.1 : 0.9;
    orthoCamera.left   *= factor; orthoCamera.right *= factor;
    orthoCamera.top    *= factor; orthoCamera.bottom *= factor;
    orthoCamera.updateProjectionMatrix();
    return;
  }

  const factor = event.deltaY > 0 ? 1.1 : 0.9;

  if (inB) {
    const target = secondaryControls ? secondaryControls.target.clone() : getSecondaryTarget();
    const offset = new THREE.Vector3().subVectors(secondaryCamera.position, target);
    offset.multiplyScalar(factor);
    secondaryCamera.position.copy(target).add(offset);
    secondaryCamera.updateProjectionMatrix();
    if (secondaryControls) secondaryControls.update();
    return;
  }

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
  if (splitScreen && secondaryControls) secondaryControls.update();
  updateClipPlanes();

  const W = window.innerWidth;
  const H = window.innerHeight;
  const camA = useOrtho ? orthoCamera : camera;

  if (!splitScreen) {
    if (!useOrtho) { camera.aspect = W / H; camera.updateProjectionMatrix(); }
    renderer.setViewport(0, 0, W, H);
    renderer.setScissor(0, 0, W, H);
    renderer.setScissorTest(true);
    renderer.render(scene, camA);
    return;
  }

  const halfW = Math.floor(W / 2);

  // Visor A
  if (!useOrtho) { camera.aspect = halfW / H; camera.updateProjectionMatrix(); }
  renderer.setViewport(0, 0, halfW, H);
  renderer.setScissor(0, 0, halfW, H);
  renderer.setScissorTest(true);
  renderer.render(scene, camA);

  // Visor B
  secondaryCamera.aspect = (W - halfW) / H;
  secondaryCamera.updateProjectionMatrix();
  renderer.setViewport(halfW, 0, W - halfW, H);
  renderer.setScissor(halfW, 0, W - halfW, H);
  renderer.setScissorTest(true);
  renderer.render(scene, secondaryCamera);
  } catch(err) { console.error('animate error:', err); }
}

// ─────────────────────────────────────────────
// Arrencada
// ─────────────────────────────────────────────
init();
setupUI();
animate();
