import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ---------- Base values (upgrades add on top of these) ----------
const ARENA_HALF = 22;          // arena spans -22..22 on X and Z
const WALL_HEIGHT = 6;
const WALL_THICKNESS = 1;
const GRAVITY = -26;
const JUMP_SPEED = 8.5;
const PLAYER_RADIUS = 0.4;
const EYE_HEIGHT = 1.6;
const PLAYER_RESPAWN_TIME = 2.5;
const BASE_PLAYER_HP = 100;
const BASE_PLAYER_SPEED = 6;
const BASE_SWORD_DAMAGE = 40;

const SWORD_RANGE = 3.2;        // horizontal distance to the bot's center
const SWING_DURATION = 0.3;     // seconds for a full swing
const SWING_COOLDOWN = 0.45;    // seconds between swing starts
const SWING_HIT_POINT = 0.45;   // fraction of the swing when the hit is checked
const HOLD_PITCH = 0;           // first-person sword hold angle (0 = blade points straight up)
const SWORD_KNOCKBACK = 9;      // initial push speed on the bot when hit
const KNOCKBACK_DECAY = 6;      // higher = push stops sooner
const BOT_STUN_TIME = 0.45;     // seconds the bot can't walk or attack after a hit

const HIT_STOP_TIME = 0.06;     // seconds gameplay freezes on a landed hit
const SHAKE_TIME = 0.18;        // seconds the camera shakes after a landed hit
const SHAKE_STRENGTH = 0.06;    // max camera offset during a shake (world units)
let hitStopTimer = 0;
let shakeTimer = 0;

const BOT_GLITCH_TIME = 0.7;    // seconds the CPU glitches after being hit
const BOT_GLITCH_PALETTE = [0x00ff41, 0x050505, 0xffe600, 0x1e90ff, 0xff1a1a];

const BOT_RADIUS = 0.5;
const BASE_BOT_HP = 100;
const BASE_BOT_SPEED = 3.4;
const BASE_BOT_DAMAGE = 12;
const BASE_BOT_REWARD = 20;     // coins per CPU kill before CPU upgrades
const BOT_STOP_DISTANCE = 1.8;  // bot stops walking when this close
const BOT_ATTACK_RANGE = 2.2;
const BOT_ATTACK_COOLDOWN = 1.1;
const BOT_SWING_TIME = 0.5;
const BOT_RESPAWN_TIME = 3;

// Hard-CPU behavior. The numbers (HP, damage, speed) are unchanged; these add the tactics.
const BOT_DODGE_CHANCE = 0.35;      // chance it sidesteps a swing that's about to land
const BOT_DODGE_DELAY = 0.12;       // seconds it takes to react, so the dodge isn't instant
const BOT_DODGE_COOLDOWN = 1.6;     // seconds before it can dodge again
const BOT_BLOCK_CHANCE = 0.3;       // chance it raises its sword to block a hit
const BOT_BLOCK_DAMAGE_MULT = 0.4;  // a blocked hit does 40% damage (60% reduction)
const BOT_STRAFE_RANGE = 1.9;       // distance it tries to hold while circling (inside its attack range and your sword reach)
const BOT_STRAFE_SPEED = 2.2;       // sideways speed while circling
const BOT_COVER_HP = 0.4;           // below this fraction of max HP it seeks a pillar
const BOT_COVER_TIME = 2.5;         // seconds it stays behind a pillar before coming out

const PLAYER_SPAWN = new THREE.Vector3(0, 0, 14);
const BOT_SPAWN = new THREE.Vector3(0, 0, -12);

const PILLAR_RADIUS = 1;
const PILLAR_HEIGHT = 4;
const PILLARS = [
  { x: -8, z: -4 },
  { x: 8, z: -4 },
  { x: -8, z: 6 },
  { x: 8, z: 6 },
];

const UP = new THREE.Vector3(0, 1, 0);

// ---------- Upgrades and save data ----------
const MAX_LEVEL = 5;
const UPGRADE_BASE_COST = 50;   // next level costs 50 * (current level + 1)
const SAVE_KEY = 'arenaDuel.save';

const PLAYER_UPGRADES = [
  { key: 'sword', label: 'Sword Damage', desc: '+5 damage per level' },
  { key: 'health', label: 'Max Health', desc: '+20 HP per level' },
  { key: 'speed', label: 'Move Speed', desc: '+10% speed per level' },
];
const CPU_UPGRADES = [
  { key: 'cpuHealth', label: 'CPU Health', desc: '+25 HP per level' },
  { key: 'cpuDamage', label: 'CPU Damage', desc: '+3 damage per level' },
  { key: 'cpuSpeed', label: 'CPU Speed', desc: '+0.4 speed per level' },
];
const ALL_UPGRADE_KEYS = [...PLAYER_UPGRADES, ...CPU_UPGRADES].map((u) => u.key);

function freshSave() {
  return { coins: 0, levels: Object.fromEntries(ALL_UPGRADE_KEYS.map((k) => [k, 0])) };
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return freshSave();
    const data = JSON.parse(raw);
    const levels = {};
    for (const k of ALL_UPGRADE_KEYS) {
      levels[k] = THREE.MathUtils.clamp(Math.floor(Number(data.levels?.[k]) || 0), 0, MAX_LEVEL);
    }
    return { coins: Math.max(0, Math.floor(Number(data.coins) || 0)), levels };
  } catch (err) {
    console.warn('Could not read save data, starting fresh.', err);
    return freshSave();
  }
}

let save = loadSave();

function saveProgress() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch (err) {
    console.warn('Could not save progress.', err);
  }
}

function upgradeCost(key) {
  return UPGRADE_BASE_COST * (save.levels[key] + 1);
}

// Converts the saved upgrade levels into the numbers the game uses.
function computeStats() {
  const L = save.levels;
  return {
    swordDamage: BASE_SWORD_DAMAGE + 5 * L.sword,
    playerMaxHp: BASE_PLAYER_HP + 20 * L.health,
    playerSpeed: BASE_PLAYER_SPEED * (1 + 0.1 * L.speed),
    botMaxHp: BASE_BOT_HP + 25 * L.cpuHealth,
    botDamage: BASE_BOT_DAMAGE + 3 * L.cpuDamage,
    botSpeed: BASE_BOT_SPEED + 0.4 * L.cpuSpeed,
    botReward: BASE_BOT_REWARD + 10 * (L.cpuHealth + L.cpuDamage + L.cpuSpeed),
  };
}

let stats = computeStats();

// ---------- Renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 30, 80);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
camera.rotation.order = 'YXZ';
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xffffff, 0x556644, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(10, 20, 10);
scene.add(sun);

// ---------- Helpers ----------
function lambert(color) {
  return new THREE.MeshLambertMaterial({ color });
}

function makeCheckerTexture(colorA, colorB, repeat) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  ctx.fillStyle = colorA;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = colorB;
  ctx.fillRect(0, 0, half, half);
  ctx.fillRect(half, half, half, half);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function addBlock(w, h, d, x, y, z, color) {
  // `color` can be a hex number (new material) or an existing material.
  const material = typeof color === 'number' ? lambert(color) : color;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  scene.add(mesh);
  return mesh;
}

// Keeps a feet-level position inside the arena walls and outside the pillars.
function constrainToArena(pos, radius) {
  const limit = ARENA_HALF - radius;
  pos.x = THREE.MathUtils.clamp(pos.x, -limit, limit);
  pos.z = THREE.MathUtils.clamp(pos.z, -limit, limit);
  for (const p of PILLARS) {
    const dx = pos.x - p.x;
    const dz = pos.z - p.z;
    const dist = Math.hypot(dx, dz);
    const minDist = PILLAR_RADIUS + radius;
    if (dist < minDist && dist > 1e-6) {
      const push = (minDist - dist) / dist;
      pos.x += dx * push;
      pos.z += dz * push;
    }
  }
}

