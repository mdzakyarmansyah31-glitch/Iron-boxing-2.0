import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  AiTendency,
  AttackType,
  BoxerAppearance,
  BoxerStats,
  CombatHudSnapshot,
  FightPhase,
  FighterProfile,
  FightSummaryStats,
  GraphicsQuality,
  OpponentProfile,
} from '../types/game';
import {
  ArenaHandle,
  createBoxingArena,
  PLAYABLE_HALF_BOUND,
  ROPE_CONTACT_THRESHOLD,
  RopeContact,
} from './arena';
import { soundEngine } from './audio';
import { PLAYABLE_FIGHTERS } from '../data/fighters';
import { createBoxerWaitingRoom, WaitingRoomHandle } from './waitingRoom';
import {
  BoxerAnimState,
  BoxerRig,
  createBoxerRig,
  createInitialRagdollState,
  disposeBoxerRig,
  resolveFighterMotionProfile,
  triggerHitPhysicsImpulse,
  triggerKnockdownRagdoll,
  updateBoxerPose,
} from './boxerMesh';
import {
  CoachAnimState,
  CoachRig,
  createCoachRig,
  disposeCoachRig,
  updateCoachPose,
} from './coachMesh';

// Module-scope reusable math objects (zero GC in render loop)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _camGoal = new THREE.Vector3();
const _lookGoal = new THREE.Vector3();
const _moveDir = new THREE.Vector3();
const _dummy = new THREE.Object3D();
const _pColor = new THREE.Color();

interface FighterSim {
  isPlayer: boolean;
  name: string;
  stats: BoxerStats;
  stance: 'Orthodox' | 'Southpaw';
  rig: BoxerRig;
  anim: BoxerAnimState;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  facingAngle: number;

  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  guard: number;
  maxGuard: number;
  knockdowns: number;
  roundDamage: number;

  // Combat state machine
  attackType: AttackType | null;
  attackTimer: number;
  attackDuration: number;
  attackWindup: number;
  attackActiveEnd: number;
  attackHasHit: boolean;
  bufferedAttack: AttackType | null;
  bufferTimer: number;

  isGuarding: boolean;
  guardBreakTimer: number;
  dodgeTimer: number;
  dodgeDuration: number;
  dodgeCooldown: number;
  dodgeDirX: number;
  dodgeDirZ: number;
  invulnTimer: number;
  hitStunTimer: number;
  counterWindowTimer: number;
  comboCount: number;
  comboResetTimer: number;

  // AI fields
  aiTendency?: AiTendency;
  aiThinkTimer: number;
  aiMoveX: number;
  aiMoveZ: number;
  aiComboQueue: AttackType[];
  aiGuardHoldTimer: number;
}

interface CoachSim {
  rig: CoachRig;
  anim: CoachAnimState;
  pos: THREE.Vector3;
  facingAngle: number;
  corner: 'red' | 'blue';
  startPos: THREE.Vector3;
}

interface Particle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  colorHex: number;
}

interface ReplayFighterPose {
  posX: number;
  posZ: number;
  facingAngle: number;
  pelvisX: number;
  pelvisY: number;
  pelvisZ: number;
  pelvisRotX: number;
  pelvisRotY: number;
  pelvisRotZ: number;
  torsoRotX: number;
  torsoRotY: number;
  torsoRotZ: number;
  headRotX: number;
  headRotY: number;
  headRotZ: number;
  lShX: number;
  lShY: number;
  lShZ: number;
  lElX: number;
  lElY: number;
  lElZ: number;
  lRoll: number;
  rShX: number;
  rShY: number;
  rShZ: number;
  rElX: number;
  rElY: number;
  rElZ: number;
  rRoll: number;
  lHipX: number;
  lHipZ: number;
  lKneeX: number;
  lAnkX: number;
  lAnkZ: number;
  rHipX: number;
  rHipZ: number;
  rKneeX: number;
  rAnkX: number;
  rAnkZ: number;
  hairX: number;
  hairZ: number;
  hitFlash: number;
  shadowScale: number;
}

interface ReplayFrame {
  t: number;
  player: ReplayFighterPose;
  opp: ReplayFighterPose;
}

function createEmptyReplayPose(): ReplayFighterPose {
  return {
    posX: 0,
    posZ: 0,
    facingAngle: 0,
    pelvisX: 0,
    pelvisY: 0.94,
    pelvisZ: 0,
    pelvisRotX: 0,
    pelvisRotY: 0,
    pelvisRotZ: 0,
    torsoRotX: 0,
    torsoRotY: 0,
    torsoRotZ: 0,
    headRotX: 0,
    headRotY: 0,
    headRotZ: 0,
    lShX: 0,
    lShY: 0,
    lShZ: 0,
    lElX: 0,
    lElY: 0,
    lElZ: 0,
    lRoll: 0,
    rShX: 0,
    rShY: 0,
    rShZ: 0,
    rElX: 0,
    rElY: 0,
    rElZ: 0,
    rRoll: 0,
    lHipX: 0,
    lHipZ: 0,
    lKneeX: 0,
    lAnkX: 0,
    lAnkZ: 0,
    rHipX: 0,
    rHipZ: 0,
    rKneeX: 0,
    rAnkX: 0,
    rAnkZ: 0,
    hairX: 0,
    hairZ: 0,
    hitFlash: 0,
    shadowScale: 1,
  };
}

export interface FightConfig {
  playerProfile: FighterProfile;
  playerName: string;
  playerStats: BoxerStats;
  playerSharpness: number; // 0..100
  playerEnergy: number; // 0..100
  opponent: OpponentProfile;
  rounds: number;
  roundSeconds: number;
}

export class BoxingSceneController {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private arena: ArenaHandle;
  private waitingRoom: WaitingRoomHandle;
  private keyLight!: THREE.DirectionalLight;
  private overheadSpot!: THREE.SpotLight;
  private graphicsQuality: GraphicsQuality = 'high';
  private activeParticleLimit = 56;
  private isSoftwareGl: boolean;
  private maxAnisotropy = 4;
  private envRT: THREE.WebGLRenderTarget;
  private ropeContactPool: RopeContact[] = [
    { x: 0, z: 0, minY: 0.2, maxY: 1.68, radius: 0.42, vx: 0, vz: 0 },
    { x: 0, z: 0, minY: 0.2, maxY: 1.68, radius: 0.42, vx: 0, vz: 0 },
  ];
  private activeRopeContacts: RopeContact[] = [];

  private playerSim: FighterSim | null = null;
  private oppSim: FighterSim | null = null;
  private playerCoachSim: CoachSim | null = null;
  private oppCoachSim: CoachSim | null = null;

  private walkoutClock = 0;
  private readonly walkoutDuration = 6.2;
  private celebrationClock = 0;
  private readonly celebrationDuration = 4.8;

  private mode: 'attract' | 'waitingroom' | 'showcase' | 'faceoff' | 'creator' | 'fight' = 'attract';
  private waitingIdleClock = 0;
  private waitingSpecialActive = false;
  private waitingSpecialTimer = 0;
  private waitingSpecialKind = 0;
  private readonly WAITING_SPECIAL_INTERVAL = 20;
  private readonly WAITING_SPECIAL_DURATION = 3.8;
  private waitingRotateClock = 0;
  private waitingRosterIndex = 0;
  private readonly WAITING_ROTATE_INTERVAL = 24;
  private onWaitingFighterChange?: (fighter: FighterProfile) => void;
  private waitingConfirmActive = false;
  private waitingConfirmTimer = 0;
  private readonly WAITING_CONFIRM_DURATION = 0.72;
  private waitingConfirmCallback: (() => void) | null = null;
  private paused = false;
  private phase: FightPhase = 'intro';
  private round = 1;
  private maxRounds = 3;
  private roundDuration = 75;
  private roundTimer = 75;
  private phaseTimer = 0;

  // Knockdown tracking
  private knockdownTarget: 'player' | 'opponent' | null = null;
  private knockdownCount = 0;
  private knockdownTickTimer = 0;
  private knockdownRecoveryCount = 8;
  private playerGetupBoost = 0;
  private knockdownLeadInTimer = 0;

  // Slow-motion Knockdown Highlight Replay
  private readonly MAX_REPLAY_FRAMES = 160;
  private replayBuffer: ReplayFrame[] = [];
  private replayOrdered: ReplayFrame[] = [];
  private replayWriteIdx = 0;
  private replayFilledCount = 0;
  private replayOrderedCount = 0;
  private fightSimClock = 0;
  private highlightPunch: AttackType | null = null;
  private highlightAttacker: 'player' | 'opponent' | null = null;
  private highlightIsCounter = false;
  private highlightImpactTime = 0;
  private highlightStartTime = 0;
  private highlightEndTime = 0;
  private highlightCursor = 0;
  private highlightImpactFxFired = false;
  private highlightOrbitSide = 1;
  private highlightAxisX = 1;
  private highlightAxisZ = 0;
  private savedPostFallPlayer: ReplayFighterPose = createEmptyReplayPose();
  private savedPostFallOpp: ReplayFighterPose = createEmptyReplayPose();

  // Juice & FX
  private hitstopTimer = 0;
  private shakeIntensity = 0;
  private crowdExcitement = 0;
  private calloutText: string | null = null;
  private calloutTone: 'gold' | 'red' | 'cyan' | 'white' = 'white';
  private calloutTimer = 0;

  // Camera state (UFC 5 dynamic broadcast side-angle)
  private camPos = new THREE.Vector3(0, 2.3, 4.6);
  private camLook = new THREE.Vector3(0, 1.1, 0);
  private prevPerp = new THREE.Vector3(0, 0, 1);
  private showcaseAngle = 0.35;

  // Particle pool (InstancedMesh)
  private particles: Particle[] = [];
  private particleMesh: THREE.InstancedMesh;
  private readonly MAX_PARTICLES = 56;

  // Input state (continuous held vs edge actions)
  private analogX = 0;
  private analogY = 0;
  private keysHeld: Record<string, boolean> = {};
  private virtualGuardHeld = false;

  // Summary stats
  private summary: FightSummaryStats = {
    landed: 0,
    thrown: 0,
    counters: 0,
    blocks: 0,
    dodges: 0,
    oppLanded: 0,
    oppThrown: 0,
  };
  private winner: 'player' | 'opponent' | null = null;
  private winMethod: 'KO' | 'TKO' | 'UD' | null = null;

  // Loop & callbacks
  private clock = new THREE.Clock();
  private elapsed = 0;
  private frameId = 0;
  private hudEmitAccum = 0;
  private disposed = false;
  private onHudUpdate: (snapshot: CombatHudSnapshot) => void;
  private onContextLost?: () => void;

  // Listeners for cleanup
  private resizeHandler: () => void;
  private blurHandler: () => void;
  private keyDownHandler: (e: KeyboardEvent) => void;
  private keyUpHandler: (e: KeyboardEvent) => void;

  constructor(
    container: HTMLElement,
    initialShowcasePlayer: FighterProfile,
    initialShowcaseOpp: OpponentProfile,
    onHudUpdate: (snapshot: CombatHudSnapshot) => void,
    onContextLost?: () => void,
  ) {
    this.container = container;
    this.onHudUpdate = onHudUpdate;
    this.onContextLost = onContextLost;

    // 1. Software WebGL probe
    this.isSoftwareGl = (() => {
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) return true;
      const ext = probe.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER;
      const gpu = String(probe.getParameter(param));
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    // 2. Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    this.renderer.setSize(w, h);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    // WebGL context loss listeners
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.onContextLost?.();
    });