// Horizontal forward vector derived from the camera yaw.
function getFlatForward(target) {
  const yaw = camera.rotation.y;
  return target.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

// ---------- Arena ----------
// Left half (x < 0) is the normal arena. Right half (x > 0) is glitched.
// The glitch is visual only: collisions and movement are the same on both sides.
const HALF_SPAN = ARENA_HALF;                     // width of each half (x)
const GLITCH_COLORS = [0xff2bd6, 0x00f0ff, 0x7dff00]; // magenta, cyan, lime

// Normal floor (left half): the same green checker as before, 2-unit tiles.
const normalFloorTex = makeCheckerTexture('#5a9a3c', '#4c8a32', 1);
normalFloorTex.repeat.set(HALF_SPAN / 2, ARENA_HALF);

// Glitch floor (right half): a small canvas that gets repainted several times a second.
const glitchCanvas = document.createElement('canvas');
glitchCanvas.width = 128;
glitchCanvas.height = 128;
const glitchCtx = glitchCanvas.getContext('2d');
const glitchFloorTex = new THREE.CanvasTexture(glitchCanvas);
glitchFloorTex.wrapS = THREE.RepeatWrapping;
glitchFloorTex.wrapT = THREE.RepeatWrapping;
glitchFloorTex.repeat.set(HALF_SPAN / 2, ARENA_HALF);
glitchFloorTex.magFilter = THREE.NearestFilter;
glitchFloorTex.colorSpace = THREE.SRGBColorSpace;

function paintGlitchFloor() {
  const size = 128;
  const cells = 8;
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const r = Math.random();
      glitchCtx.fillStyle = r < 0.12 ? '#ffffff' : r < 0.5 ? '#ff2bd6' : r < 0.9 ? '#00f0ff' : '#0b0014';
      glitchCtx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  // A few thin horizontal glitch bars.
  for (let i = 0; i < 3; i++) {
    glitchCtx.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#7dff00';
    glitchCtx.fillRect(0, Math.floor(Math.random() * size), size, 2 + Math.floor(Math.random() * 4));
  }
  glitchFloorTex.needsUpdate = true;
}
paintGlitchFloor();

// Glitch material shared by the right-side walls and pillars. Its color cycles in updateGlitch.
const glitchMat = new THREE.MeshLambertMaterial({ color: GLITCH_COLORS[0], emissive: 0x220011 });

function addFloorHalf(centerX, material) {
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(HALF_SPAN, ARENA_HALF * 2), material);
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(centerX, 0, 0);
  scene.add(plane);
}
addFloorHalf(-HALF_SPAN / 2, new THREE.MeshLambertMaterial({ map: normalFloorTex }));
addFloorHalf(HALF_SPAN / 2, new THREE.MeshLambertMaterial({ map: glitchFloorTex }));

const WALL_COLOR = 0x7d7d7d;
const wallOffset = ARENA_HALF + WALL_THICKNESS / 2;
const wallHalf = ARENA_HALF + WALL_THICKNESS;   // half the length of a north/south wall
// North and south walls are split at x = 0: left stays gray, right is glitched.
addBlock(WALL_THICKNESS, WALL_HEIGHT, ARENA_HALF * 2, -wallOffset, WALL_HEIGHT / 2, 0, WALL_COLOR);
addBlock(WALL_THICKNESS, WALL_HEIGHT, ARENA_HALF * 2, wallOffset, WALL_HEIGHT / 2, 0, glitchMat);
addBlock(wallHalf, WALL_HEIGHT, WALL_THICKNESS, -wallHalf / 2, WALL_HEIGHT / 2, -wallOffset, WALL_COLOR);
addBlock(wallHalf, WALL_HEIGHT, WALL_THICKNESS, wallHalf / 2, WALL_HEIGHT / 2, -wallOffset, glitchMat);
addBlock(wallHalf, WALL_HEIGHT, WALL_THICKNESS, -wallHalf / 2, WALL_HEIGHT / 2, wallOffset, WALL_COLOR);
addBlock(wallHalf, WALL_HEIGHT, WALL_THICKNESS, wallHalf / 2, WALL_HEIGHT / 2, wallOffset, glitchMat);

for (const p of PILLARS) {
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(PILLAR_RADIUS, PILLAR_RADIUS, PILLAR_HEIGHT, 16),
    p.x > 0 ? glitchMat : lambert(0xd9c48a)
  );
  pillar.position.set(p.x, PILLAR_HEIGHT / 2, p.z);
  scene.add(pillar);
}

// Bright divider line at x = 0 between the two halves.
const seamMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.8 });
const seam = new THREE.Mesh(new THREE.BoxGeometry(0.12, WALL_HEIGHT, ARENA_HALF * 2), seamMat);
seam.position.set(0, WALL_HEIGHT / 2, 0);
scene.add(seam);

// Floating glitch bars over the right half. Decoration only; they don't block movement.
const glitchBars = [];
for (let i = 0; i < 8; i++) {
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(0.3 + Math.random() * 2.5, 0.08 + Math.random() * 0.2, 0.08),
    new THREE.MeshBasicMaterial({ color: GLITCH_COLORS[i % GLITCH_COLORS.length] })
  );
  bar.position.set(2 + Math.random() * 18, 0.5 + Math.random() * 4.5, -20 + Math.random() * 40);
  scene.add(bar);
  glitchBars.push(bar);
}
let glitchTimer = 0;

// ---------- Sword model ----------
// Local space: the blade points along +Y and the handle sits at the origin.
const bladeShape = new THREE.Shape();
bladeShape.moveTo(-0.045, 0);
bladeShape.lineTo(0.045, 0);
bladeShape.lineTo(0.035, 0.5);
bladeShape.lineTo(0, 0.66);
bladeShape.lineTo(-0.035, 0.5);
bladeShape.closePath();
const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.02, bevelEnabled: false });
bladeGeo.translate(0, 0, -0.01);

const steelMat = new THREE.MeshStandardMaterial({ color: 0xc9e8ff, metalness: 0.9, roughness: 0.2, emissive: 0x0a2a3a });
const coreMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });   // energy core, flickers
const goldMat = new THREE.MeshStandardMaterial({ color: 0xd4a017, metalness: 0.8, roughness: 0.35 });
const gripMat = new THREE.MeshStandardMaterial({ color: 0x1a1024, roughness: 0.8 });
const gemMat = new THREE.MeshBasicMaterial({ color: 0xff2bd6 });
const gemGeo = new THREE.OctahedronGeometry(0.045);
const gripGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8);
const wrapGeo = new THREE.TorusGeometry(0.032, 0.008, 6, 12);

function buildSwordMesh() {
  const sword = new THREE.Group();

  const blade = new THREE.Mesh(bladeGeo, steelMat);
  const energyCore = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.5, 0.03), coreMat);
  energyCore.position.set(0, 0.3, 0);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.07), goldMat);
  const gemL = new THREE.Mesh(gemGeo, gemMat);
  gemL.position.set(-0.13, 0, 0);
  const gemR = new THREE.Mesh(gemGeo, gemMat);
  gemR.position.set(0.13, 0, 0);
  const grip = new THREE.Mesh(gripGeo, gripMat);
  grip.position.y = -0.11;
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), gemMat);
  pommel.position.y = -0.24;
  sword.add(blade, energyCore, guard, gemL, gemR, grip, pommel);

  // Gold wrap rings around the grip.
  for (const y of [-0.05, -0.12, -0.19]) {
    const wrap = new THREE.Mesh(wrapGeo, goldMat);
    wrap.rotation.x = Math.PI / 2;
    wrap.position.y = y;
    sword.add(wrap);
  }

  // Invisible marker at the blade tip, used to record the swing trail.
  const tip = new THREE.Object3D();
  tip.position.set(0, 0.66, 0);
  sword.add(tip);
  sword.userData.tip = tip;
  return sword;
}

// ---------- Player sword (glitch edition) ----------
// Palette for the player's sword only: green, black, yellow, blue, red.
const SWORD_PALETTE = {
  green: 0x00ff41,
  black: 0x050505,
  yellow: 0xffe600,
  blue: 0x1e90ff,
  red: 0xff1a1a,
};
const SWORD_GLOW = [SWORD_PALETTE.green, SWORD_PALETTE.yellow, SWORD_PALETTE.blue, SWORD_PALETTE.red];
const SWORD_SLICE_COLORS = [...SWORD_GLOW, SWORD_PALETTE.black];
const SLICE_COUNT = 9;

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Materials and meshes that the glitch animation changes each frame.
const playerSwordFx = {
  edgeMats: [],
  core: null,
  aura: null,
  gem: null,
  tipMat: null,
  wraps: [],
  slices: [],   // { mesh, mat }
  timer: 0,
  flashTimer: 0,  // > 0 while the blade edges flash white after a hit
};

function buildPlayerSwordMesh() {
  const sword = new THREE.Group();

  // Black blade with glowing edges.
  const blade = new THREE.Mesh(
    bladeGeo,
    new THREE.MeshStandardMaterial({ color: SWORD_PALETTE.black, metalness: 0.7, roughness: 0.25 })
  );
  sword.add(blade);

  // Energy aura: a wider, translucent copy of the blade that flickers.
  const auraMat = new THREE.MeshBasicMaterial({
    color: SWORD_GLOW[0],
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const aura = new THREE.Mesh(bladeGeo, auraMat);
  aura.scale.set(2.2, 1.04, 1.4);
  sword.add(aura);
  playerSwordFx.aura = auraMat;

  // Glowing strips along both edges of the blade.
  for (const side of [-1, 1]) {
    const mat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[0] });
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.6, 0.03), mat);
    edge.position.set(side * 0.038, 0.31, 0);
    sword.add(edge);
    playerSwordFx.edgeMats.push(mat);
  }

  // Bright center line running up the blade.
  const coreMat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[1] });
  const core = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.52, 0.035), coreMat);
  core.position.set(0, 0.32, 0);
  sword.add(core);
  playerSwordFx.core = coreMat;

  // Black guard with a yellow trim strip.
  const guard = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.05, 0.08),
    new THREE.MeshStandardMaterial({ color: SWORD_PALETTE.black, metalness: 0.6, roughness: 0.4 })
  );
  const guardTrim = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.012, 0.085),
    new THREE.MeshBasicMaterial({ color: SWORD_PALETTE.yellow })
  );
  guardTrim.position.y = 0.03;
  sword.add(guard, guardTrim);

  // Glowing gems on the guard ends and the pommel.
  const gemMat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[2] });
  const gemGeo = new THREE.OctahedronGeometry(0.05);
  const gemL = new THREE.Mesh(gemGeo, gemMat);
  gemL.position.set(-0.15, 0, 0);
  const gemR = new THREE.Mesh(gemGeo, gemMat);
  gemR.position.set(0.15, 0, 0);
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), gemMat);
  pommel.position.y = -0.24;
  sword.add(gemL, gemR, pommel);
  playerSwordFx.gem = gemMat;

  // Black grip with glowing wrap rings.
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8),
    new THREE.MeshStandardMaterial({ color: SWORD_PALETTE.black, roughness: 0.9 })
  );
  grip.position.y = -0.11;
  sword.add(grip);
  for (const y of [-0.05, -0.12, -0.19]) {
    const mat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[0] });
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.008, 6, 12), mat);
    wrap.rotation.x = Math.PI / 2;
    wrap.position.y = y;
    sword.add(wrap);
    playerSwordFx.wraps.push(mat);
  }

  // Glowing tip gem.
  const tipMat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[3] });
  const tipGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.035), tipMat);
  tipGem.position.y = 0.68;
  sword.add(tipGem);
  playerSwordFx.tipMat = tipMat;

  // Dark fuller groove down the middle of the blade.
  const fuller = new THREE.Mesh(
    new THREE.BoxGeometry(0.014, 0.44, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 })
  );
  fuller.position.set(0, 0.3, 0);
  sword.add(fuller);

  // Serrated back edge: a row of small teeth along the blade's back.
  const toothMat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[1] });
  for (let i = 0; i < 9; i++) {
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.05, 4), toothMat);
    tooth.position.set(-0.034, 0.1 + i * 0.06, 0.012);
    tooth.rotation.z = Math.PI / 2;
    sword.add(tooth);
  }
  playerSwordFx.toothMats = [toothMat];

  // Curved quillons: the guard ends bend upward and finish in glowing studs.
  const studMat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[2] });
  for (const side of [-1, 1]) {
    const quillon = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.035, 0.05),
      new THREE.MeshStandardMaterial({ color: SWORD_PALETTE.black, metalness: 0.6, roughness: 0.4 })
    );
    quillon.position.set(side * 0.155, 0.03, 0);
    quillon.rotation.z = -side * 0.5;
    sword.add(quillon);
    const stud = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), studMat);
    stud.position.set(side * 0.2, 0.06, 0);
    sword.add(stud);
  }
  playerSwordFx.studMats = [studMat];

  // Floating crystal below the pommel: it spins and bobs (animated in updatePlayerSwordFx).
  const crystalMat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[0], transparent: true, opacity: 0.9 });
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.035), crystalMat);
  crystal.position.set(0, -0.33, 0);
  sword.add(crystal);
  playerSwordFx.crystal = crystal;
  playerSwordFx.crystalMat = crystalMat;

  // Orbit ring: a thin ring of glowing motes that circles the grip.
  const orbitGroup = new THREE.Group();
  orbitGroup.position.y = -0.11;
  sword.add(orbitGroup);
  const orbitMat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[0] });
  const orbitGeo = new THREE.SphereGeometry(0.012, 6, 5);
  for (let i = 0; i < 8; i++) {
    const mote = new THREE.Mesh(orbitGeo, orbitMat);
    const a = (i / 8) * Math.PI * 2;
    mote.position.set(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05);
    orbitGroup.add(mote);
  }
  playerSwordFx.orbit = orbitGroup;
  playerSwordFx.orbitMats = [orbitMat];

  // Tip flare: a soft additive glow on the blade tip that pulses during swings.
  const flareMat = new THREE.MeshBasicMaterial({
    color: SWORD_GLOW[1],
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flare = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), flareMat);
  flare.position.set(0, 0.66, 0);
  sword.add(flare);
  playerSwordFx.flare = flare;
  playerSwordFx.flareMat = flareMat;

  // Glitch slices: thin bars that jump around the blade.
  for (let i = 0; i < SLICE_COUNT; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: SWORD_GLOW[0], transparent: true, opacity: 0.85 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, 0.03), mat);
    sword.add(mesh);
    playerSwordFx.slices.push({ mesh, mat });
  }

  // Invisible marker at the blade tip, used to record the swing trail.
  const tip = new THREE.Object3D();
  tip.position.set(0, 0.66, 0);
  sword.add(tip);
  sword.userData.tip = tip;
  return sword;
}

// Runs every frame: recolors the glow, flickers the aura, and jumps the glitch slices.
function updatePlayerSwordFx(dt) {
  const fx = playerSwordFx;
  if (!fx.aura) return;

  // Smooth motion runs every frame: the crystal spins and bobs, and the orbit ring circles the grip.
  if (fx.crystal) {
    const t = performance.now() / 1000;
    fx.crystal.rotation.y += dt * 2.4;
    fx.crystal.rotation.x += dt * 1.1;
    fx.crystal.position.y = -0.33 + Math.sin(t * 3) * 0.02;
    fx.crystal.scale.setScalar(1 + Math.sin(t * 6) * 0.15); // breathing pulse
    fx.orbit.rotation.y += dt * 4.5;
  }

  // Tip flare: brighter and larger while swinging, with a quick pulse.
  if (fx.flare) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 1000 * 25);
    fx.flareMat.opacity = player.swinging ? 0.6 + 0.4 * pulse : 0.25;
    fx.flare.scale.setScalar(player.swinging ? 1 + 0.6 * pulse : 1);
  }
  if (fx.flashTimer > 0) fx.flashTimer = Math.max(0, fx.flashTimer - dt);

  fx.timer -= dt;
  if (fx.timer > 0) return;
  fx.timer = 0.035;

  // While the hit flash is active, the edges stay white instead of cycling colors.
  for (const m of fx.edgeMats) m.color.setHex(fx.flashTimer > 0 ? 0xffffff : randomOf(SWORD_GLOW));
  fx.core.color.setHex(randomOf(SWORD_GLOW));
  fx.gem.color.setHex(randomOf(SWORD_GLOW));
  fx.tipMat.color.setHex(randomOf(SWORD_GLOW));
  for (const m of fx.wraps) m.color.setHex(randomOf(SWORD_GLOW));
  for (const m of fx.toothMats) m.color.setHex(randomOf(SWORD_GLOW));
  for (const m of fx.studMats) m.color.setHex(randomOf(SWORD_GLOW));
  fx.crystalMat.color.setHex(randomOf(SWORD_GLOW));
  for (const m of fx.orbitMats) m.color.setHex(randomOf(SWORD_GLOW));

  fx.aura.color.setHex(randomOf(SWORD_GLOW));
  fx.aura.opacity = Math.random() < 0.1 ? 0.05 : 0.35 + Math.random() * 0.5;

  for (const s of fx.slices) {
    s.mesh.visible = Math.random() < 0.8;
    s.mesh.position.set((Math.random() - 0.5) * 0.5, 0.02 + Math.random() * 0.62, (Math.random() - 0.5) * 0.04);
    s.mesh.scale.set(0.5 + Math.random() * 1.5, 1 + Math.random() * 2, 1);
    s.mat.color.setHex(randomOf(SWORD_SLICE_COLORS));
  }

  // Often the whole blade jolts and tilts, and it blinks out now and then, like a corrupted frame.
  const jolt = Math.random() < 0.2;
  swordView.position.x = jolt ? (Math.random() - 0.5) * 0.12 : 0;
  swordView.rotation.z = jolt ? (Math.random() - 0.5) * 0.35 : 0;
  swordView.visible = Math.random() > 0.05;
}