    // 3. Scene & Fog
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090b12);
    this.scene.fog = new THREE.FogExp2(0x090b12, 0.025);

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 80);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    // 4. Mandatory RoomEnvironment IBL
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRT.texture;
    pmrem.dispose();

    // 5. Studio 3-Point Arena Lighting (<= 3 shadow casters)
    const hemi = new THREE.HemisphereLight(0x9ec5ff, 0x1e140d, 0.68);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xfff1dc, 2.15);
    keyLight.position.set(3.5, 8.2, 4.2);
    keyLight.castShadow = !this.isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 20;
    keyLight.shadow.camera.left = -5.2;
    keyLight.shadow.camera.right = 5.2;
    keyLight.shadow.camera.top = 5.2;
    keyLight.shadow.camera.bottom = -5.2;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    this.keyLight = keyLight;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x60a5fa, 1.05);
    rimLight.position.set(-4.8, 5.2, -4.6);
    this.scene.add(rimLight);

    const overheadSpot = new THREE.SpotLight(0xffe9c2, 18, 18, Math.PI / 4, 0.55, 1.5);
    overheadSpot.position.set(0, 6.4, 0);
    overheadSpot.target.position.set(0, 0.8, 0);
    this.overheadSpot = overheadSpot;
    this.scene.add(overheadSpot);
    this.scene.add(overheadSpot.target);

    // 6. Arena, Boxer Waiting Room & Pooled Particles
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.maxAnisotropy = maxAniso;
    this.arena = createBoxingArena(maxAniso, this.isSoftwareGl);
    this.scene.add(this.arena.group);
    this.waitingRoom = createBoxerWaitingRoom(maxAniso, this.isSoftwareGl);
    this.waitingRoom.group.visible = false;
    this.scene.add(this.waitingRoom.group);

    const partGeo = new THREE.SphereGeometry(0.032, 6, 6);
    const partMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.particleMesh = new THREE.InstancedMesh(partGeo, partMat, this.MAX_PARTICLES);
    this.particleMesh.frustumCulled = false;
    for (let i = 0; i < this.MAX_PARTICLES; i++) {
      this.particles.push({
        active: false,
        x: 0,
        y: -10,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        maxLife: 0.4,
        size: 1,
        colorHex: 0xffffff,
      });
      _dummy.position.set(0, -10, 0);
      _dummy.scale.setScalar(0.001);
      _dummy.updateMatrix();
      this.particleMesh.setMatrixAt(i, _dummy.matrix);
      this.particleMesh.setColorAt(i, _pColor.setHex(0xffffff));
    }
    this.particleMesh.instanceMatrix.needsUpdate = true;
    if (this.particleMesh.instanceColor) {
      this.particleMesh.instanceColor.needsUpdate = true;
    }
    this.particleMesh.computeBoundingSphere();
    this.scene.add(this.particleMesh);

    // Pre-allocate replay ring buffer (zero GC in render loop)
    for (let i = 0; i < this.MAX_REPLAY_FRAMES; i++) {
      const frame: ReplayFrame = {
        t: 0,
        player: createEmptyReplayPose(),
        opp: createEmptyReplayPose(),
      };
      this.replayBuffer.push(frame);
      this.replayOrdered.push(frame);
    }

    // 7. Initial Cinematic Attract Fight for Start Screen
    this.setupAttractFight(initialShowcasePlayer, initialShowcaseOpp);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    // 8. Window / Keyboard Listeners
    this.resizeHandler = () => {
      if (this.disposed) return;
      const cw = Math.max(1, this.container.clientWidth);
      const ch = Math.max(1, this.container.clientHeight);
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(cw, ch);
      this.setGraphicsQuality(this.graphicsQuality);
    };
    window.addEventListener('resize', this.resizeHandler);

    this.blurHandler = () => {
      this.keysHeld = {};
      this.virtualGuardHeld = false;
      this.analogX = 0;
      this.analogY = 0;
    };
    window.addEventListener('blur', this.blurHandler);

    this.keyDownHandler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      this.keysHeld[e.code] = true;
      if (this.mode !== 'fight' || this.paused) return;

      if (this.phase === 'walkout') {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          this.skipWalkout();
        }
        return;
      }

      if (this.phase === 'celebration') {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          this.skipCelebration();
        }
        return;
      }

      if (this.phase === 'highlight') {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          this.skipHighlight();
        }
        return;
      }

      if (e.code === 'KeyJ') {
        this.triggerAttack('jab');
      } else if (e.code === 'KeyU') {
        this.triggerAttack('hook');
      } else if (e.code === 'KeyK' || e.code === 'KeyI') {
        this.triggerAttack('heavy');
      } else if (e.code === 'KeyL' || e.code === 'KeyO') {
        this.triggerAttack('uppercut');
      } else if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        e.preventDefault();
        this.triggerDodge();
      }
    };
    window.addEventListener('keydown', this.keyDownHandler);

    this.keyUpHandler = (e: KeyboardEvent) => {
      this.keysHeld[e.code] = false;
    };
    window.addEventListener('keyup', this.keyUpHandler);

    this.clock.start();
    this.tick();
  }

  private clearFighters() {
    if (this.playerSim) {
      this.scene.remove(this.playerSim.rig.root);
      disposeBoxerRig(this.playerSim.rig);
      this.playerSim = null;
    }
    if (this.oppSim) {
      this.scene.remove(this.oppSim.rig.root);
      disposeBoxerRig(this.oppSim.rig);
      this.oppSim = null;
    }
    if (this.playerCoachSim) {
      this.scene.remove(this.playerCoachSim.rig.root);
      disposeCoachRig(this.playerCoachSim.rig);
      this.playerCoachSim = null;
    }
    if (this.oppCoachSim) {
      this.scene.remove(this.oppCoachSim.rig.root);
      disposeCoachRig(this.oppCoachSim.rig);
      this.oppCoachSim = null;
    }
  }

  private buildFighterSim(
    isPlayer: boolean,
    name: string,
    profile: FighterProfile,
    stats: BoxerStats,
    posX: number,
    posZ: number,
    facingAngle: number,
    hpFactor = 1,
    staminaFactor = 1,
    aiTendency?: AiTendency,
  ): FighterSim {
    const rig = createBoxerRig(profile.appearance, this.isSoftwareGl, this.maxAnisotropy);
    rig.root.position.set(posX, 0, posZ);
    rig.root.rotation.y = facingAngle;
    this.scene.add(rig.root);

    const maxHp = Math.round((90 + stats.chin * 0.95) * hpFactor);
    const maxStamina = Math.round((85 + stats.stamina * 0.85) * staminaFactor);
    const maxGuard = Math.round(70 + stats.defense * 0.9);

    const motionProfile = resolveFighterMotionProfile(profile.id, profile.styleLabel);

    return {
      isPlayer,
      name,
      stats,
      stance: profile.stance,
      rig,
      anim: {
        stance: profile.stance,
        time: isPlayer ? 0 : 1.7,
        moveSpeed: 0,
        moveForward: 0,
        moveStrafe: 0,
        prevMoveForward: 0,
        prevMoveStrafe: 0,
        gaitPhase: isPlayer ? 0 : 1.4,
        gaitWeight: 0,
        smoothForward: 0,
        smoothStrafe: 0,
        isGuarding: false,
        dodgeTimer: 0,
        dodgeDuration: 0.42,
        dodgeDirX: 0,
        dodgeDirZ: 0,
        attackType: null,
        attackProgress: 0,
        hitStunTimer: 0,
        hitFlash: 0,
        knockdownProgress: 0,
        headSpringX: 0,
        headSpringZ: 0,
        headSpringVelX: 0,
        headSpringVelZ: 0,
        torsoSpringX: 0,
        torsoSpringY: 0,
        torsoSpringZ: 0,
        torsoSpringVelX: 0,
        torsoSpringVelY: 0,
        torsoSpringVelZ: 0,
        hairSpringX: 0,
        hairSpringZ: 0,
        hairVelX: 0,
        hairVelZ: 0,
        guardShock: 0,
        motionProfile,
        walkoutMode: false,
        walkoutProgress: 0,
        walkoutStairWeight: 0,
        walkoutRopeDuck: 0,
        celebrationMode: false,
        celebrationProgress: 0,
        loserCornerMode: false,
        ragdoll: createInitialRagdollState(),
      },
      pos: new THREE.Vector3(posX, 0, posZ),
      vel: new THREE.Vector3(),
      facingAngle,
      hp: maxHp,
      maxHp,
      stamina: maxStamina,
      maxStamina,
      guard: maxGuard,
      maxGuard,
      knockdowns: 0,
      roundDamage: 0,
      attackType: null,
      attackTimer: 0,
      attackDuration: 0.35,
      attackWindup: 0.11,
      attackActiveEnd: 0.21,
      attackHasHit: false,
      bufferedAttack: null,
      bufferTimer: 0,
      isGuarding: false,
      guardBreakTimer: 0,
      dodgeTimer: 0,
      dodgeDuration: 0.42,
      dodgeCooldown: 0,
      dodgeDirX: 0,
      dodgeDirZ: 0,
      invulnTimer: 0,
      hitStunTimer: 0,
      counterWindowTimer: 0,
      comboCount: 0,
      comboResetTimer: 0,
      aiTendency,
      aiThinkTimer: 0.35,
      aiMoveX: 0,
      aiMoveZ: 0,
      aiComboQueue: [],
      aiGuardHoldTimer: 0,
    };
  }

  private buildCoachSim(
    fighterId: string,
    corner: 'red' | 'blue',
    styleLabel: string,
    posX: number,
    posY: number,
    posZ: number,
    facingAngle: number,
  ): CoachSim {
    const rig = createCoachRig(fighterId, corner, this.isSoftwareGl, this.maxAnisotropy);
    rig.root.position.set(posX, posY, posZ);
    rig.root.rotation.y = facingAngle;
    this.scene.add(rig.root);

    const motion = resolveFighterMotionProfile(fighterId, styleLabel);
    return {
      rig,
      anim: {
        time: corner === 'red' ? 0 : 1.2,
        mode: 'apron_support',
        moveSpeed: 0,
        gaitPhase: corner === 'red' ? 0.8 : 0.2,
        stairWeight: 0,
        ropeDuck: 0,
        boxerSideSign: -1,
        celebrationStyle: motion.celebrationStyle,
        celebrationProgress: 0,
        walkoutProgress: 0,
        cadenceScale: motion.cadenceScale,
        handBias: motion.handBias,
      },
      pos: new THREE.Vector3(posX, posY, posZ),
      facingAngle,
      corner,
      startPos: new THREE.Vector3(posX, posY, posZ),
    };
  }

  private setEnvironmentRoom(useWaitingRoom: boolean) {
    this.arena.group.visible = !useWaitingRoom;
    this.waitingRoom.group.visible = useWaitingRoom;
    if (useWaitingRoom) {
      this.keyLight.position.set(2.2, 4.2, 3.4);
      this.overheadSpot.position.set(0.95, 4.0, 0.75);
      this.overheadSpot.target.position.set(0.92, 0.9, 0.45);
    } else {
      this.keyLight.position.set(3.5, 8.2, 4.2);
      this.overheadSpot.position.set(0, 6.4, 0);
      this.overheadSpot.target.position.set(0, 0.8, 0);
    }
  }

  public setupAttractFight(player: FighterProfile, opponent: OpponentProfile) {
    this.mode = 'attract';
    this.setEnvironmentRoom(false);
    this.paused = false;
    this.camera.fov = 38;
    this.camera.updateProjectionMatrix();
    this.clearFighters();
    this.playerSim = this.buildFighterSim(
      true,
      player.name,
      player,
      player.baseStats,
      -0.95,
      0.05,
      Math.PI / 2,
      1,
      1,
      {
        aggression: 0.78,
        guardRate: 0.48,
        dodgeRate: 0.45,
        comboRate: 0.68,
        heavyBias: 0.42,
      },
    );
    this.oppSim = this.buildFighterSim(
      false,
      opponent.name,
      opponent,
      opponent.baseStats,
      0.95,
      -0.05,
      -Math.PI / 2,
      1,
      1,
      {
        aggression: 0.76,
        guardRate: 0.5,
        dodgeRate: 0.42,
        comboRate: 0.64,
        heavyBias: 0.42,
      },
    );
    this.camPos.set(2.2, 1.52, 2.65);
    this.camLook.set(0, 1.1, 0);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  public setOnWaitingFighterChange(cb?: (fighter: FighterProfile) => void) {
    this.onWaitingFighterChange = cb;
  }

  public triggerWaitingRoomConfirmPunch(onComplete: () => void) {
    if (this.mode !== 'waitingroom' || !this.playerSim) {
      onComplete();
      return;
    }
    if (this.waitingConfirmActive) return;

    this.waitingConfirmActive = true;
    this.waitingConfirmTimer = 0;
    this.waitingConfirmCallback = onComplete;
    this.waitingSpecialActive = false;
    this.waitingSpecialTimer = 0;
    this.playerSim.anim.waitingSpecialProgress = 0;
    this.playerSim.anim.waitingConfirmProgress = 0;
    soundEngine.playWhoosh('heavy');
  }

  public setupWaitingRoom(fighter: FighterProfile) {
    const entering = this.mode !== 'waitingroom';
    this.mode = 'waitingroom';
    this.setEnvironmentRoom(true);
    this.paused = false;
    this.camera.fov = 38;
    this.camera.updateProjectionMatrix();
    this.clearFighters();

    this.playerSim = this.buildFighterSim(
      true,
      fighter.name,
      fighter,
      fighter.baseStats,
      0.92,
      0.45,
      -0.26,
    );
    this.playerSim.anim.waitingRoomMode = true;
    this.playerSim.anim.waitingSpecialKind = this.waitingSpecialKind;
    this.playerSim.anim.waitingSpecialProgress = 0;
    this.playerSim.anim.waitingConfirmProgress = 0;

    const rosterIdx = PLAYABLE_FIGHTERS.findIndex((f) => f.id === fighter.id);
    if (rosterIdx >= 0) {
      this.waitingRosterIndex = rosterIdx;
    }

    if (entering) {
      this.waitingIdleClock = 0;
      this.waitingSpecialActive = false;
      this.waitingSpecialTimer = 0;
      this.waitingRotateClock = 0;
      this.waitingConfirmActive = false;
      this.waitingConfirmTimer = 0;
      this.waitingConfirmCallback = null;
      this.camPos.set(-0.26, 1.32, 3.68);
      this.camLook.set(0.06, 1.06, 0.25);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    }
  }

  public setupShowcase(player: FighterProfile, opponent: OpponentProfile) {
    this.mode = 'showcase';
    this.setEnvironmentRoom(false);
    this.paused = false;
    this.camera.fov = 42;
    this.camera.updateProjectionMatrix();
    this.clearFighters();
    this.playerSim = this.buildFighterSim(
      true,
      player.name,
      player,
      player.baseStats,
      -0.95,
      0.1,
      Math.PI / 2,
    );
    this.oppSim = this.buildFighterSim(
      false,
      opponent.name,
      opponent,
      opponent.baseStats,
      0.95,
      -0.1,
      -Math.PI / 2,
    );
    this.prevPerp.set(0, 0, 1);
  }

  public setupFaceOffShowcase(leftFighter: FighterProfile, rightFighter: FighterProfile) {
    this.mode = 'faceoff';
    this.setEnvironmentRoom(false);
    this.paused = false;
    this.camera.fov = 38;
    this.camera.updateProjectionMatrix();
    this.clearFighters();
    this.playerSim = this.buildFighterSim(
      true,
      leftFighter.name,
      leftFighter,
      leftFighter.baseStats,
      -0.96,
      0.15,
      0.24,
    );
    this.oppSim = this.buildFighterSim(
      false,
      rightFighter.name,
      rightFighter,
      rightFighter.baseStats,
      0.96,
      0.15,
      -0.24,
    );
    this.camPos.set(0, 1.46, 3.65);
    this.camLook.set(0, 0.96, 0.15);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  public setupCreatorShowcase(appearance: BoxerAppearance, stance: 'Orthodox' | 'Southpaw') {
    const entering = this.mode !== 'creator';
    this.mode = 'creator';
    this.setEnvironmentRoom(false);
    this.paused = false;
    this.camera.fov = 38;
    this.camera.updateProjectionMatrix();
    this.clearFighters();
    const previewProfile: FighterProfile = {
      id: 'creator_preview',
      name: 'Custom Boxer',
      nickname: '',
      origin: '',
      styleLabel: 'Prospect',
      stance,
      heightDisplay: '6\'1"',
      weightDisplay: '205 lbs',
      reachDisplay: '75"',
      bio: '',
      baseStats: { power: 55, speed: 55, defense: 55, footwork: 55, stamina: 55, chin: 55 },
      appearance,
    };
    this.playerSim = this.buildFighterSim(
      true,
      'Custom Boxer',
      previewProfile,
      previewProfile.baseStats,
      0.95,
      0.18,
      -0.34,
    );
    this.playerSim.anim.waitingRoomMode = true;
    if (entering) {
      const dist = 3.25;
      const halfW =
        dist * Math.tan(THREE.MathUtils.degToRad(38 * 0.5)) * (this.camera.aspect || 1.6);
      const lookX = 0.95 - halfW * 0.44;
      this.camPos.set(lookX - 0.12, 1.18, 0.18 + dist);
      this.camLook.set(lookX, 0.98, 0.18);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    }
  }

  public setGraphicsQuality(quality: GraphicsQuality) {
    this.graphicsQuality = quality;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    if (quality === 'low') {
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = false;
      this.keyLight.castShadow = false;
      this.overheadSpot.visible = false;
      this.arena.crowdMesh.count = Math.min(this.arena.crowdCount, 68);
      this.activeParticleLimit = 22;
      this.renderer.toneMappingExposure = 1.08;
    } else if (quality === 'medium') {
      this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(dpr, 1.35));
      this.renderer.shadowMap.enabled = !this.isSoftwareGl;
      this.keyLight.castShadow = !this.isSoftwareGl;
      this.overheadSpot.visible = true;
      this.arena.crowdMesh.count = Math.min(this.arena.crowdCount, 140);
      this.activeParticleLimit = 38;
      this.renderer.toneMappingExposure = 1.12;
    } else {
      this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(dpr, 2));
      this.renderer.shadowMap.enabled = !this.isSoftwareGl;
      this.keyLight.castShadow = !this.isSoftwareGl;
      this.overheadSpot.visible = true;
      this.arena.crowdMesh.count = this.arena.crowdCount;
      this.activeParticleLimit = this.MAX_PARTICLES;
      this.renderer.toneMappingExposure = 1.15;
    }
    this.renderer.shadowMap.needsUpdate = true;
  }

  public startFight(config: FightConfig) {
    this.mode = 'fight';
    this.setEnvironmentRoom(false);
    this.paused = false;
    this.camera.fov = 42;
    this.camera.updateProjectionMatrix();
    this.clearFighters();

    // Energy / sharpness modifiers from Career camp prep
    const energyPenalty =
      config.playerEnergy < 35 ? 0.85 : config.playerEnergy < 60 ? 0.94 : 1.0;
    const sharpnessBonus = 1 + (config.playerSharpness - 50) * 0.0012;

    this.playerSim = this.buildFighterSim(
      true,
      config.playerName,
      config.playerProfile,
      config.playerStats,
      -0.36,
      -12.5,
      0,
      1.0,
      energyPenalty * sharpnessBonus,
    );
    this.playerSim.pos.set(-0.36, -1.02, -12.5);
    this.playerSim.rig.root.position.copy(this.playerSim.pos);
    this.playerSim.anim.walkoutMode = true;
    this.playerSim.anim.walkoutProgress = 0;

    this.oppSim = this.buildFighterSim(
      false,
      config.opponent.name,
      config.opponent,
      config.opponent.baseStats,
      1.15,
      0,
      -Math.PI / 2,
      1.0,
      1.0,
      config.opponent.aiTendency,
    );

    this.playerCoachSim = this.buildCoachSim(
      config.playerProfile.id,
      'red',
      config.playerProfile.styleLabel,
      0.42,
      -1.02,
      -12.75,
      0,
    );
    this.playerCoachSim.anim.mode = 'walk_with_boxer';
    this.playerCoachSim.anim.boxerSideSign = -1;

    this.oppCoachSim = this.buildCoachSim(
      config.opponent.id,
      'blue',
      config.opponent.styleLabel,
      2.2,
      0,
      3.94,
      Math.PI - 0.45,
    );
    this.oppCoachSim.anim.mode = 'apron_support';

    this.round = 1;
    this.maxRounds = config.rounds;
    this.roundDuration = config.roundSeconds;
    this.roundTimer = config.roundSeconds;
    this.phase = 'walkout';
    this.walkoutClock = 0;
    this.celebrationClock = 0;
    this.phaseTimer = 1.25;
    this.knockdownTarget = null;
    this.knockdownCount = 0;
    this.knockdownLeadInTimer = 0;
    this.replayWriteIdx = 0;
    this.replayFilledCount = 0;
    this.replayOrderedCount = 0;
    this.fightSimClock = 0;
    this.highlightPunch = null;
    this.highlightAttacker = null;
    this.highlightIsCounter = false;
    this.winner = null;
    this.winMethod = null;
    this.calloutText = `${config.playerName.toUpperCase()} WALKOUT`;
    this.calloutTone = 'gold';
    this.calloutTimer = 2.6;
    this.prevPerp.set(0, 0, 1);
    this.hitstopTimer = 0;
    this.shakeIntensity = 0;
    this.crowdExcitement = 0.65;
    this.summary = {
      landed: 0,
      thrown: 0,
      counters: 0,
      blocks: 0,
      dodges: 0,
      oppLanded: 0,
      oppThrown: 0,
    };

    // Anchor walkout tracking camera directly in front of the entrance tunnel
    this.camPos.set(0.35, 0.72, -8.8);
    this.camLook.set(0, 0.15, -12.4);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    this.emitHud();
  }

  public skipWalkout() {
    if (this.mode !== 'fight' || this.phase !== 'walkout' || !this.playerSim || !this.oppSim) return;

    this.playerSim.pos.set(-1.15, 0, 0);
    this.playerSim.facingAngle = Math.PI / 2;
    this.playerSim.rig.root.position.copy(this.playerSim.pos);
    this.playerSim.rig.root.rotation.y = this.playerSim.facingAngle;
    this.playerSim.anim.walkoutMode = false;
    this.playerSim.anim.walkoutProgress = 1;
    this.playerSim.anim.walkoutStairWeight = 0;
    this.playerSim.anim.walkoutRopeDuck = 0;
    this.playerSim.anim.moveSpeed = 0;

    if (this.playerCoachSim) {
      this.playerCoachSim.pos.set(-2.2, 0, -3.94);
      this.playerCoachSim.facingAngle = 0.55;
      this.playerCoachSim.rig.root.position.copy(this.playerCoachSim.pos);
      this.playerCoachSim.rig.root.rotation.y = this.playerCoachSim.facingAngle;
      this.playerCoachSim.anim.mode = 'apron_support';
      this.playerCoachSim.anim.moveSpeed = 0;
      this.playerCoachSim.anim.stairWeight = 0;
      this.playerCoachSim.anim.ropeDuck = 0;
    }

    this.prevPerp.set(0, 0, 1);
    this.camPos.set(-0.35, 2.15, 4.15);
    this.camLook.set(0, 1.12, 0);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    this.phase = 'intro';
    this.phaseTimer = 1.15;
    this.setCallout('ROUND 1', 'gold', 1.15);
    soundEngine.playBell(1);
    this.emitHud();
  }

  public skipCelebration() {
    if (this.mode !== 'fight' || this.phase !== 'celebration') return;
    this.phase = 'finished';
    this.emitHud();
  }

  public skipHighlight() {
    if (this.phase === 'highlight') {
      this.finishHighlightReplay();
    }
  }

  public setPaused(paused: boolean) {
    this.paused = paused;
  }

  public setAnalogInput(x: number, y: number) {
    this.analogX = THREE.MathUtils.clamp(x, -1, 1);
    this.analogY = THREE.MathUtils.clamp(y, -1, 1);
  }

  public setGuarding(active: boolean) {
    this.virtualGuardHeld = active;
  }

  public triggerAttack(type: AttackType) {
    if (this.mode !== 'fight' || this.paused || !this.playerSim) return;
    if (this.phase === 'knockdown' && this.knockdownTarget === 'player') {
      this.playerGetupBoost += 0.25;
      return;
    }
    if (this.phase !== 'fighting') return;

    const p = this.playerSim;
    if (p.hitStunTimer > 0 || p.guardBreakTimer > 0) return;

    if (p.attackType || p.dodgeTimer > 0.14) {
      // Buffer next combo punch
      p.bufferedAttack = type;
      p.bufferTimer = 0.22;
      return;
    }

    this.startAttack(p, type);
  }

  public triggerDodge() {
    if (this.mode !== 'fight' || this.paused || !this.playerSim || !this.oppSim) return;
    if (this.phase === 'knockdown' && this.knockdownTarget === 'player') {
      this.playerGetupBoost += 0.35;
      return;
    }
    if (this.phase !== 'fighting') return;

    const p = this.playerSim;
    if (p.dodgeTimer > 0 || p.dodgeCooldown > 0 || p.hitStunTimer > 0 || p.guardBreakTimer > 0) {
      return;
    }
    if (p.stamina < 8) return;

    // Cancel late attack recovery into dodge for crisp responsiveness
    if (p.attackType && p.attackTimer < p.attackActiveEnd) return;
    p.attackType = null;

    p.stamina = Math.max(0, p.stamina - 10);
    const footFactor = 1 + (p.stats.footwork - 50) * 0.004;
    p.dodgeDuration = 0.4;
    p.dodgeTimer = p.dodgeDuration;
    p.dodgeCooldown = 0.18;
    p.invulnTimer = 0.27 * footFactor;

    // Determine dodge direction relative to screen / analog
    const { ix, iy } = this.getMergedMoveInput();
    if (Math.hypot(ix, iy) > 0.2) {
      p.dodgeDirX = ix;
      p.dodgeDirZ = iy;
    } else {
      // Default lateral head slip / backstep
      p.dodgeDirX = -0.75;
      p.dodgeDirZ = Math.random() > 0.5 ? 0.7 : -0.7;
    }
    const len = Math.hypot(p.dodgeDirX, p.dodgeDirZ) || 1;
    p.dodgeDirX /= len;
    p.dodgeDirZ /= len;

    soundEngine.playWhoosh('dodge');
  }

  private getMergedMoveInput(): { ix: number; iy: number } {
    let kx = 0;
    let ky = 0;
    if (this.keysHeld['KeyA'] || this.keysHeld['ArrowLeft']) kx -= 1;
    if (this.keysHeld['KeyD'] || this.keysHeld['ArrowRight']) kx += 1;
    if (this.keysHeld['KeyW'] || this.keysHeld['ArrowUp']) ky += 1;
    if (this.keysHeld['KeyS'] || this.keysHeld['ArrowDown']) ky -= 1;

    let ix = this.analogX + kx;
    let iy = this.analogY + ky;
    const mag = Math.hypot(ix, iy);
    if (mag > 1) {
      ix /= mag;
      iy /= mag;
    }
    return { ix, iy };
  }

  private startAttack(f: FighterSim, type: AttackType) {
    const cost = type === 'jab' ? 7 : type === 'hook' ? 13 : type === 'heavy' ? 15 : 18;
    if (f.stamina < Math.min(5, cost * 0.5)) return;
    f.stamina = Math.max(0, f.stamina - cost);

    const speedMod = 1 - (f.stats.speed - 50) * 0.0038;
    const clampedMod = THREE.MathUtils.clamp(speedMod, 0.76, 1.18);

    f.attackType = type;
    f.attackTimer = 0;
    f.attackHasHit = false;
    f.isGuarding = false;

    if (type === 'jab') {
      f.attackWindup = 0.095 * clampedMod;
      f.attackActiveEnd = 0.195 * clampedMod;
      f.attackDuration = 0.31 * clampedMod;
      if (this.mode === 'fight') soundEngine.playWhoosh('light');
    } else if (type === 'hook') {
      f.attackWindup = 0.145 * clampedMod;
      f.attackActiveEnd = 0.275 * clampedMod;
      f.attackDuration = 0.45 * clampedMod;
      if (this.mode === 'fight') soundEngine.playWhoosh('heavy');
    } else if (type === 'heavy') {
      f.attackWindup = 0.21 * clampedMod;
      f.attackActiveEnd = 0.33 * clampedMod;
      f.attackDuration = 0.54 * clampedMod;
      if (this.mode === 'fight') soundEngine.playWhoosh('heavy');
    } else {
      f.attackWindup = 0.22 * clampedMod;
      f.attackActiveEnd = 0.35 * clampedMod;
      f.attackDuration = 0.57 * clampedMod;
      if (this.mode === 'fight') soundEngine.playWhoosh('heavy');
    }

    if (this.mode === 'fight') {
      if (f.isPlayer) this.summary.thrown += 1;
      else this.summary.oppThrown += 1;
    }
  }

  private spawnImpactParticles(pos: THREE.Vector3, count: number, colorHex: number, speedScale = 1) {
    let spawned = 0;
    const maxAllowed = Math.min(count, this.activeParticleLimit);
    for (let i = 0; i < this.activeParticleLimit && spawned < maxAllowed; i++) {
      const pt = this.particles[i];
      if (!pt.active) {
        pt.active = true;
        pt.x = pos.x + (Math.random() - 0.5) * 0.12;
        pt.y = pos.y + (Math.random() - 0.5) * 0.12;
        pt.z = pos.z + (Math.random() - 0.5) * 0.12;
        const theta = Math.random() * Math.PI * 2;
        const up = 0.6 + Math.random() * 2.1;
        const spd = (1.6 + Math.random() * 2.4) * speedScale;
        pt.vx = Math.cos(theta) * spd;
        pt.vy = up * speedScale;
        pt.vz = Math.sin(theta) * spd;
        pt.maxLife = 0.28 + Math.random() * 0.24;
        pt.life = pt.maxLife;
        pt.size = 0.75 + Math.random() * 0.7;
        pt.colorHex = colorHex;
        spawned++;
      }
    }
  }

  private setCallout(text: string, tone: 'gold' | 'red' | 'cyan' | 'white', duration = 0.95) {
    this.calloutText = text;
    this.calloutTone = tone;
    this.calloutTimer = duration;
  }

  private resolveHit(attacker: FighterSim, defender: FighterSim, type: AttackType) {
    const dist = attacker.pos.distanceTo(defender.pos);
    const maxRange =
      type === 'jab' ? 1.5 : type === 'hook' ? 1.48 : type === 'heavy' ? 1.58 : 1.44;
    if (dist > maxRange) return;

    // Check facing alignment (hooks catch lateral movement slightly wider)
    _v1.subVectors(defender.pos, attacker.pos).setY(0).normalize();
    const atkForwardX = Math.sin(attacker.facingAngle);
    const atkForwardZ = Math.cos(attacker.facingAngle);
    const dot = _v1.x * atkForwardX + _v1.z * atkForwardZ;
    if (dot < (type === 'hook' ? 0.24 : 0.35)) return;

    // Check Dodge Evasion!
    if (defender.invulnTimer > 0) {
      defender.counterWindowTimer = 0.8;
      if (defender.isPlayer) {
        this.summary.dodges += 1;
        this.setCallout('SLIP! COUNTER READY', 'cyan', 0.85);
      } else {
        this.setCallout('EVADED!', 'white', 0.65);
      }
      return;
    }

    const isCounter = attacker.counterWindowTimer > 0;
    if (isCounter) {
      attacker.counterWindowTimer = 0;
    }

    const powerScale = 0.8 + attacker.stats.power * 0.0085;
    let baseDmg =
      type === 'jab' ? 6.5 : type === 'hook' ? 13.5 : type === 'heavy' ? 15.5 : 19.5;
    baseDmg *= powerScale;
    if (isCounter) baseDmg *= 1.45;

    // Check Guard Mitigation!
    if (defender.isGuarding && defender.guard > 0) {
      const defMitigation = THREE.MathUtils.clamp(0.72 + defender.stats.defense * 0.0016, 0.72, 0.88);
      // Uppercuts pierce guard upward; hooks wrap slightly around high guard
      const guardPierce = type === 'uppercut' ? 0.62 : type === 'hook' ? 0.86 : 1.0;
      const effectiveMitigation = defMitigation * guardPierce;

      const chipDmg = baseDmg * (1 - effectiveMitigation);
      const guardDmg =
        (type === 'jab' ? 9 : type === 'hook' ? 21 : type === 'heavy' ? 24 : 30) * powerScale;

      defender.hp = Math.max(0, defender.hp - chipDmg);
      defender.guard = Math.max(0, defender.guard - guardDmg);
      attacker.roundDamage += chipDmg;

      if (this.mode === 'fight') soundEngine.playBlock();
      defender.anim.guardShock = 1.0;
      triggerHitPhysicsImpulse(defender.anim, 0.32, type === 'hook' ? -0.55 : 0, false);
      this.shakeIntensity = Math.max(this.shakeIntensity, 0.035);
      this.spawnImpactParticles(defender.rig.headWorldPos, 7, 0x7dd3fc, 0.75);

      if (this.mode === 'fight' && defender.isPlayer) this.summary.blocks += 1;

      // Slight pushback
      defender.pos.addScaledVector(_v1, 0.14);

      if (defender.guard <= 0) {
        defender.isGuarding = false;
        defender.guardBreakTimer = 0.85;
        defender.hitStunTimer = 0.55;
        triggerHitPhysicsImpulse(defender.anim, 1.15, 0.4, false);
        this.hitstopTimer = 0.055;
        if (this.mode === 'fight') this.setCallout('GUARD BROKEN!', 'gold', 1.05);
      }
      return;
    }

    // Clean Hit!
    defender.hp =
      this.mode === 'attract'
        ? Math.max(defender.maxHp * 0.4, defender.hp - baseDmg)
        : Math.max(0, defender.hp - baseDmg);
    attacker.roundDamage += baseDmg;
    attacker.comboCount += 1;
    attacker.comboResetTimer = 1.65;

    if (this.mode === 'fight') {
      if (attacker.isPlayer) {
        this.summary.landed += 1;
        if (isCounter) this.summary.counters += 1;
      } else {
        this.summary.oppLanded += 1;
      }
    }

    // Cancel defender's attack windup on clean hit!
    if (defender.attackType && defender.attackTimer < defender.attackWindup) {
      defender.attackType = null;
    }

    defender.hitStunTimer =
      type === 'jab' ? 0.16 : type === 'hook' ? 0.27 : type === 'heavy' ? 0.3 : 0.36;
    defender.anim.hitFlash = 1.0;
    defender.pos.addScaledVector(_v1, type === 'jab' ? 0.12 : 0.26);
    defender.vel.addScaledVector(_v1, type === 'jab' ? 1.4 : type === 'uppercut' ? 3.2 : 2.7);

    const sideSign = type === 'jab' ? -0.65 : type === 'hook' ? -1.45 : 1.0;
    const impulseStrength =
      (type === 'jab' ? 0.65 : type === 'hook' ? 1.28 : type === 'heavy' ? 1.25 : 1.45) *
      (isCounter ? 1.25 : 1.0);
    triggerHitPhysicsImpulse(
      defender.anim,
      impulseStrength,
      sideSign * (defender.stance === 'Southpaw' ? -1 : 1),
      type === 'uppercut',
    );

    if (this.mode === 'fight') soundEngine.playHit(type, isCounter);

    // Hitstop + Camera Shake + Crowd Excitement + Particles
    if (type === 'jab' && !isCounter) {
      this.hitstopTimer = 0.024;
      this.shakeIntensity = Math.max(this.shakeIntensity, 0.045);
      this.spawnImpactParticles(defender.rig.headWorldPos, 8, 0xfef08a, 0.85);
      this.crowdExcitement = Math.min(1, this.crowdExcitement + 0.12);
    } else if (type === 'hook' && !isCounter) {
      this.hitstopTimer = 0.048;
      this.shakeIntensity = Math.max(this.shakeIntensity, 0.095);
      this.spawnImpactParticles(defender.rig.headWorldPos, 13, 0x34d399, 1.15);
      this.crowdExcitement = Math.min(1, this.crowdExcitement + 0.3);
      if (this.mode === 'fight' && attacker.isPlayer && attacker.comboCount >= 2) {
        this.setCallout(
          attacker.comboCount >= 3 ? `${attacker.comboCount} HIT COMBO!` : 'CHECK HOOK!',
          'gold',
          0.9,
        );
      }
    } else if (type === 'heavy' || isCounter) {
      this.hitstopTimer = 0.055;
      this.shakeIntensity = Math.max(this.shakeIntensity, 0.11);
      this.spawnImpactParticles(defender.rig.headWorldPos, 15, isCounter ? 0x38bdf8 : 0xfbbf24, 1.2);
      this.crowdExcitement = Math.min(1, this.crowdExcitement + 0.35);
      if (this.mode === 'fight') {
        if (isCounter) {
          this.setCallout(attacker.isPlayer ? 'COUNTER STRIKE!' : 'COUNTERED!', attacker.isPlayer ? 'cyan' : 'red', 0.95);
        } else if (attacker.isPlayer && attacker.comboCount >= 3) {
          this.setCallout(`${attacker.comboCount} HIT COMBO!`, 'gold', 0.9);
        }
      }
    } else if (type === 'uppercut') {
      this.hitstopTimer = 0.072;
      this.shakeIntensity = Math.max(this.shakeIntensity, 0.145);
      this.spawnImpactParticles(defender.rig.headWorldPos, 18, 0xf97316, 1.35);
      this.crowdExcitement = Math.min(1, this.crowdExcitement + 0.45);
      if (this.mode === 'fight' && attacker.isPlayer) {
        this.setCallout('CRUSHING UPPERCUT!', 'gold', 0.95);
      }
    }

    // Check Knockdown!
    if (this.mode === 'fight' && defender.hp <= 0) {
      this.triggerKnockdown(attacker, defender, type, isCounter);
    }
  }

  private captureFighterPose(sim: FighterSim, out: ReplayFighterPose) {
    const r = sim.rig;
    out.posX = sim.pos.x;
    out.posZ = sim.pos.z;
    out.facingAngle = sim.facingAngle;
    out.pelvisX = r.pelvis.position.x;
    out.pelvisY = r.pelvis.position.y;
    out.pelvisZ = r.pelvis.position.z;
    out.pelvisRotX = r.pelvis.rotation.x;
    out.pelvisRotY = r.pelvis.rotation.y;
    out.pelvisRotZ = r.pelvis.rotation.z;
    out.torsoRotX = r.torso.rotation.x;
    out.torsoRotY = r.torso.rotation.y;
    out.torsoRotZ = r.torso.rotation.z;
    out.headRotX = r.head.rotation.x;
    out.headRotY = r.head.rotation.y;
    out.headRotZ = r.head.rotation.z;
    out.lShX = r.leftShoulder.rotation.x;
    out.lShY = r.leftShoulder.rotation.y;
    out.lShZ = r.leftShoulder.rotation.z;
    out.lElX = r.leftElbow.rotation.x;
    out.lElY = r.leftElbow.rotation.y;
    out.lElZ = r.leftElbow.rotation.z;
    out.lRoll = r.leftForearmRoll.rotation.y;
    out.rShX = r.rightShoulder.rotation.x;
    out.rShY = r.rightShoulder.rotation.y;
    out.rShZ = r.rightShoulder.rotation.z;
    out.rElX = r.rightElbow.rotation.x;
    out.rElY = r.rightElbow.rotation.y;
    out.rElZ = r.rightElbow.rotation.z;
    out.rRoll = r.rightForearmRoll.rotation.y;
    out.lHipX = r.leftHip.rotation.x;
    out.lHipZ = r.leftHip.rotation.z;
    out.lKneeX = r.leftKnee.rotation.x;
    out.lAnkX = r.leftAnkle.rotation.x;
    out.lAnkZ = r.leftAnkle.rotation.z;
    out.rHipX = r.rightHip.rotation.x;
    out.rHipZ = r.rightHip.rotation.z;
    out.rKneeX = r.rightKnee.rotation.x;
    out.rAnkX = r.rightAnkle.rotation.x;
    out.rAnkZ = r.rightAnkle.rotation.z;
    out.hairX = sim.anim.hairSpringX;
    out.hairZ = sim.anim.hairSpringZ;
    out.hitFlash = sim.anim.hitFlash;
    out.shadowScale = r.shadowMesh.scale.x;
  }

  private applyInterpolatedPose(
    sim: FighterSim,
    a: ReplayFighterPose,
    b: ReplayFighterPose,
    alpha: number,
  ) {
    const r = sim.rig;
    const x = THREE.MathUtils.lerp(a.posX, b.posX, alpha);
    const z = THREE.MathUtils.lerp(a.posZ, b.posZ, alpha);
    let diff = b.facingAngle - a.facingAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const yaw = a.facingAngle + diff * alpha;

    r.root.position.set(x, 0, z);
    r.root.rotation.y = yaw;

    r.pelvis.position.set(
      THREE.MathUtils.lerp(a.pelvisX, b.pelvisX, alpha),
      THREE.MathUtils.lerp(a.pelvisY, b.pelvisY, alpha),
      THREE.MathUtils.lerp(a.pelvisZ, b.pelvisZ, alpha),
    );
    r.pelvis.rotation.set(
      THREE.MathUtils.lerp(a.pelvisRotX, b.pelvisRotX, alpha),
      THREE.MathUtils.lerp(a.pelvisRotY, b.pelvisRotY, alpha),
      THREE.MathUtils.lerp(a.pelvisRotZ, b.pelvisRotZ, alpha),
    );
    r.torso.rotation.set(
      THREE.MathUtils.lerp(a.torsoRotX, b.torsoRotX, alpha),
      THREE.MathUtils.lerp(a.torsoRotY, b.torsoRotY, alpha),
      THREE.MathUtils.lerp(a.torsoRotZ, b.torsoRotZ, alpha),
    );
    r.head.rotation.set(
      THREE.MathUtils.lerp(a.headRotX, b.headRotX, alpha),
      THREE.MathUtils.lerp(a.headRotY, b.headRotY, alpha),
      THREE.MathUtils.lerp(a.headRotZ, b.headRotZ, alpha),
    );
    r.leftShoulder.rotation.set(
      THREE.MathUtils.lerp(a.lShX, b.lShX, alpha),
      THREE.MathUtils.lerp(a.lShY, b.lShY, alpha),
      THREE.MathUtils.lerp(a.lShZ, b.lShZ, alpha),
    );
    r.leftElbow.rotation.set(
      THREE.MathUtils.lerp(a.lElX, b.lElX, alpha),
      THREE.MathUtils.lerp(a.lElY, b.lElY, alpha),
      THREE.MathUtils.lerp(a.lElZ, b.lElZ, alpha),
    );
    r.leftForearmRoll.rotation.y = THREE.MathUtils.lerp(a.lRoll, b.lRoll, alpha);

    r.rightShoulder.rotation.set(
      THREE.MathUtils.lerp(a.rShX, b.rShX, alpha),
      THREE.MathUtils.lerp(a.rShY, b.rShY, alpha),
      THREE.MathUtils.lerp(a.rShZ, b.rShZ, alpha),
    );
    r.rightElbow.rotation.set(
      THREE.MathUtils.lerp(a.rElX, b.rElX, alpha),
      THREE.MathUtils.lerp(a.rElY, b.rElY, alpha),
      THREE.MathUtils.lerp(a.rElZ, b.rElZ, alpha),
    );
    r.rightForearmRoll.rotation.y = THREE.MathUtils.lerp(a.rRoll, b.rRoll, alpha);

    const hx = THREE.MathUtils.lerp(a.hairX, b.hairX, alpha);
    const hz = THREE.MathUtils.lerp(a.hairZ, b.hairZ, alpha);
    r.hairPivot.rotation.x = hx * 0.35;
    r.hairPivot.rotation.z = hz * 0.35;
    for (let i = 0; i < r.hairStrands.length; i++) {
      const s = r.hairStrands[i];
      s.pivot.rotation.x = s.baseRotX + hx * s.flexScale;
      s.pivot.rotation.z = s.baseRotZ + hz * s.flexScale;
    }

    r.leftHip.rotation.set(
      THREE.MathUtils.lerp(a.lHipX, b.lHipX, alpha),
      0,
      THREE.MathUtils.lerp(a.lHipZ, b.lHipZ, alpha),
    );
    r.leftKnee.rotation.set(THREE.MathUtils.lerp(a.lKneeX, b.lKneeX, alpha), 0, 0);
    r.leftAnkle.rotation.set(
      THREE.MathUtils.lerp(a.lAnkX, b.lAnkX, alpha),
      0,
      THREE.MathUtils.lerp(a.lAnkZ, b.lAnkZ, alpha),
    );
    r.rightHip.rotation.set(
      THREE.MathUtils.lerp(a.rHipX, b.rHipX, alpha),
      0,
      THREE.MathUtils.lerp(a.rHipZ, b.rHipZ, alpha),
    );
    r.rightKnee.rotation.set(THREE.MathUtils.lerp(a.rKneeX, b.rKneeX, alpha), 0, 0);
    r.rightAnkle.rotation.set(
      THREE.MathUtils.lerp(a.rAnkX, b.rAnkX, alpha),
      0,
      THREE.MathUtils.lerp(a.rAnkZ, b.rAnkZ, alpha),
    );

    const flash = THREE.MathUtils.lerp(a.hitFlash, b.hitFlash, alpha);
    r.skinMat.emissive.setRGB(flash * 0.55, flash * 0.08, flash * 0.06);
    r.torsoMat.emissive.setRGB(flash * 0.55, flash * 0.08, flash * 0.06);
    r.headMat.emissive.setRGB(flash * 0.55, flash * 0.08, flash * 0.06);

    r.shadowMesh.scale.setScalar(THREE.MathUtils.lerp(a.shadowScale, b.shadowScale, alpha));
    r.root.updateMatrixWorld(true);
    r.head.getWorldPosition(r.headWorldPos);
    r.headWorldPos.y += 0.08;
  }

  private recordReplayFrame() {
    if (!this.playerSim || !this.oppSim) return;
    const slot = this.replayBuffer[this.replayWriteIdx];
    slot.t = this.fightSimClock;
    this.captureFighterPose(this.playerSim, slot.player);
    this.captureFighterPose(this.oppSim, slot.opp);
    this.replayWriteIdx = (this.replayWriteIdx + 1) % this.MAX_REPLAY_FRAMES;
    if (this.replayFilledCount < this.MAX_REPLAY_FRAMES) {
      this.replayFilledCount += 1;
    }
  }

  private triggerKnockdown(
    attacker: FighterSim,
    defender: FighterSim,
    punchType: AttackType,
    isCounter: boolean,
  ) {
    defender.knockdowns += 1;
    defender.attackType = null;
    defender.isGuarding = false;
    defender.dodgeTimer = 0;
    triggerKnockdownRagdoll(
      defender.anim,
      (Math.random() - 0.5) * 0.45,
      -0.85,
      1.0 + Math.min(0.4, defender.knockdowns * 0.12),
    );

    this.knockdownTarget = defender.isPlayer ? 'player' : 'opponent';
    this.knockdownCount = 0;
    this.knockdownTickTimer = 0.65;
    this.playerGetupBoost = 0;

    // 3rd knockdown in a bout = automatic TKO!
    const chinFactor = defender.stats.chin / 100;
    if (defender.knockdowns >= 3) {
      this.knockdownRecoveryCount = 99; // Will KO at 10
    } else if (defender.knockdowns === 2) {
      this.knockdownRecoveryCount = Math.random() < 0.45 + chinFactor * 0.38 ? 8 : 99;
    } else {
      this.knockdownRecoveryCount = Math.random() < 0.72 + chinFactor * 0.25 ? 6 : 8;
    }

    // Store highlight metadata & let initial ragdoll fall record for 0.55s before cutting to slow-mo replay
    this.highlightPunch = punchType;
    this.highlightAttacker = attacker.isPlayer ? 'player' : 'opponent';
    this.highlightIsCounter = isCounter;
    this.highlightImpactTime = this.fightSimClock;
    this.knockdownLeadInTimer = 0.55;

    _v1.subVectors(defender.pos, attacker.pos).setY(0);
    if (_v1.lengthSq() > 0.0001) {
      _v1.normalize();
      this.highlightAxisX = _v1.x;
      this.highlightAxisZ = _v1.z;
    } else {
      this.highlightAxisX = Math.sin(attacker.facingAngle);
      this.highlightAxisZ = Math.cos(attacker.facingAngle);
    }

    // Record the exact impact frame immediately
    this.recordReplayFrame();

    this.hitstopTimer = 0.085;
    this.shakeIntensity = 0.22;
    this.crowdExcitement = 1.0;
    soundEngine.playKnockdown();
    this.setCallout('DOWN GOES THE FIGHTER!', 'red', 1.4);
  }

  private beginHighlightReplay() {
    if (!this.playerSim || !this.oppSim || this.replayFilledCount < 2) {
      this.phase = 'knockdown';
      return;
    }

    // Save exact post-fall pose so we can resume seamlessly into the 10-count after highlight
    this.captureFighterPose(this.playerSim, this.savedPostFallPlayer);
    this.captureFighterPose(this.oppSim, this.savedPostFallOpp);

    // Populate chronological frame view (zero allocations)
    const startRingIdx =
      this.replayFilledCount < this.MAX_REPLAY_FRAMES ? 0 : this.replayWriteIdx;
    this.replayOrderedCount = this.replayFilledCount;
    for (let i = 0; i < this.replayOrderedCount; i++) {
      const idx = (startRingIdx + i) % this.MAX_REPLAY_FRAMES;
      this.replayOrdered[i] = this.replayBuffer[idx];
    }

    const earliestT = this.replayOrdered[0].t;
    const latestT = this.replayOrdered[this.replayOrderedCount - 1].t;
    this.highlightStartTime = Math.max(earliestT, this.highlightImpactTime - 0.62);
    this.highlightEndTime = latestT;
    this.highlightCursor = this.highlightStartTime;
    this.highlightImpactFxFired = false;

    // Choose dramatic side facing the broadcast hemisphere so punch & face are visible
    _perp.set(-this.highlightAxisZ, 0, this.highlightAxisX);
    this.highlightOrbitSide = _perp.dot(this.prevPerp) >= 0 ? 1 : -1;

    this.phase = 'highlight';
    this.calloutText = null;
    this.calloutTimer = 0;

    // Tight cinema telephoto lens + immediate cut to low-angle highlight start
    this.camera.fov = 33;
    this.camera.updateProjectionMatrix();
    this.sampleAndApplyHighlightCamera(0, true);
    this.emitHud();
  }

  private finishHighlightReplay() {
    if (this.phase !== 'highlight' || !this.playerSim || !this.oppSim) return;

    this.applyInterpolatedPose(
      this.playerSim,
      this.savedPostFallPlayer,
      this.savedPostFallPlayer,
      1,
    );
    this.applyInterpolatedPose(
      this.oppSim,
      this.savedPostFallOpp,
      this.savedPostFallOpp,
      1,
    );

    this.camera.fov = 42;
    this.camera.updateProjectionMatrix();

    // Re-anchor broadcast camera smoothly outside the fighters
    _mid.addVectors(this.playerSim.pos, this.oppSim.pos).multiplyScalar(0.5);
    this.camPos
      .copy(_mid)
      .addScaledVector(this.prevPerp, 4.1);
    this.camPos.y = 2.22;
    this.camLook.set(_mid.x, 1.0, _mid.z);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    this.phase = 'knockdown';
    this.knockdownCount = 0;
    this.knockdownTickTimer = 0.55;
    this.playerGetupBoost = 0;
    this.highlightPunch = null;
    this.highlightAttacker = null;
    this.emitHud();
  }

  private sampleAndApplyHighlightCamera(progress: number, snap = false) {
    if (!this.playerSim || !this.oppSim) return;
    const defender = this.knockdownTarget === 'player' ? this.playerSim : this.oppSim;
    const attacker = this.knockdownTarget === 'player' ? this.oppSim : this.playerSim;

    // Focus slightly toward the knocked-down fighter's head/chest impact zone
    _lookGoal.set(
      THREE.MathUtils.lerp(attacker.rig.root.position.x, defender.rig.root.position.x, 0.65),
      THREE.MathUtils.lerp(1.26, 0.72, Math.max(0, (progress - 0.55) / 0.45)),
      THREE.MathUtils.lerp(attacker.rig.root.position.z, defender.rig.root.position.z, 0.65),
    );

    // Sweep azimuth from front-side of impact (-0.38 rad) across to dramatic follow-through (+0.58 rad)
    const baseAngle = Math.atan2(
      -this.highlightAxisZ * this.highlightOrbitSide,
      this.highlightAxisX * this.highlightOrbitSide,
    );
    const sweepAngle = baseAngle + THREE.MathUtils.lerp(-0.38, 0.62, progress) * this.highlightOrbitSide;
    const dist = THREE.MathUtils.lerp(1.95, 2.55, progress);
    const camY = THREE.MathUtils.lerp(1.02, 1.56, progress);

    _camGoal.set(
      _lookGoal.x + Math.cos(sweepAngle) * dist,
      Math.max(0.5, camY),
      _lookGoal.z + Math.sin(sweepAngle) * dist,
    );

    if (snap) {
      this.camPos.copy(_camGoal);
      this.camLook.copy(_lookGoal);
    } else {
      this.camPos.lerp(_camGoal, 0.25);
      this.camLook.lerp(_lookGoal, 0.3);
    }

    this.camera.position.copy(this.camPos);
    if (this.shakeIntensity > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeIntensity;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeIntensity * 0.7;
    }
    this.camera.lookAt(this.camLook);
  }

  private updateFighterCombat(f: FighterSim, other: FighterSim, dt: number) {
    f.anim.time += dt;
    f.anim.hitFlash = Math.max(0, f.anim.hitFlash - dt * 6.5);
    f.hitStunTimer = Math.max(0, f.hitStunTimer - dt);
    f.guardBreakTimer = Math.max(0, f.guardBreakTimer - dt);
    f.dodgeCooldown = Math.max(0, f.dodgeCooldown - dt);
    f.invulnTimer = Math.max(0, f.invulnTimer - dt);
    f.counterWindowTimer = Math.max(0, f.counterWindowTimer - dt);

    if (f.comboResetTimer > 0) {
      f.comboResetTimer -= dt;
      if (f.comboResetTimer <= 0) f.comboCount = 0;
    }

    // Stamina & Guard regeneration
    const stamRegenBase = 11 + f.stats.stamina * 0.14;
    if (!f.attackType && f.dodgeTimer <= 0) {
      const guardMult = f.isGuarding ? 0.38 : 1.0;
      f.stamina = Math.min(f.maxStamina, f.stamina + stamRegenBase * guardMult * dt);
    }
    if (!f.isGuarding && f.guardBreakTimer <= 0) {
      f.guard = Math.min(f.maxGuard, f.guard + (14 + f.stats.defense * 0.14) * dt);
    }

    // Face opponent smoothly
    _v1.subVectors(other.pos, f.pos);
    const targetYaw = Math.atan2(_v1.x, _v1.z);
    let diff = targetYaw - f.facingAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    f.facingAngle += diff * Math.min(1, dt * 12);

    // Handle active Dodge
    if (f.dodgeTimer > 0) {
      f.dodgeTimer = Math.max(0, f.dodgeTimer - dt);
      const dodgeSpeed = 4.6 + f.stats.footwork * 0.025;
      this.applyScreenRelativeMove(f, f.dodgeDirX, f.dodgeDirZ, dodgeSpeed, dt, 24);
    } else if (f.attackType) {
      // Handle active Attack
      f.attackTimer += dt;
      const p = f.attackTimer / f.attackDuration;
      f.vel.x = THREE.MathUtils.damp(f.vel.x, 0, 14, dt);
      f.vel.z = THREE.MathUtils.damp(f.vel.z, 0, 14, dt);

      // Subtle forward step into punch during windup/strike
      if (f.attackTimer < f.attackActiveEnd) {
        const lunge = f.attackType === 'jab' ? 1.15 : 1.55;
        f.pos.x += Math.sin(f.facingAngle) * lunge * dt;
        f.pos.z += Math.cos(f.facingAngle) * lunge * dt;
      }

      if (!f.attackHasHit && f.attackTimer >= f.attackWindup && f.attackTimer <= f.attackActiveEnd) {
        f.attackHasHit = true;
        this.resolveHit(f, other, f.attackType);
      }

      if (p >= 1) {
        f.attackType = null;
        f.attackTimer = 0;
        if (f.bufferedAttack && f.bufferTimer > 0) {
          const next = f.bufferedAttack;
          f.bufferedAttack = null;
          this.startAttack(f, next);
        }
      }
    } else if (f.hitStunTimer <= 0 && f.guardBreakTimer <= 0) {
      // Normal Movement & Guard
      if (f.isPlayer && this.mode === 'fight') {
        const guardKey = this.keysHeld['KeyH'] || this.keysHeld['KeyC'];
        f.isGuarding = this.virtualGuardHeld || Boolean(guardKey);

        const { ix, iy } = this.getMergedMoveInput();
        const baseMoveSpeed = (2.35 + f.stats.footwork * 0.016) * (f.isGuarding ? 0.56 : 1.0);
        this.applyScreenRelativeMove(f, ix, iy, baseMoveSpeed, dt, 14);
      } else {
        this.updateAi(f, other, dt);
      }
    } else {
      f.isGuarding = false;
      f.vel.x = THREE.MathUtils.damp(f.vel.x, 0, 12, dt);
      f.vel.z = THREE.MathUtils.damp(f.vel.z, 0, 12, dt);
    }

    if (f.bufferTimer > 0) {
      f.bufferTimer = Math.max(0, f.bufferTimer - dt);
      if (f.bufferTimer === 0) f.bufferedAttack = null;
    }

    // Elastic rubber ring-rope spring resistance & canvas boundary clamp
    this.applyRingRopeElasticity(f, dt);

    // Sync anim state
    f.anim.isGuarding = f.isGuarding;
    f.anim.dodgeTimer = f.dodgeTimer;
    f.anim.dodgeDuration = f.dodgeDuration;
    f.anim.dodgeDirX = f.dodgeDirX;
    f.anim.dodgeDirZ = f.dodgeDirZ;
    f.anim.attackType = f.attackType;
    f.anim.attackProgress = f.attackType ? f.attackTimer / f.attackDuration : 0;
    f.anim.hitStunTimer = f.hitStunTimer;
    f.anim.moveSpeed = f.vel.length();

    // Forward/strafe projection for lean & directional footwork animation
    const fx = Math.sin(f.facingAngle);
    const fz = Math.cos(f.facingAngle);
    f.anim.moveForward = THREE.MathUtils.clamp((f.vel.x * fx + f.vel.z * fz) / 2.4, -1, 1);
    f.anim.moveStrafe = THREE.MathUtils.clamp((f.vel.x * fz - f.vel.z * fx) / 2.4, -1, 1);

    f.rig.root.position.copy(f.pos);
    f.rig.root.rotation.y = f.facingAngle;
    updateBoxerPose(f.rig, f.anim, dt);
  }

  private applyRingRopeElasticity(f: FighterSim, dt: number) {
    // When fighter enters the rope contact zone (> ROPE_CONTACT_THRESHOLD), apply springy rebound
    const ropeK = 36;
    if (Math.abs(f.pos.x) > ROPE_CONTACT_THRESHOLD) {
      const sign = Math.sign(f.pos.x);
      const pen = Math.abs(f.pos.x) - ROPE_CONTACT_THRESHOLD;
      f.vel.x -= sign * pen * ropeK * dt;
      // Gentle rubber rebound when hitting ropes with outward momentum
      if (f.vel.x * sign > 0.35 && f.pos.x * sign > ROPE_CONTACT_THRESHOLD + 0.14) {
        f.vel.x *= -0.45;
      }
    }
    if (Math.abs(f.pos.z) > ROPE_CONTACT_THRESHOLD) {
      const sign = Math.sign(f.pos.z);
      const pen = Math.abs(f.pos.z) - ROPE_CONTACT_THRESHOLD;
      f.vel.z -= sign * pen * ropeK * dt;
      if (f.vel.z * sign > 0.35 && f.pos.z * sign > ROPE_CONTACT_THRESHOLD + 0.14) {
        f.vel.z *= -0.45;
      }
    }
    f.pos.x = THREE.MathUtils.clamp(f.pos.x, -PLAYABLE_HALF_BOUND, PLAYABLE_HALF_BOUND);
    f.pos.z = THREE.MathUtils.clamp(f.pos.z, -PLAYABLE_HALF_BOUND, PLAYABLE_HALF_BOUND);
  }

  private updateArenaRopes(dt: number) {
    if (!this.arena.group.visible) return;
    let count = 0;
    this.activeRopeContacts.length = 0;
    const fillContact = (sim: FighterSim | null) => {
      if (!sim || count >= this.ropeContactPool.length) return;
      const rx = sim.rig.root.position.x;
      const ry = sim.rig.root.position.y;
      const rz = sim.rig.root.position.z;
      // Only engage ring rope physics when actually near or inside the ring perimeter at canvas height
      if (Math.abs(rx) > 4.05 || Math.abs(rz) > 4.05 || ry < -0.25) return;

      const c = this.ropeContactPool[count++];
      const isDown = sim.anim.knockdownProgress > 0.25 || sim.anim.ragdoll.active;
      c.x = rx;
      c.z = rz;
      c.minY = isDown ? 0.16 : 0.28;
      c.maxY = isDown ? 0.96 : 1.68;
      c.radius = isDown ? 0.48 : 0.42;
      c.vx = sim.vel.x;
      c.vz = sim.vel.z;
      this.activeRopeContacts.push(c);
    };
    fillContact(this.playerSim);
    fillContact(this.oppSim);
    this.arena.updateRopes(dt, this.activeRopeContacts);
  }

  private applyScreenRelativeMove(
    f: FighterSim,
    screenX: number,
    screenY: number,
    speed: number,
    dt: number,
    accelRate = 14,
  ) {
    // Camera forward projected onto XZ plane
    _v2.subVectors(this.camLook, this.camPos).setY(0).normalize();
    // Screen right vector: forward x up
    _moveDir.set(-_v2.z, 0, _v2.x);

    const targetVx = (_moveDir.x * screenX + _v2.x * screenY) * speed;
    const targetVz = (_moveDir.z * screenX + _v2.z * screenY) * speed;
    f.vel.x = THREE.MathUtils.damp(f.vel.x, targetVx, accelRate, dt);
    f.vel.z = THREE.MathUtils.damp(f.vel.z, targetVz, accelRate, dt);
    f.pos.x += f.vel.x * dt;
    f.pos.z += f.vel.z * dt;
  }

  private updateAi(ai: FighterSim, player: FighterSim, dt: number) {
    const t = ai.aiTendency ?? {
      aggression: 0.6,
      guardRate: 0.45,
      dodgeRate: 0.25,
      comboRate: 0.45,
      heavyBias: 0.35,
    };

    const dist = ai.pos.distanceTo(player.pos);

    if (ai.aiGuardHoldTimer > 0) {
      ai.aiGuardHoldTimer -= dt;
      ai.isGuarding = ai.guard > 15;
    } else {
      ai.isGuarding = false;
    }

    // React if player winds up an attack in range
    if (player.attackType && player.attackTimer < player.attackWindup * 0.9 && dist < 1.8 && ai.aiThinkTimer < 0.14) {
      const roll = Math.random();
      if (roll < t.dodgeRate * 0.55 && ai.dodgeCooldown <= 0 && ai.stamina >= 14) {
        ai.dodgeDuration = 0.4;
        ai.dodgeTimer = ai.dodgeDuration;
        ai.dodgeCooldown = 0.65;
        ai.invulnTimer = 0.25;
        ai.dodgeDirX = Math.random() > 0.5 ? 0.8 : -0.8;
        ai.dodgeDirZ = -0.5;
        ai.stamina -= 10;
        if (this.mode === 'fight') soundEngine.playWhoosh('dodge');
        return;
      } else if (roll < t.dodgeRate * 0.55 + t.guardRate && ai.guard > 18) {
        ai.aiGuardHoldTimer = 0.38;
        ai.isGuarding = true;
      }
    }

    ai.aiThinkTimer -= dt;
    if (ai.aiThinkTimer <= 0) {
      ai.aiThinkTimer = 0.24 + Math.random() * 0.22;

      // Continue queued combo if in range
      if (ai.aiComboQueue.length > 0 && dist < 1.56 && ai.stamina > 12) {
        const nextAtk = ai.aiComboQueue.shift()!;
        this.startAttack(ai, nextAtk);
        return;
      }

      // Movement decision with committed lateral circling (prevents jerky left-right jitter)
      const idealDist = ai.stamina < 24 ? 2.2 : 1.36;
      const keepSide = Math.abs(ai.aiMoveX) > 0.2 && Math.random() < 0.72;
      const circleSign = keepSide
        ? Math.sign(ai.aiMoveX)
        : Math.random() > 0.5
          ? 1
          : -1;

      if (dist > idealDist + 0.25) {
        ai.aiMoveZ = 1; // Advance toward player
        ai.aiMoveX = circleSign * 0.28;
      } else if (dist < idealDist - 0.25) {
        ai.aiMoveZ = -0.85; // Back up slightly
        ai.aiMoveX = circleSign * 0.6;
      } else {
        // Circle smoothly in pocket
        ai.aiMoveZ = ai.stamina < 28 ? -0.4 : 0.15;
        ai.aiMoveX = circleSign * 0.62;
      }

      // Attack decision when in range
      if (dist <= 1.54 && ai.stamina >= 18 && !ai.isGuarding) {
        if (Math.random() < t.aggression) {
          const r = Math.random();
          const first: AttackType =
            r < t.heavyBias * 0.48
              ? 'heavy'
              : r < t.heavyBias * 0.48 + 0.24
                ? 'hook'
                : r < t.heavyBias * 0.48 + 0.4
                  ? 'uppercut'
                  : 'jab';

          if (Math.random() < t.comboRate) {
            const rf = Math.random();
            const follow: AttackType =
              rf < t.heavyBias * 0.65
                ? 'heavy'
                : rf < 0.55
                  ? 'hook'
                  : rf < 0.8
                    ? 'uppercut'
                    : 'jab';
            ai.aiComboQueue.push(follow);
          }
          this.startAttack(ai, first);
          return;
        } else if (Math.random() < t.guardRate * 0.5 && ai.guard > 20) {
          ai.aiGuardHoldTimer = 0.45;
          ai.isGuarding = true;
        }
      }
    }

    // Move smoothly relative to player-ai vector (aiMoveZ = forward toward player, aiMoveX = circle)
    _v1.subVectors(player.pos, ai.pos).setY(0).normalize();
    _v2.set(-_v1.z, 0, _v1.x);
    const speed = (2.05 + ai.stats.footwork * 0.015) * (ai.isGuarding ? 0.5 : 1.0);
    const targetVx = (_v1.x * ai.aiMoveZ + _v2.x * ai.aiMoveX) * speed;
    const targetVz = (_v1.z * ai.aiMoveZ + _v2.z * ai.aiMoveX) * speed;
    ai.vel.x = THREE.MathUtils.damp(ai.vel.x, targetVx, 11, dt);
    ai.vel.z = THREE.MathUtils.damp(ai.vel.z, targetVz, 11, dt);
    ai.pos.x += ai.vel.x * dt;
    ai.pos.z += ai.vel.z * dt;
  }

  private resolveFighterSeparation() {
    if (!this.playerSim || !this.oppSim) return;
    _v1.subVectors(this.oppSim.pos, this.playerSim.pos).setY(0);
    const dist = _v1.length();
    const minDist = 0.86;
    if (dist < minDist) {
      if (dist < 0.001) _v1.set(1, 0, 0);
      else _v1.divideScalar(dist);
      const overlap = (minDist - dist) * 0.5;
      this.playerSim.pos.addScaledVector(_v1, -overlap);
      this.oppSim.pos.addScaledVector(_v1, overlap);
      this.playerSim.pos.x = THREE.MathUtils.clamp(this.playerSim.pos.x, -PLAYABLE_HALF_BOUND, PLAYABLE_HALF_BOUND);
      this.playerSim.pos.z = THREE.MathUtils.clamp(this.playerSim.pos.z, -PLAYABLE_HALF_BOUND, PLAYABLE_HALF_BOUND);
      this.oppSim.pos.x = THREE.MathUtils.clamp(this.oppSim.pos.x, -PLAYABLE_HALF_BOUND, PLAYABLE_HALF_BOUND);
      this.oppSim.pos.z = THREE.MathUtils.clamp(this.oppSim.pos.z, -PLAYABLE_HALF_BOUND, PLAYABLE_HALF_BOUND);
    }
  }

  private updateCameraUfc5(dt: number) {
    if (this.mode === 'fight' && this.phase === 'highlight') {
      return;
    }
    if (this.mode === 'attract' && this.playerSim && this.oppSim) {
      _mid.addVectors(this.playerSim.pos, this.oppSim.pos).multiplyScalar(0.5);
      const orbitAngle = 0.55 + this.elapsed * 0.22;
      const dist = 3.2 + Math.sin(this.elapsed * 0.36) * 0.42;
      const height = 1.46 + Math.sin(this.elapsed * 0.28) * 0.26;
      _camGoal.set(
        _mid.x + Math.sin(orbitAngle) * dist,
        height,
        _mid.z + Math.cos(orbitAngle) * dist,
      );
      _lookGoal.set(_mid.x, 1.12, _mid.z);
      this.camPos.x = THREE.MathUtils.damp(this.camPos.x, _camGoal.x, 3.8, dt);
      this.camPos.y = THREE.MathUtils.damp(this.camPos.y, _camGoal.y, 3.8, dt);
      this.camPos.z = THREE.MathUtils.damp(this.camPos.z, _camGoal.z, 3.8, dt);
      this.camLook.x = THREE.MathUtils.damp(this.camLook.x, _lookGoal.x, 6, dt);
      this.camLook.y = THREE.MathUtils.damp(this.camLook.y, _lookGoal.y, 6, dt);
      this.camLook.z = THREE.MathUtils.damp(this.camLook.z, _lookGoal.z, 6, dt);
      this.camera.position.copy(this.camPos);
      if (this.shakeIntensity > 0.001) {
        this.camera.position.x += (Math.random() - 0.5) * this.shakeIntensity;
        this.camera.position.y += (Math.random() - 0.5) * this.shakeIntensity * 0.8;
        this.shakeIntensity = THREE.MathUtils.damp(this.shakeIntensity, 0, 14, dt);
      }
      this.camera.lookAt(this.camLook);
      return;
    }
    if (this.mode === 'waitingroom') {
      if (this.waitingConfirmActive) {
        const cp = THREE.MathUtils.clamp(
          this.waitingConfirmTimer / this.WAITING_CONFIRM_DURATION,
          0,
          1,
        );
        const zoomEase = Math.sin(Math.min(1, cp * 1.25) * (Math.PI / 2));
        _camGoal.set(
          THREE.MathUtils.lerp(-0.26, 0.56, zoomEase),
          THREE.MathUtils.lerp(1.32, 1.38, zoomEase),
          THREE.MathUtils.lerp(3.68, 1.82, zoomEase),
        );
        _lookGoal.set(
          THREE.MathUtils.lerp(0.06, 0.88, zoomEase),
          THREE.MathUtils.lerp(1.06, 1.26, zoomEase),
          THREE.MathUtils.lerp(0.25, 0.45, zoomEase),
        );
        this.camPos.x = THREE.MathUtils.damp(this.camPos.x, _camGoal.x, 11, dt);
        this.camPos.y = THREE.MathUtils.damp(this.camPos.y, _camGoal.y, 11, dt);
        this.camPos.z = THREE.MathUtils.damp(this.camPos.z, _camGoal.z, 11, dt);
        this.camLook.x = THREE.MathUtils.damp(this.camLook.x, _lookGoal.x, 11, dt);
        this.camLook.y = THREE.MathUtils.damp(this.camLook.y, _lookGoal.y, 11, dt);
        this.camLook.z = THREE.MathUtils.damp(this.camLook.z, _lookGoal.z, 11, dt);
        this.camera.position.copy(this.camPos);
        if (this.shakeIntensity > 0.001) {
          this.camera.position.x += (Math.random() - 0.5) * this.shakeIntensity;
          this.camera.position.y += (Math.random() - 0.5) * this.shakeIntensity * 0.8;
          this.shakeIntensity = THREE.MathUtils.damp(this.shakeIntensity, 0, 14, dt);
        }
        this.camera.lookAt(this.camLook);
        return;
      }

      _camGoal.set(
        -0.26 + Math.sin(this.elapsed * 0.35) * 0.035,
        1.32 + Math.cos(this.elapsed * 0.28) * 0.015,
        3.68,
      );
      _lookGoal.set(0.06, 1.06, 0.25);
      this.camPos.x = THREE.MathUtils.damp(this.camPos.x, _camGoal.x, 4, dt);
      this.camPos.y = THREE.MathUtils.damp(this.camPos.y, _camGoal.y, 4, dt);
      this.camPos.z = THREE.MathUtils.damp(this.camPos.z, _camGoal.z, 4, dt);
      this.camLook.x = THREE.MathUtils.damp(this.camLook.x, _lookGoal.x, 4, dt);
      this.camLook.y = THREE.MathUtils.damp(this.camLook.y, _lookGoal.y, 4, dt);
      this.camLook.z = THREE.MathUtils.damp(this.camLook.z, _lookGoal.z, 4, dt);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
      return;
    }
    if (this.mode === 'showcase') {
      this.showcaseAngle += dt * 0.22;
      const r = 4.45;
      _camGoal.set(Math.sin(this.showcaseAngle) * r, 2.15, Math.cos(this.showcaseAngle) * r);
      _lookGoal.set(0, 1.05, 0);
      this.camPos.x = THREE.MathUtils.damp(this.camPos.x, _camGoal.x, 4, dt);
      this.camPos.y = THREE.MathUtils.damp(this.camPos.y, _camGoal.y, 4, dt);
      this.camPos.z = THREE.MathUtils.damp(this.camPos.z, _camGoal.z, 4, dt);
      this.camLook.x = THREE.MathUtils.damp(this.camLook.x, _lookGoal.x, 4, dt);
      this.camLook.y = THREE.MathUtils.damp(this.camLook.y, _lookGoal.y, 4, dt);
      this.camLook.z = THREE.MathUtils.damp(this.camLook.z, _lookGoal.z, 4, dt);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
      return;
    }
    if (this.mode === 'faceoff') {
      _camGoal.set(Math.sin(this.elapsed * 0.45) * 0.08, 1.46, 3.65);
      _lookGoal.set(0, 0.96, 0.15);
      this.camPos.x = THREE.MathUtils.damp(this.camPos.x, _camGoal.x, 5, dt);
      this.camPos.y = THREE.MathUtils.damp(this.camPos.y, _camGoal.y, 5, dt);
      this.camPos.z = THREE.MathUtils.damp(this.camPos.z, _camGoal.z, 5, dt);
      this.camLook.x = THREE.MathUtils.damp(this.camLook.x, _lookGoal.x, 5, dt);
      this.camLook.y = THREE.MathUtils.damp(this.camLook.y, _lookGoal.y, 5, dt);
      this.camLook.z = THREE.MathUtils.damp(this.camLook.z, _lookGoal.z, 5, dt);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
      return;
    }
    if (this.mode === 'creator') {
      const dist = 3.25;
      const halfW =
        dist * Math.tan(THREE.MathUtils.degToRad(38 * 0.5)) * (this.camera.aspect || 1.6);
      const lookX = 0.95 - halfW * 0.44;
      _camGoal.set(
        lookX - 0.12 + Math.sin(this.elapsed * 0.55) * 0.05,
        1.18,
        0.18 + dist,
      );
      _lookGoal.set(lookX, 0.98, 0.18);
      this.camPos.x = THREE.MathUtils.damp(this.camPos.x, _camGoal.x, 6, dt);
      this.camPos.y = THREE.MathUtils.damp(this.camPos.y, _camGoal.y, 6, dt);
      this.camPos.z = THREE.MathUtils.damp(this.camPos.z, _camGoal.z, 6, dt);
      this.camLook.x = THREE.MathUtils.damp(this.camLook.x, _lookGoal.x, 6, dt);
      this.camLook.y = THREE.MathUtils.damp(this.camLook.y, _lookGoal.y, 6, dt);
      this.camLook.z = THREE.MathUtils.damp(this.camLook.z, _lookGoal.z, 6, dt);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
      return;
    }

    if (!this.playerSim || !this.oppSim) return;

    if (this.mode === 'fight' && this.phase === 'walkout') {
      const wp = THREE.MathUtils.clamp(this.walkoutClock / this.walkoutDuration, 0, 1);
      const px = this.playerSim.pos.x;
      const py = this.playerSim.pos.y;
      const pz = this.playerSim.pos.z;
      const cx = this.playerCoachSim ? this.playerCoachSim.pos.x : px + 0.6;
      const midX = THREE.MathUtils.lerp(px, cx, 0.28);

      if (wp < 0.56) {
        // Low front-3/4 hero tracking shot backing down the walkout runway ahead of boxer & coach
        _camGoal.set(
          midX + 0.72 + Math.sin(wp * Math.PI * 2) * 0.25,
          py + 1.48,
          pz + 3.15,
        );
        _lookGoal.set(midX, py + 1.15, pz);
      } else if (wp < 0.87) {
        // Sweeping side-3/4 shot climbing the stairs and parting the ring ropes
        const tClimb = THREE.MathUtils.clamp((wp - 0.56) / 0.31, 0, 1);
        _camGoal.set(
          THREE.MathUtils.lerp(midX + 0.72, -2.35, tClimb),
          THREE.MathUtils.lerp(py + 1.48, 1.72, tClimb),
          THREE.MathUtils.lerp(pz + 3.15, -1.25, tClimb),
        );
        _lookGoal.set(px * 0.5, py + 1.1, pz + 0.2);
      } else {
        // Gliding smoothly into broadcast ring framing
        const tSettle = THREE.MathUtils.clamp((wp - 0.87) / 0.13, 0, 1);
        _camGoal.set(
          THREE.MathUtils.lerp(-2.35, -0.45, tSettle),
          THREE.MathUtils.lerp(1.72, 2.15, tSettle),
          THREE.MathUtils.lerp(-1.25, 4.15, tSettle),
        );
        _lookGoal.set(
          THREE.MathUtils.lerp(px * 0.5, 0, tSettle),
          1.12,
          THREE.MathUtils.lerp(pz + 0.2, 0, tSettle),
        );
      }

      this.camPos.x = THREE.MathUtils.damp(this.camPos.x, _camGoal.x, 5.2, dt);
      this.camPos.y = THREE.MathUtils.damp(this.camPos.y, _camGoal.y, 5.2, dt);
      this.camPos.z = THREE.MathUtils.damp(this.camPos.z, _camGoal.z, 5.2, dt);
      this.camLook.x = THREE.MathUtils.damp(this.camLook.x, _lookGoal.x, 6.5, dt);
      this.camLook.y = THREE.MathUtils.damp(this.camLook.y, _lookGoal.y, 6.5, dt);
      this.camLook.z = THREE.MathUtils.damp(this.camLook.z, _lookGoal.z, 6.5, dt);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
      return;
    }

    if (
      this.mode === 'fight' &&
      (this.phase === 'celebration' || this.phase === 'finished') &&
      this.winner
    ) {
      const wSim = this.winner === 'player' ? this.playerSim : this.oppSim;
      const wCoach = this.winner === 'player' ? this.playerCoachSim : this.oppCoachSim;
      const cp = THREE.MathUtils.clamp(this.celebrationClock / this.celebrationDuration, 0, 1);
      const focusX = wCoach
        ? THREE.MathUtils.lerp(wSim.pos.x, wCoach.pos.x, 0.28)
        : wSim.pos.x;
      const focusZ = wCoach
        ? THREE.MathUtils.lerp(wSim.pos.z, wCoach.pos.z, 0.28)
        : wSim.pos.z;

      const orbitAzimuth = wSim.facingAngle + THREE.MathUtils.lerp(-0.42, 0.52, cp);
      const dist = THREE.MathUtils.lerp(2.75, 3.05, cp);
      const camH = 1.44 + Math.sin(cp * Math.PI) * 0.22;

      _camGoal.set(
        focusX + Math.sin(orbitAzimuth) * dist,
        camH,
        focusZ + Math.cos(orbitAzimuth) * dist,
      );
      _lookGoal.set(focusX, 1.18, focusZ);

      this.camPos.x = THREE.MathUtils.damp(this.camPos.x, _camGoal.x, 4.8, dt);
      this.camPos.y = THREE.MathUtils.damp(this.camPos.y, _camGoal.y, 4.8, dt);
      this.camPos.z = THREE.MathUtils.damp(this.camPos.z, _camGoal.z, 4.8, dt);
      this.camLook.x = THREE.MathUtils.damp(this.camLook.x, _lookGoal.x, 6.0, dt);
      this.camLook.y = THREE.MathUtils.damp(this.camLook.y, _lookGoal.y, 6.0, dt);
      this.camLook.z = THREE.MathUtils.damp(this.camLook.z, _lookGoal.z, 6.0, dt);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
      return;
    }

    _mid.addVectors(this.playerSim.pos, this.oppSim.pos).multiplyScalar(0.5);
    _axis.subVectors(this.oppSim.pos, this.playerSim.pos).setY(0);
    const sep = _axis.length();
    if (sep > 0.01) _axis.divideScalar(sep);
    else _axis.set(1, 0, 0);

    // UFC 5 Broadcast side-on perpendicular normal (keep consistent hemisphere so it never flips)
    _perp.set(-_axis.z, 0, _axis.x);
    if (_perp.dot(this.prevPerp) < 0) {
      _perp.negate();
    }
    this.prevPerp.lerp(_perp, Math.min(1, dt * 4)).normalize();

    // Dynamic zoom & broadcast slight 3/4 player-flank offset
    const camDist = THREE.MathUtils.clamp(3.35 + sep * 0.42, 3.65, 5.25);
    const camHeight = THREE.MathUtils.clamp(2.02 + sep * 0.14, 2.08, 2.65);

    // Slight bias behind player's left flank for unmistakable UFC 5 broadcast framing
    _camGoal
      .copy(_mid)
      .addScaledVector(this.prevPerp, camDist)
      .addScaledVector(_axis, -0.45);
    _camGoal.y = camHeight;

    _lookGoal.set(_mid.x, 1.12, _mid.z);

    this.camPos.x = THREE.MathUtils.damp(this.camPos.x, _camGoal.x, 6.5, dt);
    this.camPos.y = THREE.MathUtils.damp(this.camPos.y, _camGoal.y, 6.5, dt);
    this.camPos.z = THREE.MathUtils.damp(this.camPos.z, _camGoal.z, 6.5, dt);

    this.camLook.x = THREE.MathUtils.damp(this.camLook.x, _lookGoal.x, 9, dt);
    this.camLook.y = THREE.MathUtils.damp(this.camLook.y, _lookGoal.y, 9, dt);
    this.camLook.z = THREE.MathUtils.damp(this.camLook.z, _lookGoal.z, 9, dt);

    this.camera.position.copy(this.camPos);

    // Decaying camera shake
    if (this.shakeIntensity > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeIntensity;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeIntensity * 0.8;
      this.shakeIntensity = THREE.MathUtils.damp(this.shakeIntensity, 0, 14, dt);
    }

    this.camera.lookAt(this.camLook);
  }

  private updateParticles(dt: number) {
    let anyChanged = false;
    for (let i = 0; i < this.MAX_PARTICLES; i++) {
      const pt = this.particles[i];
      if (!pt.active) continue;
      anyChanged = true;
      pt.life -= dt;
      if (pt.life <= 0) {
        pt.active = false;
        _dummy.position.set(0, -10, 0);
        _dummy.scale.setScalar(0.001);
        _dummy.updateMatrix();
        this.particleMesh.setMatrixAt(i, _dummy.matrix);
        continue;
      }
      pt.vy -= 9.8 * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.z += pt.vz * dt;
      if (pt.y < 0.02) {
        pt.y = 0.02;
        pt.vy *= -0.3;
      }
      const s = pt.size * (pt.life / pt.maxLife);
      _dummy.position.set(pt.x, pt.y, pt.z);
      _dummy.scale.setScalar(Math.max(0.05, s));
      _dummy.updateMatrix();
      this.particleMesh.setMatrixAt(i, _dummy.matrix);
      this.particleMesh.setColorAt(i, _pColor.setHex(pt.colorHex));
    }
    if (anyChanged) {
      this.particleMesh.instanceMatrix.needsUpdate = true;
      if (this.particleMesh.instanceColor) {
        this.particleMesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private beginCelebration() {
    if (!this.playerSim || !this.oppSim || !this.winner) return;
    this.phase = 'celebration';
    this.celebrationClock = 0;
    this.crowdExcitement = 1.0;

    const winnerSim = this.winner === 'player' ? this.playerSim : this.oppSim;
    const loserSim = this.winner === 'player' ? this.oppSim : this.playerSim;
    const winnerCoach = this.winner === 'player' ? this.playerCoachSim : this.oppCoachSim;
    const loserCoach = this.winner === 'player' ? this.oppCoachSim : this.playerCoachSim;

    winnerSim.attackType = null;
    winnerSim.isGuarding = false;
    winnerSim.dodgeTimer = 0;
    winnerSim.hitStunTimer = 0;
    winnerSim.anim.attackType = null;
    winnerSim.anim.isGuarding = false;
    winnerSim.anim.dodgeTimer = 0;
    winnerSim.anim.hitFlash = 0;
    winnerSim.anim.knockdownProgress = 0;
    winnerSim.anim.ragdoll.active = false;
    winnerSim.anim.celebrationMode = true;
    winnerSim.anim.celebrationProgress = 0;

    loserSim.attackType = null;
    loserSim.isGuarding = false;
    loserSim.dodgeTimer = 0;
    loserSim.anim.attackType = null;
    loserSim.anim.isGuarding = false;
    if (this.winMethod === 'UD') {
      loserSim.anim.loserCornerMode = true;
    }

    if (winnerCoach) {
      winnerCoach.startPos.copy(winnerCoach.pos);
      winnerCoach.anim.mode = 'walk_with_boxer';
      winnerCoach.anim.celebrationStyle =
        winnerSim.anim.motionProfile?.celebrationStyle ?? 'double_fist_jump';
      winnerCoach.anim.celebrationProgress = 0;
    }
    if (loserCoach) {
      loserCoach.anim.mode = 'console_corner';
    }

    const methodText =
      this.winMethod === 'KO'
        ? 'KO VICTORY!'
        : this.winMethod === 'TKO'
          ? 'TKO VICTORY!'
          : 'DECISION VICTORY!';
    this.setCallout(
      this.winner === 'player' ? methodText : `${winnerSim.name.toUpperCase()} WINS`,
      this.winner === 'player' ? 'gold' : 'red',
      4.5,
    );
    this.emitHud();
  }

  private updateApronCoaches(dt: number) {
    if (this.playerCoachSim) {
      this.playerCoachSim.anim.time += dt;
      this.playerCoachSim.anim.mode = 'apron_support';
      updateCoachPose(this.playerCoachSim.rig, this.playerCoachSim.anim, dt);
    }
    if (this.oppCoachSim) {
      this.oppCoachSim.anim.time += dt;
      this.oppCoachSim.anim.mode = 'apron_support';
      updateCoachPose(this.oppCoachSim.rig, this.oppCoachSim.anim, dt);
    }
  }

  private updateFightStateMachine(dt: number) {
    if (!this.playerSim || !this.oppSim) return;

    if (this.calloutTimer > 0) {
      this.calloutTimer = Math.max(0, this.calloutTimer - dt);
      if (this.calloutTimer === 0) this.calloutText = null;
    }

    if (this.phase === 'walkout') {
      this.walkoutClock += dt;
      const wp = THREE.MathUtils.clamp(this.walkoutClock / this.walkoutDuration, 0, 1);

      let bx = -0.36;
      let by = -1.02;
      let bz = -12.5;
      let bYaw = 0.02;
      let stairW = 0;
      let ropeDuck = 0;
      let bSpeed = 1.65;

      if (wp < 0.56) {
        const u = wp / 0.56;
        bz = THREE.MathUtils.lerp(-12.5, -5.0, u);
        bx = THREE.MathUtils.lerp(-0.36, -0.26, u);
        by = -1.02;
        bYaw = 0.02;
      } else if (wp < 0.72) {
        const u = (wp - 0.56) / 0.16;
        bz = THREE.MathUtils.lerp(-5.0, -4.06, u);
        bx = THREE.MathUtils.lerp(-0.26, -0.28, u);
        by = THREE.MathUtils.lerp(-1.02, 0, Math.sin(u * (Math.PI / 2)));
        stairW = Math.sin(u * Math.PI);
        bSpeed = 1.32;
      } else if (wp < 0.85) {
        const u = (wp - 0.72) / 0.13;
        bz = THREE.MathUtils.lerp(-4.06, -3.28, u);
        bx = THREE.MathUtils.lerp(-0.28, -0.44, u);
        by = 0;
        bYaw = THREE.MathUtils.lerp(0.02, 0.28, u);
        ropeDuck = Math.sin(u * Math.PI);
        bSpeed = 1.25;
      } else {
        const u = (wp - 0.85) / 0.15;
        const smoothU = u * u * (3 - 2 * u);
        bz = THREE.MathUtils.lerp(-3.28, 0, smoothU);
        bx = THREE.MathUtils.lerp(-0.44, -1.15, smoothU);
        by = 0;
        bYaw = THREE.MathUtils.lerp(0.28, Math.PI / 2, smoothU);
        bSpeed = (1 - smoothU) * 1.45;
      }

      this.playerSim.vel.set(0, 0, bSpeed);
      this.playerSim.pos.set(bx, by, bz);
      this.playerSim.facingAngle = bYaw;
      this.playerSim.rig.root.position.copy(this.playerSim.pos);
      this.playerSim.rig.root.rotation.y = bYaw;

      this.playerSim.anim.time += dt;
      this.playerSim.anim.walkoutMode = true;
      this.playerSim.anim.walkoutProgress = wp;
      this.playerSim.anim.walkoutStairWeight = stairW;
      this.playerSim.anim.walkoutRopeDuck = ropeDuck;
      this.playerSim.anim.moveSpeed = bSpeed;
      updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);

      // Red corner coach walks side-by-side up stairs, then takes Red apron corner
      if (this.playerCoachSim) {
        let cx = 0.42;
        let cy = -1.02;
        let cz = -12.75;
        let cYaw = 0;
        let cStair = 0;
        let cSpeed = 1.62;
        let cMode: 'walk_with_boxer' | 'apron_support' = 'walk_with_boxer';

        if (wp < 0.56) {
          const u = wp / 0.56;
          cz = THREE.MathUtils.lerp(-12.75, -5.15, u);
          cx = THREE.MathUtils.lerp(0.42, 0.44, u);
          cy = -1.02;
          cYaw = -0.04;
        } else if (wp < 0.72) {
          const u = (wp - 0.56) / 0.16;
          cz = THREE.MathUtils.lerp(-5.15, -4.02, u);
          cx = THREE.MathUtils.lerp(0.44, 0.34, u);
          cy = THREE.MathUtils.lerp(-1.02, 0, Math.sin(u * (Math.PI / 2)));
          cStair = Math.sin(u * Math.PI);
          cYaw = -0.18;
          cSpeed = 1.3;
        } else if (wp < 0.94) {
          const u = (wp - 0.72) / 0.22;
          cz = -3.94;
          cx = THREE.MathUtils.lerp(0.34, -2.2, u);
          cy = 0;
          cYaw = THREE.MathUtils.lerp(-Math.PI / 2, 0.55, u * u);
          cSpeed = 1.38;
        } else {
          cx = -2.2;
          cy = 0;
          cz = -3.94;
          cYaw = 0.55;
          cSpeed = 0;
          cMode = 'apron_support';
        }

        this.playerCoachSim.pos.set(cx, cy, cz);
        this.playerCoachSim.facingAngle = cYaw;
        this.playerCoachSim.rig.root.position.copy(this.playerCoachSim.pos);
        this.playerCoachSim.rig.root.rotation.y = cYaw;
        this.playerCoachSim.anim.time += dt;
        this.playerCoachSim.anim.mode = cMode;
        this.playerCoachSim.anim.moveSpeed = cSpeed;
        this.playerCoachSim.anim.stairWeight = cStair;
        this.playerCoachSim.anim.ropeDuck = 0;
        this.playerCoachSim.anim.walkoutProgress = wp;
        this.playerCoachSim.anim.boxerSideSign = -1;
        updateCoachPose(this.playerCoachSim.rig, this.playerCoachSim.anim, dt);
      }

      // Opponent & Blue coach warm up attentively in Blue Corner
      this.oppSim.anim.time += dt;
      this.oppSim.anim.isGuarding = false;
      updateBoxerPose(this.oppSim.rig, this.oppSim.anim, dt);
      if (this.oppCoachSim) {
        this.oppCoachSim.anim.time += dt;
        this.oppCoachSim.anim.mode = 'apron_support';
        updateCoachPose(this.oppCoachSim.rig, this.oppCoachSim.anim, dt);
      }

      if (wp >= 1) {
        this.skipWalkout();
      }
      return;
    }

    if (this.phase === 'intro') {
      this.phaseTimer -= dt;
      this.playerSim.anim.time += dt;
      this.oppSim.anim.time += dt;
      updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);
      updateBoxerPose(this.oppSim.rig, this.oppSim.anim, dt);
      this.updateApronCoaches(dt);
      if (this.phaseTimer <= 0) {
        this.phase = 'fighting';
        this.setCallout('FIGHT!', 'white', 0.8);
      }
      return;
    }

    if (this.phase === 'fighting') {
      if (this.knockdownLeadInTimer > 0) {
        this.knockdownLeadInTimer = Math.max(0, this.knockdownLeadInTimer - dt);
        const downed = this.knockdownTarget === 'player' ? this.playerSim : this.oppSim;
        const victor = this.knockdownTarget === 'player' ? this.oppSim : this.playerSim;

        downed.anim.time += dt;
        downed.anim.hitFlash = Math.max(0, downed.anim.hitFlash - dt * 5.0);
        updateBoxerPose(downed.rig, downed.anim, dt);

        victor.anim.isGuarding = false;
        victor.anim.attackType = null;
        victor.anim.time += dt;
        updateBoxerPose(victor.rig, victor.anim, dt);

        this.fightSimClock += dt;
        this.recordReplayFrame();

        if (this.knockdownLeadInTimer <= 0) {
          this.beginHighlightReplay();
        }
        return;
      }

      this.roundTimer = Math.max(0, this.roundTimer - dt);
      this.fightSimClock += dt;

      this.updateFighterCombat(this.playerSim, this.oppSim, dt);
      this.updateFighterCombat(this.oppSim, this.playerSim, dt);
      this.resolveFighterSeparation();
      this.updateApronCoaches(dt);
      this.recordReplayFrame();

      if (this.roundTimer <= 0 && this.phase === 'fighting' && this.knockdownLeadInTimer <= 0) {
        soundEngine.playBell(2);
        if (this.round >= this.maxRounds) {
          // End of fight: Unanimous Decision based on HP% + round damage
          const pScore = this.playerSim.hp / this.playerSim.maxHp + (this.playerSim.roundDamage * 0.001);
          const oScore = this.oppSim.hp / this.oppSim.maxHp + (this.oppSim.roundDamage * 0.001);
          this.winner = pScore >= oScore ? 'player' : 'opponent';
          this.winMethod = 'UD';
          this.beginCelebration();
        } else {
          this.phase = 'between_rounds';
          this.phaseTimer = 2.4;
          this.setCallout(`END OF ROUND ${this.round}`, 'white', 2.2);
        }
      }
      return;
    }

    if (this.phase === 'highlight') {
      const distFromImpact = this.highlightCursor - this.highlightImpactTime;
      const slowScale =
        distFromImpact >= -0.06 && distFromImpact <= 0.14
          ? 0.16
          : distFromImpact < -0.06
            ? 0.42
            : 0.34;

      this.highlightCursor += dt * slowScale;
      const span = Math.max(0.05, this.highlightEndTime - this.highlightStartTime);
      const progress = THREE.MathUtils.clamp(
        (this.highlightCursor - this.highlightStartTime) / span,
        0,
        1,
      );

      // Find surrounding keyframes in replayOrdered
      let idxA = 0;
      let idxB = 0;
      for (let i = 0; i < this.replayOrderedCount - 1; i++) {
        if (this.replayOrdered[i + 1].t >= this.highlightCursor) {
          idxA = i;
          idxB = i + 1;
          break;
        }
        idxA = i;
        idxB = i + 1;
      }
      const frameA = this.replayOrdered[idxA];
      const frameB = this.replayOrdered[idxB];
      const segDt = Math.max(0.0001, frameB.t - frameA.t);
      const alpha = THREE.MathUtils.clamp((this.highlightCursor - frameA.t) / segDt, 0, 1);

      this.applyInterpolatedPose(this.playerSim, frameA.player, frameB.player, alpha);
      this.applyInterpolatedPose(this.oppSim, frameA.opp, frameB.opp, alpha);

      if (!this.highlightImpactFxFired && this.highlightCursor >= this.highlightImpactTime) {
        this.highlightImpactFxFired = true;
        const defender = this.knockdownTarget === 'player' ? this.playerSim : this.oppSim;
        this.shakeIntensity = 0.08;
        this.spawnImpactParticles(
          defender.rig.headWorldPos,
          20,
          this.highlightIsCounter ? 0x38bdf8 : 0xfbbf24,
          0.6,
        );
      }

      if (this.shakeIntensity > 0.001) {
        this.shakeIntensity = THREE.MathUtils.damp(this.shakeIntensity, 0, 12, dt);
      }
      this.sampleAndApplyHighlightCamera(progress, false);

      if (this.highlightCursor >= this.highlightEndTime) {
        this.finishHighlightReplay();
      }
      return;
    }

    if (this.phase === 'knockdown') {
      const downed = this.knockdownTarget === 'player' ? this.playerSim : this.oppSim;
      const victor = this.knockdownTarget === 'player' ? this.oppSim : this.playerSim;

      // Animate fall to canvas
      downed.anim.knockdownProgress = THREE.MathUtils.damp(downed.anim.knockdownProgress, 1, 7, dt);
      updateBoxerPose(downed.rig, downed.anim, dt);
      victor.anim.isGuarding = false;
      victor.anim.attackType = null;
      victor.anim.time += dt;
      updateBoxerPose(victor.rig, victor.anim, dt);
      this.updateApronCoaches(dt);

      const speedBoost = this.knockdownTarget === 'player' ? Math.min(0.35, this.playerGetupBoost * 0.15) : 0;
      this.knockdownTickTimer -= dt * (1 + speedBoost);
      if (this.knockdownTickTimer <= 0) {
        this.knockdownCount += 1;
        this.knockdownTickTimer = 0.85;

        if (this.knockdownCount >= this.knockdownRecoveryCount && this.knockdownRecoveryCount < 10) {
          // Fighter beats the count!
          downed.hp = Math.round(downed.maxHp * 0.34);
          downed.stamina = Math.round(downed.maxStamina * 0.55);
          downed.guard = downed.maxGuard;
          downed.anim.knockdownProgress = 0;
          downed.anim.ragdoll.active = false;
          this.phase = 'fighting';
          this.knockdownTarget = null;
          this.setCallout('BEATS THE COUNT!', 'cyan', 1.1);
          return;
        }

        if (this.knockdownCount >= 10) {
          this.winner = downed.isPlayer ? 'opponent' : 'player';
          this.winMethod = downed.knockdowns >= 3 ? 'TKO' : 'KO';
          soundEngine.playBell(3);
          this.beginCelebration();
        }
      }
      return;
    }

    if (this.phase === 'between_rounds') {
      this.phaseTimer -= dt;
      this.playerSim.anim.time += dt;
      this.oppSim.anim.time += dt;
      updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);
      updateBoxerPose(this.oppSim.rig, this.oppSim.anim, dt);
      this.updateApronCoaches(dt);

      if (this.phaseTimer <= 0) {
        this.round += 1;
        this.roundTimer = this.roundDuration;
        // Corner recovery between rounds
        this.playerSim.hp = Math.min(this.playerSim.maxHp, this.playerSim.hp + this.playerSim.maxHp * 0.14);
        this.playerSim.stamina = this.playerSim.maxStamina;
        this.playerSim.guard = this.playerSim.maxGuard;
        this.playerSim.pos.set(-1.15, 0, 0);

        this.oppSim.hp = Math.min(this.oppSim.maxHp, this.oppSim.hp + this.oppSim.maxHp * 0.14);
        this.oppSim.stamina = this.oppSim.maxStamina;
        this.oppSim.guard = this.oppSim.maxGuard;
        this.oppSim.pos.set(1.15, 0, 0);

        this.replayWriteIdx = 0;
        this.replayFilledCount = 0;
        this.replayOrderedCount = 0;
        this.fightSimClock = 0;

        this.phase = 'fighting';
        soundEngine.playBell(1);
        this.setCallout(`ROUND ${this.round}`, 'gold', 1.0);
      }
      return;
    }

    if (this.phase === 'celebration' && this.winner) {
      this.celebrationClock += dt;
      const cp = THREE.MathUtils.clamp(this.celebrationClock / this.celebrationDuration, 0, 1);

      const winnerSim = this.winner === 'player' ? this.playerSim : this.oppSim;
      const loserSim = this.winner === 'player' ? this.oppSim : this.playerSim;
      const winnerCoach = this.winner === 'player' ? this.playerCoachSim : this.oppCoachSim;
      const loserCoach = this.winner === 'player' ? this.oppCoachSim : this.playerCoachSim;

      // Turn winning boxer slightly toward the broadcast camera so celebration + coach look natural together
      const targetFace = winnerSim.isPlayer ? 0.35 : -0.35;
      let fDiff = targetFace - winnerSim.facingAngle;
      while (fDiff > Math.PI) fDiff -= Math.PI * 2;
      while (fDiff < -Math.PI) fDiff += Math.PI * 2;
      winnerSim.facingAngle += fDiff * Math.min(1, dt * 4.5);
      winnerSim.rig.root.position.copy(winnerSim.pos);
      winnerSim.rig.root.rotation.y = winnerSim.facingAngle;

      winnerSim.anim.time += dt;
      winnerSim.anim.celebrationMode = true;
      winnerSim.anim.celebrationProgress = cp;
      updateBoxerPose(winnerSim.rig, winnerSim.anim, dt);

      // Winning coach hurries onto canvas right alongside the champion and celebrates together!
      if (winnerCoach) {
        const style = winnerSim.anim.motionProfile?.celebrationStyle ?? 'double_fist_jump';
        const sideOffset = winnerSim.isPlayer ? -0.72 : 0.72;
        const zOffset = style === 'coach_arm_raise' ? -0.14 : -0.36;
        const goalX = THREE.MathUtils.clamp(winnerSim.pos.x + sideOffset, -3.1, 3.1);
        const goalZ = THREE.MathUtils.clamp(winnerSim.pos.z + zOffset, -3.1, 3.1);
        const enterT = THREE.MathUtils.clamp(cp / 0.22, 0, 1);
        const smoothEnter = enterT * enterT * (3 - 2 * enterT);

        if (enterT < 1) {
          winnerCoach.pos.set(
            THREE.MathUtils.lerp(winnerCoach.startPos.x, goalX, smoothEnter),
            0,
            THREE.MathUtils.lerp(winnerCoach.startPos.z, goalZ, smoothEnter),
          );
          const dx = goalX - winnerCoach.startPos.x;
          const dz = goalZ - winnerCoach.startPos.z;
          const runYaw = Math.atan2(dx, dz);
          winnerCoach.facingAngle = runYaw;
          winnerCoach.anim.mode = 'walk_with_boxer';
          winnerCoach.anim.moveSpeed = 2.15;
          winnerCoach.anim.ropeDuck = Math.sin(enterT * Math.PI) * 0.72;
        } else {
          winnerCoach.pos.set(goalX, 0, goalZ);
          const coachFace = winnerSim.isPlayer ? 0.48 : -0.48;
          let cDiff = coachFace - winnerCoach.facingAngle;
          while (cDiff > Math.PI) cDiff -= Math.PI * 2;
          while (cDiff < -Math.PI) cDiff += Math.PI * 2;
          winnerCoach.facingAngle += cDiff * Math.min(1, dt * 6);
          winnerCoach.anim.mode = 'celebrate_with_boxer';
          winnerCoach.anim.moveSpeed = 0;
          winnerCoach.anim.ropeDuck = 0;
          winnerCoach.anim.celebrationStyle = style;
          winnerCoach.anim.celebrationProgress = THREE.MathUtils.clamp((cp - 0.22) / 0.78, 0, 1);
        }

        // Compute which side of the coach the boxer is standing on
        const rightX = Math.cos(winnerCoach.facingAngle);
        const rightZ = -Math.sin(winnerCoach.facingAngle);
        const relDot =
          (winnerSim.pos.x - winnerCoach.pos.x) * rightX +
          (winnerSim.pos.z - winnerCoach.pos.z) * rightZ;
        winnerCoach.anim.boxerSideSign = relDot >= 0 ? 1 : -1;

        winnerCoach.rig.root.position.copy(winnerCoach.pos);
        winnerCoach.rig.root.rotation.y = winnerCoach.facingAngle;
        winnerCoach.anim.time += dt;
        updateCoachPose(winnerCoach.rig, winnerCoach.anim, dt);
      }

      // Loser & losing coach
      loserSim.anim.time += dt * 0.7;
      updateBoxerPose(loserSim.rig, loserSim.anim, dt);
      if (loserCoach) {
        loserCoach.anim.time += dt;
        loserCoach.anim.mode = 'console_corner';
        updateCoachPose(loserCoach.rig, loserCoach.anim, dt);
      }

      if (cp >= 1) {
        this.phase = 'finished';
        this.emitHud();
      }
      return;
    }

    if (this.phase === 'finished') {
      // Hold final celebration pose gently behind modal
      this.playerSim.anim.time += dt * 0.6;
      this.oppSim.anim.time += dt * 0.6;
      updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);
      updateBoxerPose(this.oppSim.rig, this.oppSim.anim, dt);
      if (this.playerCoachSim) {
        this.playerCoachSim.anim.time += dt * 0.6;
        updateCoachPose(this.playerCoachSim.rig, this.playerCoachSim.anim, dt);
      }
      if (this.oppCoachSim) {
        this.oppCoachSim.anim.time += dt * 0.6;
        updateCoachPose(this.oppCoachSim.rig, this.oppCoachSim.anim, dt);
      }
    }
  }

  private emitHud() {
    if (!this.playerSim || !this.oppSim) return;
    const highlightProgress =
      this.phase === 'highlight'
        ? THREE.MathUtils.clamp(
            (this.highlightCursor - this.highlightStartTime) /
              Math.max(0.05, this.highlightEndTime - this.highlightStartTime),
            0,
            1,
          )
        : 0;
    const phaseProgress =
      this.phase === 'walkout'
        ? THREE.MathUtils.clamp(this.walkoutClock / this.walkoutDuration, 0, 1)
        : this.phase === 'celebration'
          ? THREE.MathUtils.clamp(this.celebrationClock / this.celebrationDuration, 0, 1)
          : highlightProgress;

    this.onHudUpdate({
      playerHp: Math.ceil(this.playerSim.hp),
      playerMaxHp: this.playerSim.maxHp,
      playerStamina: Math.round(this.playerSim.stamina),
      playerMaxStamina: this.playerSim.maxStamina,
      playerGuard: Math.round(this.playerSim.guard),
      playerMaxGuard: this.playerSim.maxGuard,
      playerKnockdowns: this.playerSim.knockdowns,
      oppHp: Math.ceil(this.oppSim.hp),
      oppMaxHp: this.oppSim.maxHp,
      oppStamina: Math.round(this.oppSim.stamina),
      oppMaxStamina: this.oppSim.maxStamina,
      oppGuard: Math.round(this.oppSim.guard),
      oppMaxGuard: this.oppSim.maxGuard,
      oppKnockdowns: this.oppSim.knockdowns,
      round: this.round,
      maxRounds: this.maxRounds,
      roundTimer: this.roundTimer,
      phase: this.phase,
      phaseProgress,
      knockdownTarget: this.knockdownTarget,
      knockdownCount: this.knockdownCount,
      calloutText: this.calloutText,
      calloutTone: this.calloutTone,
      playerCombo: this.playerSim.comboCount,
      isCounterWindow: this.playerSim.counterWindowTimer > 0,
      isPlayerGuarding: this.playerSim.isGuarding,
      highlightPunch: this.highlightPunch,
      highlightAttacker: this.highlightAttacker,
      highlightIsCounter: this.highlightIsCounter,
      highlightProgress,
      winner: this.winner,
      winMethod: this.winMethod,
      statsSummary: { ...this.summary },
    });
  }

  private afterDraw(cb: () => void) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private tick = () => {
    if (this.disposed) return;

    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const isHighlight = this.mode === 'fight' && this.phase === 'highlight';
    this.elapsed += isHighlight ? dt * 0.25 : dt;

    if (!this.paused) {
      this.crowdExcitement = THREE.MathUtils.damp(this.crowdExcitement, 0.05, 1.4, dt);
      this.arena.updateCrowd(this.elapsed, this.crowdExcitement);

      if (this.mode === 'attract') {
        if (this.playerSim && this.oppSim) {
          if (this.hitstopTimer > 0) {
            this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
          } else {
            this.updateFighterCombat(this.playerSim, this.oppSim, dt);
            this.updateFighterCombat(this.oppSim, this.playerSim, dt);
            this.resolveFighterSeparation();
            this.playerSim.hp = Math.min(this.playerSim.maxHp, this.playerSim.hp + 12 * dt);
            this.oppSim.hp = Math.min(this.oppSim.maxHp, this.oppSim.hp + 12 * dt);
          }
          this.updateParticles(dt);
        }
      } else if (this.mode === 'waitingroom') {
        this.waitingRoom.update(this.elapsed);
        if (this.playerSim) {
          this.playerSim.anim.time += dt;
          this.playerSim.anim.waitingRoomMode = true;

          if (this.waitingConfirmActive) {
            const prevProgress = this.waitingConfirmTimer / this.WAITING_CONFIRM_DURATION;
            this.waitingConfirmTimer += dt;
            const progress = this.waitingConfirmTimer / this.WAITING_CONFIRM_DURATION;
            if (prevProgress < 0.44 && progress >= 0.44) {
              this.shakeIntensity = 0.045;
              soundEngine.playHit('heavy', false);
            }
            if (progress >= 1) {
              this.waitingConfirmActive = false;
              this.waitingConfirmTimer = 0;
              this.playerSim.anim.waitingConfirmProgress = 0;
              const cb = this.waitingConfirmCallback;
              this.waitingConfirmCallback = null;
              updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);
              cb?.();
            } else {
              this.playerSim.anim.waitingConfirmProgress = progress;
              updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);
            }
          } else {
            this.playerSim.anim.waitingConfirmProgress = 0;

            if (!this.waitingSpecialActive) {
              this.waitingIdleClock += dt;
              if (this.waitingIdleClock >= this.WAITING_SPECIAL_INTERVAL) {
                this.waitingIdleClock = 0;
                this.waitingSpecialActive = true;
                this.waitingSpecialTimer = 0;
                this.playerSim.anim.waitingSpecialKind = this.waitingSpecialKind;
              }
            } else {
              this.waitingSpecialTimer += dt;
              const progress = this.waitingSpecialTimer / this.WAITING_SPECIAL_DURATION;
              if (progress >= 1) {
                this.waitingSpecialActive = false;
                this.waitingSpecialTimer = 0;
                this.waitingSpecialKind = (this.waitingSpecialKind + 1) % 3;
                this.playerSim.anim.waitingSpecialProgress = 0;
              } else {
                this.playerSim.anim.waitingSpecialProgress = progress;
              }
            }

            if (!this.waitingSpecialActive) {
              this.waitingRotateClock += dt;
              if (
                this.waitingRotateClock >= this.WAITING_ROTATE_INTERVAL &&
                PLAYABLE_FIGHTERS.length > 1
              ) {
                this.waitingRotateClock = 0;
                this.waitingRosterIndex =
                  (this.waitingRosterIndex + 1) % PLAYABLE_FIGHTERS.length;
                const nextFighter = PLAYABLE_FIGHTERS[this.waitingRosterIndex];
                this.setupWaitingRoom(nextFighter);
                this.onWaitingFighterChange?.(nextFighter);
              }
            }

            updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);
          }
        }
      } else if (this.mode === 'showcase') {
        if (this.playerSim && this.oppSim) {
          this.playerSim.anim.time += dt;
          this.oppSim.anim.time += dt;
          // Subtle shadow-boxing weave on title showcase
          this.playerSim.anim.isGuarding = Math.sin(this.elapsed * 0.9) > 0.45;
          updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);
          updateBoxerPose(this.oppSim.rig, this.oppSim.anim, dt);
        }
      } else if (this.mode === 'faceoff') {
        if (this.playerSim && this.oppSim) {
          this.playerSim.anim.time += dt;
          this.oppSim.anim.time += dt;
          updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);
          updateBoxerPose(this.oppSim.rig, this.oppSim.anim, dt);
        }
      } else if (this.mode === 'creator') {
        if (this.playerSim) {
          this.playerSim.anim.time += dt;
          this.playerSim.anim.waitingRoomMode = true;
          this.playerSim.rig.root.rotation.y = -0.34 + Math.sin(this.elapsed * 0.55) * 0.34;
          updateBoxerPose(this.playerSim.rig, this.playerSim.anim, dt);
        }
      } else {
        if (this.hitstopTimer > 0) {
          this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
        } else {
          this.updateFightStateMachine(dt);
        }
        this.updateParticles(isHighlight ? dt * 0.28 : dt);

        this.hudEmitAccum += dt;
        if (this.hudEmitAccum >= 0.05) {
          this.hudEmitAccum = 0;
          this.emitHud();
        }
      }

      this.updateArenaRopes(isHighlight ? dt * 0.25 : dt);
      this.updateCameraUfc5(dt);
    }

    this.renderer.render(this.scene, this.camera);

    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  };

  public dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('blur', this.blurHandler);
    window.removeEventListener('keydown', this.keyDownHandler);
    window.removeEventListener('keyup', this.keyUpHandler);

    this.clearFighters();
    this.arena.dispose();
    this.waitingRoom.dispose();
    this.particleMesh.geometry.dispose();
    (this.particleMesh.material as THREE.Material).dispose();
    this.envRT.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