// ---------- Effects: swing trail, sparks, glitch animation ----------
const effects = [];        // live trails and sparks, removed when their life runs out
const trailPoints = [];    // blade-tip positions (camera space) during the current swing
const tmpTip = new THREE.Vector3();
const sparkGeo = new THREE.BoxGeometry(0.08, 0.08, 0.08);

function spawnSwingTrail(points) {
  // Three layered trails (green, yellow, red), offset slightly so the arc looks glitched.
  const layers = [
    { color: SWORD_PALETTE.green, dx: 0, dy: 0 },
    { color: SWORD_PALETTE.yellow, dx: 0.025, dy: -0.012 },
    { color: SWORD_PALETTE.red, dx: -0.02, dy: 0.01 },
  ];
  for (const layer of layers) {
    const shifted = points.map((p) => new THREE.Vector3(p.x + layer.dx, p.y + layer.dy, p.z));
    const curve = new THREE.CatmullRomCurve3(shifted);
    const geo = new THREE.TubeGeometry(curve, shifted.length * 3, 0.014, 6, false);
    const mat = new THREE.MeshBasicMaterial({
      color: layer.color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    camera.add(mesh);
    effects.push({ kind: 'trail', mesh, life: 0.3, maxLife: 0.3 });
  }
}

function spawnSparks(position) {
  for (let i = 0; i < 24; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: randomOf(SWORD_GLOW), transparent: true });
    const mesh = new THREE.Mesh(sparkGeo, mat);
    mesh.position.copy(position);
    scene.add(mesh);
    const vel = new THREE.Vector3((Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6);
    effects.push({ kind: 'spark', mesh, vel, life: 0.5, maxLife: 0.5 });
  }
}

// Throttle for tip sparks, so they don't spawn every frame.
let tipSparkTimer = 0;

// One small palette-colored spark that leaves the blade tip during a swing.
function spawnTipSpark() {
  const mat = new THREE.MeshBasicMaterial({ color: randomOf(SWORD_GLOW), transparent: true });
  const mesh = new THREE.Mesh(sparkGeo, mat);
  mesh.scale.setScalar(0.5 + Math.random() * 0.5);
  mesh.position.copy(swordTip.getWorldPosition(new THREE.Vector3()));
  scene.add(mesh);
  const vel = new THREE.Vector3((Math.random() - 0.5) * 1.5, Math.random() * 1.5, (Math.random() - 0.5) * 1.5);
  effects.push({ kind: 'spark', mesh, vel, life: 0.22, maxLife: 0.22 });
}

// Throttle and cap for swing afterimages.
let ghostTimer = 0;
const GHOST_MAX = 10;

// Drops a faint, translucent copy of the blade at its current pose. It fades out on its own.
function spawnSwordGhost() {
  if (effects.filter((e) => e.kind === 'ghost').length >= GHOST_MAX) return;
  // Copy only the blade meshes. Skip the electric arc group, which lives under swordRoll.
  const ghost = new THREE.Group();
  const color = randomOf(SWORD_GLOW);
  for (const child of swordView.children) {
    const copy = child.clone(true);
    copy.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.35;
        o.material.depthWrite = false;
        o.material.color.setHex(color);
      }
    });
    ghost.add(copy);
  }
  // Place the ghost where the blade is right now, in world space, so it stays behind as the blade moves.
  swordRoll.updateWorldMatrix(true, false);
  ghost.matrixAutoUpdate = false;
  ghost.matrix.copy(swordView.matrixWorld);
  scene.add(ghost);
  effects.push({ kind: 'ghost', mesh: ghost, life: 0.2, maxLife: 0.2 });
}

// A glowing ring that expands from a hit point and turns to face `facing`.
function spawnShockRing(position, facing) {
  const mat = new THREE.MeshBasicMaterial({
    color: randomOf(SWORD_GLOW),
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.03, 6, 24), mat);
  mesh.position.copy(position);
  mesh.lookAt(facing);
  scene.add(mesh);
  effects.push({ kind: 'ring', mesh, life: 0.3, maxLife: 0.3 });
}

function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.life -= dt;
    if (e.life <= 0) {
      e.mesh.removeFromParent();
      if (e.kind !== 'ghost') e.mesh.material.dispose(); // a ghost is a Group, not a single mesh
      if (e.kind === 'ghost') {
        // Ghosts own cloned materials, so free them. Their geometry is shared with the sword and is kept.
        e.mesh.traverse((o) => {
          // Only meshes with a real material own one; skip anything else.
          if (o.isMesh && o.material && typeof o.material.dispose === 'function') o.material.dispose();
        });
      } else if (e.kind === 'trail' || e.kind === 'ring') {
        e.mesh.geometry.dispose(); // sparks share sparkGeo, so keep it
      }
      effects.splice(i, 1);
      continue;
    }
    const fade = e.life / e.maxLife;
    if (e.kind === 'ghost') {
      // Ghosts are groups of meshes, so fade each child's material.
      e.mesh.traverse((o) => {
        if (o.isMesh && o.material) o.material.opacity = 0.35 * fade;
      });
    } else {
      e.mesh.material.opacity = (e.kind === 'trail' ? 0.9 : 1) * fade;
    }
    if (e.kind === 'ring') {
      // Grows from the hit point outward as it fades.
      e.mesh.scale.setScalar(1 + (1 - fade) * 3);
    }
    if (e.kind === 'spark') {
      e.vel.y -= 14 * dt;
      e.mesh.position.addScaledVector(e.vel, dt);
    }
  }
}

// Glitch side: repaint the floor, cycle the wall colors, flicker the bars and the sword core.
function updateGlitch(dt) {
  glitchTimer -= dt;
  if (glitchTimer <= 0) {
    glitchTimer = 0.12;
    paintGlitchFloor();
    glitchMat.color.setHex(GLITCH_COLORS[Math.floor(Math.random() * GLITCH_COLORS.length)]);
    coreMat.color.setHex(Math.random() < 0.2 ? GLITCH_COLORS[0] : GLITCH_COLORS[1]);
  }
  for (const bar of glitchBars) {
    if (Math.random() < 0.03) bar.visible = !bar.visible;
    if (Math.random() < 0.02) bar.position.x = 2 + Math.random() * 18;
  }
  seamMat.opacity = 0.5 + 0.4 * Math.random();
}

// First-person sword attached to the camera.
const swordPivot = new THREE.Group();
swordPivot.rotation.order = 'YXZ';
swordPivot.position.set(0.32, -0.28, -0.5);
const swordView = buildPlayerSwordMesh();
// Fixed hand roll: turns the sword 90 degrees. It lives on its own group so the glitch
// jolt (which rewrites swordView's rotation) can't overwrite it.
const SWORD_ROLL = 0;           // extra roll around the blade's length (0 = no roll)
const swordRoll = new THREE.Group();
swordRoll.rotation.z = SWORD_ROLL;
swordRoll.add(swordView);
swordPivot.add(swordRoll);
const swordTip = swordView.userData.tip;
camera.add(swordPivot);

// Electric arcs around the sword. Each arc is a short jagged line drawn with
// THREE.LineSegments. The arcs are children of swordPivot, so they move with the swing.
// They are rebuilt several times a second and fade out in between.
const ARC_SEGMENTS = 7;      // jagged pieces per arc
const ARC_MAX = 6;           // arcs alive at once (kept small for performance)
const arcGroup = new THREE.Group();
swordRoll.add(arcGroup);  // under swordRoll, so arcs turn with the rolled blade
const arcs = [];             // { line, life, maxLife, mat }
let arcSpawnTimer = 0;

// Builds one jagged line from `from` to `to`. The middle points are pushed sideways at random.
function makeArcPoints(from, to, jitter) {
  const pts = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t = i / ARC_SEGMENTS;
    const p = from.clone().lerp(to, t);
    if (i > 0 && i < ARC_SEGMENTS) {
      p.x += (Math.random() - 0.5) * jitter;
      p.y += (Math.random() - 0.5) * jitter;
      p.z += (Math.random() - 0.5) * jitter;
    }
    pts.push(p);
  }
  return pts;
}

// Spawns one arc between two random points near the blade or guard.
function spawnArc(anchorA, anchorB, jitter) {
  if (arcs.length >= ARC_MAX) {
    const oldest = arcs.shift();
    arcGroup.remove(oldest.line);
    oldest.line.geometry.dispose();
    oldest.mat.dispose();
  }
  const pts = [];
  const seg = makeArcPoints(anchorA, anchorB, jitter);
  for (let i = 0; i < seg.length - 1; i++) {
    pts.push(seg[i], seg[i + 1]);
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color: randomOf(SWORD_GLOW),
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const line = new THREE.LineSegments(geo, mat);
  arcGroup.add(line);
  const life = 0.06 + Math.random() * 0.08;
  arcs.push({ line, life, maxLife: life, mat });
}

// Random point along the blade (local space, blade runs from y=0 to y=0.66).
function randomBladePoint(target) {
  return target.set((Math.random() - 0.5) * 0.06, 0.05 + Math.random() * 0.6, 0.02);
}

const tmpArcA = new THREE.Vector3();
const tmpArcB = new THREE.Vector3();

// Runs every frame: spawns arcs along the blade and guard, fades them out, and removes the old ones.
function updateSwordArcs(dt) {
  arcSpawnTimer -= dt;
  // Arcs come faster while swinging, and a hit adds a burst (see hurtBot).
  const rate = player.swinging ? 0.02 : 0.05;
  if (arcSpawnTimer <= 0) {
    arcSpawnTimer = rate * (0.5 + Math.random());
    if (Math.random() < 0.7) {
      // Blade arc: from one point on the blade to another, jagged.
      spawnArc(randomBladePoint(tmpArcA), randomBladePoint(tmpArcB), 0.12);
    } else {
      // Guard arc: a short crackle that jumps out from the crossguard.
      tmpArcA.set(-0.13, 0, 0.02);
      tmpArcB.set(0.13, 0.02, 0.02);
      spawnArc(tmpArcA, tmpArcB, 0.08);
    }
  }

  for (let i = arcs.length - 1; i >= 0; i--) {
    const a = arcs[i];
    a.life -= dt;
    if (a.life <= 0) {
      arcGroup.remove(a.line);
      a.line.geometry.dispose();
      a.mat.dispose();
      arcs.splice(i, 1);
      continue;
    }
    a.mat.opacity = a.life / a.maxLife;
  }
}

// Adds a burst of extra arcs at the blade, used when the sword hits the CPU.
function spawnArcBurst() {
  for (let i = 0; i < 4; i++) {
    spawnArc(randomBladePoint(tmpArcA), randomBladePoint(tmpArcB), 0.2);
  }
}

// ---------- Bot model (CPU opponent) ----------
function buildBot() {
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const mats = [];
  const mat = (color) => {
    const m = lambert(color);
    mats.push(m);
    return m;
  };
  const box = (w, h, d, color) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));

  const legL = new THREE.Group();
  legL.position.set(-0.15, 0.75, 0);
  const legLMesh = box(0.25, 0.75, 0.25, 0x2b2b6b);
  legLMesh.position.y = -0.375;
  legL.add(legLMesh);

  const legR = new THREE.Group();
  legR.position.set(0.15, 0.75, 0);
  const legRMesh = box(0.25, 0.75, 0.25, 0x2b2b6b);
  legRMesh.position.y = -0.375;
  legR.add(legRMesh);

  const torso = box(0.6, 0.75, 0.35, 0x2a6fd6);
  torso.position.y = 1.125;

  const head = box(0.5, 0.5, 0.5, 0xf1c27d);
  head.position.y = 1.75;

  const eyeL = box(0.1, 0.08, 0.02, 0x222222);
  eyeL.position.set(-0.12, 1.8, -0.26);
  const eyeR = box(0.1, 0.08, 0.02, 0x222222);
  eyeR.position.set(0.12, 1.8, -0.26);

  const armL = new THREE.Group();
  armL.position.set(-0.42, 1.45, 0);
  const armLMesh = box(0.2, 0.7, 0.2, 0x2a6fd6);
  armLMesh.position.y = -0.35;
  armL.add(armLMesh);

  const armR = new THREE.Group();
  armR.position.set(0.42, 1.45, 0);
  const armRMesh = box(0.2, 0.7, 0.2, 0x2a6fd6);
  armRMesh.position.y = -0.35;
  armR.add(armRMesh);
  // Sword held in the right hand, with the blade hanging down along the arm.
  const botSword = buildSwordMesh();
  botSword.position.set(0, -0.7, 0);
  botSword.rotation.x = Math.PI;
  armR.add(botSword);

  root.add(legL, legR, torso, head, eyeL, eyeR, armL, armR);
  return { root, legL, legR, armL, armR, mats };
}

const botRig = buildBot();
scene.add(botRig.root);

// ---------- Game state ----------
const player = {
  pos: PLAYER_SPAWN.clone(),
  vel: new THREE.Vector3(),
  knock: new THREE.Vector3(),
  onGround: true,
  hp: stats.playerMaxHp,
  dead: false,
  respawnTimer: 0,
  swingCooldown: 0,
  swinging: false,
  swingProgress: 0,
  hitDone: false,
};

const bot = {
  ...botRig,
  pos: BOT_SPAWN.clone(),
  kb: new THREE.Vector3(),
  hp: stats.botMaxHp,
  dead: false,
  respawnTimer: 0,
  attackCooldown: 0,
  attackT: -1,          // -1 = not attacking, otherwise 0..1 through the swing
  attackHit: false,
  hitFlash: 0,
  walkTime: 0,
  glitchTimer: 0,       // > 0 while the CPU is glitching after a hit
  glitchFlip: 0,        // time until the next color/shake change
  glitchMats: null,     // every material on the bot, collected on first use
  stunTimer: 0,         // > 0 while recovering from a sword hit
  dodgeTimer: 0,        // > 0 while the bot is in a dodge (it can't be hit during it)
  dodgeCooldown: 0,     // > 0 before the bot may dodge again
  blockTimer: 0,        // > 0 while the bot's sword is raised to block
  strafeDir: 1,         // +1 or -1: which way it circles the player
  strafeFlip: 0,        // time until it may change strafe direction
  coverTimer: 0,        // > 0 while hiding behind a pillar
  inCover: false,
  swingDecided: false,  // true once the bot has rolled dodge/block for the current swing
};

let kills = 0;
let deaths = 0;
let streak = 0;          // CPU kills in a row without dying; resets on death
let hurtTimer = 0;
let messageTimer = 0;
let matchActive = false;   // true only while playing (not in a menu)

// ---------- DOM refs ----------
const playerFill = document.getElementById('playerFill');
const botFill = document.getElementById('botFill');
const scoreEl = document.getElementById('score');
const coinsHudEl = document.getElementById('coinsHud');
const botStatusEl = document.getElementById('botStatus');
const messageEl = document.getElementById('message');
const deathMsgEl = document.getElementById('deathMsg');
const hurtEl = document.getElementById('hurt');

const menuEl = document.getElementById('menu');
const pauseEl = document.getElementById('pause');
const shopEl = document.getElementById('shop');
const shopPlayerEl = document.getElementById('shopPlayer');
const shopCpuEl = document.getElementById('shopCpu');
const onlineEl = document.getElementById('online');

function showMessage(text, seconds) {
  messageEl.textContent = text;
  messageTimer = seconds;
}

// ---------- Screens ----------
// Which screen is visible: 'menu', 'pause', 'shop', or 'match'.
let currentScreen = 'menu';

function setScreen(name) {
  currentScreen = name;
  menuEl.classList.toggle('active', name === 'menu');
  pauseEl.classList.toggle('active', name === 'pause');
  shopEl.classList.toggle('active', name === 'shop');
  onlineEl.classList.toggle('active', name === 'online');
  document.body.classList.toggle('in-match', name === 'match');
  refreshCoinLabels();
}

function refreshCoinLabels() {
  for (const el of document.querySelectorAll('.coinLabel')) el.textContent = String(save.coins);
  coinsHudEl.querySelector('.coinLabel').textContent = String(save.coins);
}

// ---------- Controls ----------
const controls = new PointerLockControls(camera, renderer.domElement);
const keys = {};

window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space' && currentScreen === 'match') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
});
window.addEventListener('mousedown', (e) => {
  if (e.button === 0 && currentScreen === 'match' && controls.isLocked) startSwing();
});

// Pressing Esc during a match releases pointer lock; the browser fires 'unlock',
// which opens the pause menu.
controls.addEventListener('unlock', () => {
  for (const k in keys) keys[k] = false;
  if (currentScreen === 'match') setScreen('pause');
});
// If the browser refuses pointer lock, fall back to the pause menu so the player isn't stuck.
document.addEventListener('pointerlockerror', () => {
  if (currentScreen === 'match') setScreen('pause');
});

// Requests pointer lock; called from a click so the browser allows it.
function enterMatchInput() {
  setScreen('match');
  controls.lock();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Sword logic ----------
function startSwing() {
  if (player.dead || player.swinging || player.swingCooldown > 0) return;
  player.swinging = true;
  player.swingProgress = 0;
  player.hitDone = false;
  player.swingCooldown = SWING_COOLDOWN;
  trailPoints.length = 0;
}

function tryHitBot() {
  if (bot.dead) return;
  const toBot = new THREE.Vector3(bot.pos.x - player.pos.x, 0, bot.pos.z - player.pos.z);
  const dist = toBot.length();
  if (dist > SWORD_RANGE || dist === 0) return;
  toBot.divideScalar(dist);
  const forward = getFlatForward(new THREE.Vector3());
  if (toBot.dot(forward) < 0.3) return; // bot must be in front of the blade
  hurtBot(stats.swordDamage, toBot);
}

function updateSword(dt) {
  player.swingCooldown = Math.max(0, player.swingCooldown - dt);

  if (player.swinging) {
    player.swingProgress += dt / SWING_DURATION;
    if (!player.hitDone && player.swingProgress >= SWING_HIT_POINT) {
      player.hitDone = true;
      tryHitBot();
    }
    if (player.swingProgress >= 1) {
      player.swinging = false;
      if (trailPoints.length >= 2) spawnSwingTrail(trailPoints.slice());
      trailPoints.length = 0;
    }
  }

  const p = player.swinging ? player.swingProgress : 0;
  // The blade points straight up at rest, so the swing sweeps it across the screen by rolling
  // around the view axis. A yaw would only spin a vertical blade in place, so it isn't used here.
  const sweep = player.swinging ? 0.9 - 1.8 * p : 0;
  const pitch = HOLD_PITCH - (player.swinging ? 0.2 * Math.sin(p * Math.PI) : 0);
  swordPivot.rotation.set(pitch, 0, sweep);

  // Record the blade tip while swinging so the trail follows the arc.
  if (player.swinging) {
    camera.updateMatrixWorld(true);
    const local = camera.worldToLocal(swordTip.getWorldPosition(tmpTip));
    trailPoints.push(local.clone());

    // Sparks leave the blade tip while swinging, about every 30 ms.
    tipSparkTimer -= dt;
    if (tipSparkTimer <= 0) {
      tipSparkTimer = 0.03;
      spawnTipSpark();
    }

    // Afterimage ghosts, about every 25 ms during the swing.
    ghostTimer -= dt;
    if (ghostTimer <= 0) {
      ghostTimer = 0.025;
      spawnSwordGhost();
    }
  }
}

// ---------- Damage ----------
function hurtBot(amount, dirFromPlayer) {
  if (bot.dead) return;

  // Dodge: the bot is already out of the blade's path, so the hit misses.
  if (bot.dodgeTimer > 0) return;

  // Block: a raised sword takes less damage and no knockback.
  if (bot.blockTimer > 0) {
    bot.hp = Math.max(0, bot.hp - amount * BOT_BLOCK_DAMAGE_MULT);
    bot.hitFlash = 0.08;
    spawnSparks(new THREE.Vector3(bot.pos.x, 1.3, bot.pos.z));
    if (bot.hp <= 0) killBot();
    return;
  }

  bot.hp = Math.max(0, bot.hp - amount);
  bot.hitFlash = 0.15;
  bot.glitchTimer = BOT_GLITCH_TIME;
  bot.glitchFlip = 0;
  bot.kb.copy(dirFromPlayer).multiplyScalar(SWORD_KNOCKBACK);
  bot.stunTimer = BOT_STUN_TIME;
  bot.attackT = -1; // a hit cancels the bot's swing in progress
  spawnSparks(new THREE.Vector3(bot.pos.x, 1.1, bot.pos.z));
  spawnArcBurst();
  spawnShockRing(new THREE.Vector3(bot.pos.x, 1.0, bot.pos.z), camera.position);
  playerSwordFx.flashTimer = 0.15;
  hitStopTimer = HIT_STOP_TIME;
  shakeTimer = SHAKE_TIME;
  if (bot.hp <= 0) killBot();
}

// Bigger burst of palette-colored sparks when the CPU dies.
function spawnKillBurst(position) {
  for (let i = 0; i < 40; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: randomOf(SWORD_GLOW), transparent: true });
    const mesh = new THREE.Mesh(sparkGeo, mat);
    mesh.scale.setScalar(0.6 + Math.random() * 0.8);
    mesh.position.copy(position);
    scene.add(mesh);
    const vel = new THREE.Vector3((Math.random() - 0.5) * 9, 3 + Math.random() * 6, (Math.random() - 0.5) * 9);
    effects.push({ kind: 'spark', mesh, vel, life: 0.8, maxLife: 0.8 });
  }
}

// Shared kill handling, used by both normal hits and blocked hits.
function killBot() {
  bot.dead = true;
  bot.respawnTimer = BOT_RESPAWN_TIME;
  bot.root.rotation.x = -Math.PI / 2;
  kills++;
  streak++;
  spawnKillBurst(new THREE.Vector3(bot.pos.x, 1.0, bot.pos.z));
  save.coins += stats.botReward;
  saveProgress();
  refreshCoinLabels();
  // Show the defeat reward first, then the streak when it reaches x2 or more.
  // showMessage replaces the text, so the streak is the last message and stays on screen.
  showMessage(`You defeated the bot! +${stats.botReward} coins`, 1.2);
  if (streak >= 2) showMessage(`x${streak} STREAK!`, 2.5);
}

function damagePlayer(amount, dirFromBot) {
  if (player.dead) return;
  player.hp = Math.max(0, player.hp - amount);
  streak = 0; // a death ends the streak
  player.knock.addScaledVector(dirFromBot, 6);
  hurtTimer = 0.3;
  if (player.hp <= 0) {
    player.dead = true;
    player.respawnTimer = PLAYER_RESPAWN_TIME;
    deaths++;
  }
}

// ---------- Respawns ----------
function respawnPlayer() {
  player.pos.copy(PLAYER_SPAWN);
  player.vel.set(0, 0, 0);
  player.knock.set(0, 0, 0);
  player.onGround = true;
  player.hp = stats.playerMaxHp;
  player.dead = false;
  player.swinging = false;
  // Face the bot.
  const dx = BOT_SPAWN.x - PLAYER_SPAWN.x;
  const dz = BOT_SPAWN.z - PLAYER_SPAWN.z;
  camera.rotation.set(0, Math.atan2(-dx, -dz), 0);
  camera.position.set(player.pos.x, player.pos.y + EYE_HEIGHT, player.pos.z);
}

function respawnBot() {
  bot.pos.copy(BOT_SPAWN);
  bot.kb.set(0, 0, 0);
  bot.hp = stats.botMaxHp;
  bot.dead = false;
  bot.attackT = -1;
  bot.attackCooldown = 1;
  bot.stunTimer = 0;
  bot.root.rotation.x = 0;
}

// ---------- Player update ----------
const tmpFwd = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpMove = new THREE.Vector3();

function updatePlayer(dt) {
  if (player.dead) {
    player.respawnTimer -= dt;
    if (player.respawnTimer <= 0) respawnPlayer();
  } else {
    const fwd = getFlatForward(tmpFwd);
    const right = tmpRight.crossVectors(fwd, UP);
    const move = tmpMove.set(0, 0, 0);
    if (keys.KeyW) move.add(fwd);
    if (keys.KeyS) move.sub(fwd);
    if (keys.KeyD) move.add(right);
    if (keys.KeyA) move.sub(right);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(stats.playerSpeed);

    player.pos.addScaledVector(move, dt);
    player.pos.addScaledVector(player.knock, dt);
    player.knock.multiplyScalar(Math.exp(-dt * 8));

    if (keys.Space && player.onGround) {
      player.vel.y = JUMP_SPEED;
      player.onGround = false;
    }
    player.vel.y += GRAVITY * dt;
    player.pos.y += player.vel.y * dt;
    if (player.pos.y <= 0) {
      player.pos.y = 0;
      player.vel.y = 0;
      player.onGround = true;
    }

    constrainToArena(player.pos, PLAYER_RADIUS);
  }

  camera.position.set(player.pos.x, player.pos.y + EYE_HEIGHT, player.pos.z);
}

// ---------- Bot update ----------
const tmpToPlayer = new THREE.Vector3();

// ---------- Hard-CPU tactics ----------
// Returns the pillar the bot could hide behind, or null. A pillar works as cover when it sits
// between the bot and the player.
function findCoverPillar() {
  let best = null;
  let bestScore = Infinity;
  for (const p of PILLARS) {
    // Spot just behind the pillar, on the side away from the player.
    const awayX = p.x - player.pos.x;
    const awayZ = p.z - player.pos.z;
    const len = Math.hypot(awayX, awayZ) || 1;
    const spot = { x: p.x + (awayX / len) * (PILLAR_RADIUS + 0.9), z: p.z + (awayZ / len) * (PILLAR_RADIUS + 0.9) };
    const d = Math.hypot(spot.x - bot.pos.x, spot.z - bot.pos.z);
    if (d < bestScore) {
      bestScore = d;
      best = spot;
    }
  }
  return best;
}

// Dodge and block are decided when the player starts a swing.
function updateBotDefense(dt) {
  bot.dodgeTimer = Math.max(0, bot.dodgeTimer - dt);
  bot.dodgeCooldown = Math.max(0, bot.dodgeCooldown - dt);
  bot.blockTimer = Math.max(0, bot.blockTimer - dt);

  // Decide once per swing, when the swing is underway. `swingDecided` stops it re-rolling each frame.
  if (player.swinging && !bot.swingDecided) {
    bot.swingDecided = true;
    if (bot.dodgeCooldown <= 0 && Math.random() < BOT_DODGE_CHANCE) {
      bot.dodgeTimer = BOT_DODGE_DELAY + 0.25;   // covers the moment the blade would land
      bot.dodgeCooldown = BOT_DODGE_COOLDOWN;
    } else if (Math.random() < BOT_BLOCK_CHANCE) {
      bot.blockTimer = 0.5;                      // raises the sword to block
    }
  }
  if (!player.swinging) bot.swingDecided = false;
}

// Strafing: circle the player at range, and switch direction now and then.
function strafeMove(dt, toPlayer, dist) {
  bot.strafeFlip -= dt;
  if (bot.strafeFlip <= 0) {
    bot.strafeFlip = 1.2 + Math.random() * 1.2;
    if (Math.random() < 0.5) bot.strafeDir *= -1;
  }
  // Sideways direction is perpendicular to the line to the player.
  const side = { x: -toPlayer.z * bot.strafeDir, z: toPlayer.x * bot.strafeDir };
  bot.pos.x += side.x * BOT_STRAFE_SPEED * dt;
  bot.pos.z += side.z * BOT_STRAFE_SPEED * dt;
  // Back off if too close, and move in if too far, so it holds about BOT_STRAFE_RANGE.
  const pull = (dist - BOT_STRAFE_RANGE) * 1.5;
  bot.pos.x += toPlayer.x * pull * dt;
  bot.pos.z += toPlayer.z * pull * dt;
}

// Cover: when low on HP, hide behind a pillar for a while, then come back out.
function updateBotCover(dt, toPlayer) {
  if (bot.inCover) {
    bot.coverTimer -= dt;
    if (bot.coverTimer <= 0) bot.inCover = false;
    return true;
  }
  if (bot.hp / stats.botMaxHp <= BOT_COVER_HP && !player.dead) {
    const spot = findCoverPillar();
    if (spot) {
      const dx = spot.x - bot.pos.x;
      const dz = spot.z - bot.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.6) {
        bot.inCover = true;
        bot.coverTimer = BOT_COVER_TIME;
        return true;
      }
      bot.pos.x += (dx / d) * stats.botSpeed * dt;
      bot.pos.z += (dz / d) * stats.botSpeed * dt;
      return true;
    }
  }
  return false;
}

// When the CPU is hit it flickers through the palette and shakes, then returns to normal.
function updateBotGlitch(dt) {
  if (!bot.glitchMats) {
    // Collect every material on the bot (body and sword) and remember its original color.
    bot.glitchMats = [];
    bot.root.traverse((o) => {
      if (o.isMesh && !bot.glitchMats.includes(o.material)) {
        o.material.userData.baseColor = o.material.color.getHex();
        bot.glitchMats.push(o.material);
      }
    });
  }

  if (bot.glitchTimer <= 0) return;
  bot.glitchTimer = Math.max(0, bot.glitchTimer - dt);

  if (bot.glitchTimer === 0) {
    for (const m of bot.glitchMats) m.color.setHex(m.userData.baseColor);
    bot.root.rotation.z = 0;
    bot.root.scale.x = 1;
    return;
  }

  bot.glitchFlip -= dt;
  if (bot.glitchFlip <= 0) {
    bot.glitchFlip = 0.05;
    for (const m of bot.glitchMats) m.color.setHex(randomOf(BOT_GLITCH_PALETTE));
    bot.root.rotation.z = (Math.random() - 0.5) * 0.3;
    bot.root.scale.x = 1 + (Math.random() - 0.5) * 0.4;
  }
}

function setFlash(entity, on) {
  for (const m of entity.mats) m.emissive.setHex(on ? 0x770000 : 0x000000);
}

function updateBot(dt) {
  bot.hitFlash = Math.max(0, bot.hitFlash - dt);
  setFlash(bot, bot.hitFlash > 0);
  updateBotGlitch(dt);

  if (bot.dead) {
    bot.respawnTimer -= dt;
    if (bot.respawnTimer <= 0) respawnBot();
    bot.root.position.copy(bot.pos);
    return;
  }

  bot.attackCooldown = Math.max(0, bot.attackCooldown - dt);
  bot.stunTimer = Math.max(0, bot.stunTimer - dt);
  const stunned = bot.stunTimer > 0;

  const toPlayer = tmpToPlayer.set(player.pos.x - bot.pos.x, 0, player.pos.z - bot.pos.z);
  const dist = toPlayer.length();
  if (dist > 0) toPlayer.divideScalar(dist);
  bot.root.rotation.y = Math.atan2(-toPlayer.x, -toPlayer.z); // face the player

  bot.pos.addScaledVector(bot.kb, dt);
  bot.kb.multiplyScalar(Math.exp(-dt * KNOCKBACK_DECAY));

  updateBotDefense(dt);

  let moving = false;
  // While in cover the bot stays put, out of the player's reach.
  const inCoverMode = !stunned && updateBotCover(dt, toPlayer);
  if (!player.dead && !stunned && !inCoverMode) {
    if (dist > BOT_STOP_DISTANCE + 1.5) {
      // Far away: walk in, and strafe once close enough to pressure.
      bot.pos.addScaledVector(toPlayer, stats.botSpeed * dt);
      moving = true;
    } else if (dist > BOT_STOP_DISTANCE) {
      strafeMove(dt, toPlayer, dist);
      moving = true;
    } else {
      // Close: keep circling so it doesn't stand still in front of you.
      strafeMove(dt, toPlayer, dist);
      moving = true;
    }
    if (bot.attackT < 0 && bot.attackCooldown <= 0 && dist <= BOT_ATTACK_RANGE && !inCoverMode) {
      bot.attackT = 0;
      bot.attackCooldown = BOT_ATTACK_COOLDOWN;
      bot.attackHit = false;
    }
  }

  if (bot.attackT >= 0) {
    bot.attackT += dt / BOT_SWING_TIME;
    if (!bot.attackHit && bot.attackT >= 0.5) {
      bot.attackHit = true;
      if (dist <= BOT_ATTACK_RANGE + 0.3 && !player.dead) {
        damagePlayer(stats.botDamage, toPlayer);
      }
    }
    if (bot.attackT >= 1) bot.attackT = -1;
  }

  // Walk and attack animation
  if (moving) bot.walkTime += dt * 9;
  const swing = moving ? Math.sin(bot.walkTime) * 0.6 : 0;
  bot.legL.rotation.x = swing;
  bot.legR.rotation.x = -swing;
  bot.armL.rotation.x = -swing * 0.5;
  const attackArc = bot.attackT >= 0 ? Math.sin(bot.attackT * Math.PI) : 0;
  // Blocking holds the sword up in front of the face; otherwise it swings as before.
  const guardUp = bot.blockTimer > 0 ? 1.7 : 0;
  bot.armR.rotation.x = 0.4 + attackArc * 1.2 + guardUp;

  constrainToArena(bot.pos, BOT_RADIUS);
  bot.root.position.copy(bot.pos);
}

// ---------- HUD ----------
function updateHUD(dt) {
  playerFill.style.width = `${Math.min(100, (player.hp / stats.playerMaxHp) * 100)}%`;
  botFill.style.width = `${Math.min(100, (bot.hp / stats.botMaxHp) * 100)}%`;
  scoreEl.innerHTML = `Kills: ${kills} &nbsp; Deaths: ${deaths}`;

  if (player.dead && currentScreen === 'match') {
    deathMsgEl.style.display = 'block';
    deathMsgEl.textContent = `You died! Respawning in ${Math.ceil(player.respawnTimer)}...`;
  } else {
    deathMsgEl.style.display = 'none';
  }

  botStatusEl.textContent = bot.dead
    ? `Bot respawning in ${Math.ceil(bot.respawnTimer)}...`
    : '';

  hurtTimer = Math.max(0, hurtTimer - dt);
  hurtEl.style.opacity = String(hurtTimer / 0.3);

  messageTimer = Math.max(0, messageTimer - dt);
  if (messageTimer === 0) messageEl.textContent = '';
}

// ---------- Shop ----------
let shopReturnScreen = 'menu';

function renderShopRows(container, upgrades) {
  container.innerHTML = '';
  for (const u of upgrades) {
    const level = save.levels[u.key];
    const row = document.createElement('div');
    row.className = 'shop-row';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'shop-name';
    name.textContent = u.label;
    const level_ = document.createElement('span');
    level_.textContent = `Lv ${level}/${MAX_LEVEL}`;
    name.appendChild(level_);
    const desc = document.createElement('div');
    desc.className = 'shop-desc';
    desc.textContent = u.desc;
    info.append(name, desc);

    const btn = document.createElement('button');
    btn.className = 'btn small';
    if (level >= MAX_LEVEL) {
      btn.textContent = 'MAX';
      btn.disabled = true;
    } else {
      const cost = upgradeCost(u.key);
      btn.textContent = `Buy: ${cost} coins`;
      btn.disabled = save.coins < cost;
      btn.addEventListener('click', () => buyUpgrade(u.key));
    }

    row.append(info, btn);
    container.appendChild(row);
  }
}

function renderShop() {
  renderShopRows(shopPlayerEl, PLAYER_UPGRADES);
  renderShopRows(shopCpuEl, CPU_UPGRADES);
  refreshCoinLabels();
}

function buyUpgrade(key) {
  if (save.levels[key] >= MAX_LEVEL) return;
  const cost = upgradeCost(key);
  if (save.coins < cost) return;
  save.coins -= cost;
  save.levels[key] += 1;
  saveProgress();
  stats = computeStats();
  renderShop();
}

function openShop(from) {
  shopReturnScreen = from;
  renderShop();
  setScreen('shop');
}

// ---------- Match flow ----------
function startMatch() {
  kills = 0;
  deaths = 0;
  streak = 0;
  hurtTimer = 0;
  messageTimer = 0;
  messageEl.textContent = '';
  respawnPlayer();
  respawnBot();
  bot.hp = stats.botMaxHp;
  bot.root.rotation.x = 0;
  enterMatchInput();
}

function quitToMenu() {
  setScreen('menu');   // set first so the 'unlock' handler doesn't reopen pause
  controls.unlock();
  for (const k in keys) keys[k] = false;
}

// ---------- Online lobbies (menu) ----------
const lobbyListEl = document.getElementById('lobbyList');
const onlineStatusEl = document.getElementById('onlineStatus');
let lobbiesCache = [];

function setOnlineStatus(text) {
  onlineStatusEl.textContent = text;
}

// Draws the open lobbies. Each lobby with a free seat gets a Join button.
function renderLobbies() {
  lobbyListEl.innerHTML = '';
  if (lobbiesCache.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No open lobbies yet. Create one, and it appears on everyone\'s screen.';
    lobbyListEl.appendChild(empty);
    return;
  }
  for (const lobby of lobbiesCache) {
    const row = document.createElement('div');
    row.className = 'shop-row';
    const info = document.createElement('div');
    info.className = 'shop-name';
    info.textContent = `${lobby.name} `;
    const count = document.createElement('span');
    count.textContent = `${lobby.players}/${lobby.max} players`;
    info.appendChild(count);
    const btn = document.createElement('button');
    btn.className = 'btn small';
    const full = lobby.players >= lobby.max;
    btn.textContent = full ? 'Full' : 'Join';
    btn.disabled = full;
    btn.addEventListener('click', () => joinOnlineLobby(lobby.id));
    row.append(info, btn);
    lobbyListEl.appendChild(row);
  }
}

async function createOnlineLobby() {
  try {
    setOnlineStatus('Creating lobby...');
    await window.online.createLobby('Duel');
    setOnlineStatus('Lobby created. Waiting for someone to join...');
  } catch (err) {
    setOnlineStatus(`Could not create lobby: ${err.message}`);
  }
}

async function joinOnlineLobby(lobbyId) {
  try {
    setOnlineStatus('Joining...');
    await window.online.joinLobby(lobbyId);
    setOnlineStatus('Joined. Waiting for the match to start...');
  } catch (err) {
    setOnlineStatus(`Could not join: ${err.message}`);
  }
}

function openOnline() {
  window.online.connect();
  setOnlineStatus('Connecting...');
  renderLobbies();
  setScreen('online');
}

window.online.on('lobbies', (list) => {
  lobbiesCache = list;
  if (currentScreen === 'online') renderLobbies();
});
window.online.on('connection', () => setOnlineStatus('Connection lost. Refresh the page to reconnect.'));
window.online.on('matched', (info) => {
  setOnlineStatus('Matched! Starting...');
  // The match itself is started in the next step.
});

document.getElementById('onlineBtn').addEventListener('click', openOnline);
document.getElementById('createLobbyBtn').addEventListener('click', createOnlineLobby);
document.getElementById('onlineBackBtn').addEventListener('click', () => {
  window.online.leaveLobby();
  setOnlineStatus('');
  setScreen('menu');
});

// ---------- Menu buttons ----------
document.getElementById('playBtn').addEventListener('click', startMatch);
document.getElementById('menuShopBtn').addEventListener('click', () => openShop('menu'));
document.getElementById('resumeBtn').addEventListener('click', () => enterMatchInput());
document.getElementById('pauseShopBtn').addEventListener('click', () => openShop('pause'));
document.getElementById('quitBtn').addEventListener('click', quitToMenu);
document.getElementById('shopBackBtn').addEventListener('click', () => setScreen(shopReturnScreen));

// ---------- Main loop ----------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // Hit-stop: while it runs, gameplay pauses but effects and rendering keep going.
  if (hitStopTimer > 0) hitStopTimer = Math.max(0, hitStopTimer - dt);
  else if (currentScreen === 'match' && controls.isLocked) {
    updatePlayer(dt);
    updateSword(dt);
    updateBot(dt);
  }

  // Screen shake: a small random camera offset that decays to zero. It is added after the
  // player's camera position is set, so it never changes the player's real position.
  // Reset to the player's real eye position first, so the offset never accumulates between frames.
  if (shakeTimer > 0) {
    shakeTimer = Math.max(0, shakeTimer - dt);
    const amount = SHAKE_STRENGTH * (shakeTimer / SHAKE_TIME);
    camera.position.set(player.pos.x, player.pos.y + EYE_HEIGHT, player.pos.z);
    camera.position.x += (Math.random() - 0.5) * 2 * amount;
    camera.position.y += (Math.random() - 0.5) * 2 * amount;
  }
  updateGlitch(dt);
  updateEffects(dt);
  updatePlayerSwordFx(dt);
  updateSwordArcs(dt);
  updateHUD(dt);
  renderer.render(scene, camera);
}

// Initial state: show the main menu with the arena behind it.
respawnPlayer();
bot.root.position.copy(bot.pos);
setScreen('menu');
renderShop();
animate();
