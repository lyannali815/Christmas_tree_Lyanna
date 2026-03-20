/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
// @ts-ignore
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { Camera, Image as ImageIcon, Sparkles, Hand } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Constants & Types ---
type Mode = 'TREE' | 'SCATTER' | 'FOCUS';

interface State {
  mode: Mode;
  targetPhoto: Particle | null;
  handRotation: { x: number; y: number };
  lastGestureTime: number;
}

// --- Particle Class ---
class Particle {
  type: string;
  mesh: THREE.Object3D;
  velocity: THREE.Vector3;
  treePos: THREE.Vector3;
  scatterPos: THREE.Vector3;
  targetPos: THREE.Vector3;
  targetScale: THREE.Vector3;

  constructor(type: string, texture: THREE.Texture | null, mainGroup: THREE.Group, materials: any, geometries: any) {
    this.type = type;
    this.mesh = this.createMesh(type, texture, materials, geometries);
    this.velocity = new THREE.Vector3((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2);
    this.treePos = new THREE.Vector3();
    this.scatterPos = new THREE.Vector3();
    this.targetPos = new THREE.Vector3();
    this.targetScale = new THREE.Vector3(1, 1, 1);
    mainGroup.add(this.mesh);
  }

  createMesh(type: string, texture: THREE.Texture | null, materials: any, geometries: any) {
    let mesh: THREE.Object3D;
    if (type === 'BOX') {
      mesh = new THREE.Mesh(geometries.box, Math.random() > 0.5 ? materials.goldStandard : materials.greenStandard);
    } else if (type === 'SPHERE') {
      mesh = new THREE.Mesh(geometries.sphere, Math.random() > 0.5 ? materials.goldPhysical : materials.redPhysical);
    } else if (type === 'CANDY') {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0.5, 0),
        new THREE.Vector3(0.5, 1, 0), new THREE.Vector3(0.8, 0.5, 0)
      ]);
      const geoTube = new THREE.TubeGeometry(curve, 20, 0.15, 8, false);
      mesh = new THREE.Mesh(geoTube, materials.candy);
    } else if (type === 'PHOTO' && texture) {
      const group = new THREE.Group();
      const frameGeo = new THREE.BoxGeometry(3.2, 3.2, 0.2);
      const frame = new THREE.Mesh(frameGeo, materials.goldStandard);
      const photoGeo = new THREE.PlaneGeometry(2.8, 2.8);
      const photoMat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.4 });
      const photo = new THREE.Mesh(photoGeo, photoMat);
      photo.position.z = 0.11;
      group.add(frame, photo);
      mesh = group;
    } else {
      mesh = new THREE.Mesh(geometries.box, materials.goldStandard);
    }

    mesh.position.set((Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    return mesh;
  }

  calculatePositions(index: number, total: number) {
    const t = index / total;
    const maxRadius = 12;
    const radius = maxRadius * (1 - t);
    const angle = t * 50 * Math.PI;
    const y = -10 + (t * 25);
    this.treePos.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);

    const r = 8 + Math.random() * 12;
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos(2 * Math.random() - 1);
    this.scatterPos.set(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi));
  }

  update(mode: Mode, isTargetPhoto: boolean) {
    if (mode === 'TREE') {
      this.targetPos.copy(this.treePos);
      this.targetScale.set(1, 1, 1);
    } else if (mode === 'SCATTER') {
      this.targetPos.copy(this.scatterPos);
      this.targetScale.set(1, 1, 1);
      this.mesh.rotation.x += this.velocity.x;
      this.mesh.rotation.y += this.velocity.y;
    } else if (mode === 'FOCUS') {
      if (isTargetPhoto) {
        this.targetPos.set(0, 2, 35);
        this.targetScale.set(4.5, 4.5, 4.5);
        this.mesh.rotation.set(0, 0, 0);
      } else {
        this.targetPos.copy(this.scatterPos).multiplyScalar(1.5);
        this.targetScale.set(1, 1, 1);
      }
    }

    this.mesh.position.lerp(this.targetPos, 0.05);
    this.mesh.scale.lerp(this.targetScale, 0.05);

    if (mode === 'TREE' && this.type !== 'PHOTO') {
      this.mesh.rotation.y += 0.01;
    }
  }
}

// --- Main App Component ---
export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [uiVisible, setUiVisible] = useState(true);
  const [mode, setMode] = useState<Mode>('TREE');
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Refs for Three.js objects to avoid re-renders
  const sceneRef = useRef<THREE.Scene | null>(null);
  const mainGroupRef = useRef<THREE.Group | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const stateRef = useRef<State>({
    mode: 'TREE',
    targetPhoto: null,
    handRotation: { x: 0, y: 0 },
    lastGestureTime: 0
  });

  // --- Helper Functions ---
  const createCandyCanvasTexture = () => {
    const cvs = document.createElement('canvas');
    cvs.width = 256; cvs.height = 256;
    const ctx = cvs.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 256, 256);
    ctx.lineWidth = 40;
    ctx.strokeStyle = '#d00000';
    for (let i = -256; i < 512; i += 64) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 256, 256);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 1);
    return tex;
  };

  const createDefaultPhotoTexture = () => {
    const cvs = document.createElement('canvas');
    cvs.width = 512; cvs.height = 512;
    const ctx = cvs.getContext('2d')!;
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#d4af37';
    ctx.lineWidth = 15;
    ctx.strokeRect(20, 20, 472, 472);
    ctx.fillStyle = '#fceea7';
    ctx.font = 'bold 60px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('JOYEUX', 256, 220);
    ctx.fillText('NOEL', 256, 290);
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  const handleModeChange = useCallback((newMode: Mode) => {
    stateRef.current.mode = newMode;
    setMode(newMode);
    if (newMode === 'FOCUS') {
      const photos = particlesRef.current.filter(p => p.type === 'PHOTO');
      if (photos.length > 0) {
        stateRef.current.targetPhoto = photos[Math.floor(Math.random() * photos.length)];
      }
    } else {
      stateRef.current.targetPhoto = null;
    }
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (ev.target?.result) {
        new THREE.TextureLoader().load(ev.target.result as string, (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          addPhotoToScene(texture);
        });
      }
    };
    reader.readAsDataURL(file);
  };

  const addPhotoToScene = (texture: THREE.Texture) => {
    if (!mainGroupRef.current) return;
    
    const materials = {
      goldStandard: new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.2 }),
    };
    const geometries = {
      box: new THREE.BoxGeometry(0.8, 0.8, 0.8),
    };

    const p = new Particle('PHOTO', texture, mainGroupRef.current, materials, geometries);
    particlesRef.current.push(p);
    particlesRef.current.forEach((pt, i) => pt.calculatePositions(i, particlesRef.current.length));
    handleModeChange('FOCUS');
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // --- Three.js Setup ---
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    const mainGroup = new THREE.Group();
    mainGroupRef.current = mainGroup;
    scene.add(mainGroup);

    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 2, 50);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ReinhardToneMapping;
    renderer.toneMappingExposure = 2.2;
    containerRef.current.appendChild(renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const pointLight = new THREE.PointLight(0xff8800, 2, 50);
    pointLight.position.set(0, 5, 0);
    scene.add(pointLight);

    const spotLightGold = new THREE.SpotLight(0xd4af37, 1200);
    spotLightGold.position.set(30, 40, 40);
    scene.add(spotLightGold);

    const spotLightBlue = new THREE.SpotLight(0x4488ff, 600);
    spotLightBlue.position.set(-30, 20, -30);
    scene.add(spotLightBlue);

    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.45, 0.4, 0.7
    );
    const composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);

    // Materials & Geometries
    const materials = {
      goldStandard: new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.2 }),
      greenStandard: new THREE.MeshStandardMaterial({ color: 0x0a3b16, metalness: 0.2, roughness: 0.8 }),
      goldPhysical: new THREE.MeshPhysicalMaterial({ color: 0xd4af37, metalness: 1, roughness: 0.1, clearcoat: 1 }),
      redPhysical: new THREE.MeshPhysicalMaterial({ color: 0xaa0000, metalness: 0.3, roughness: 0.2, clearcoat: 1 }),
      candy: new THREE.MeshStandardMaterial({ map: createCandyCanvasTexture(), roughness: 0.3 })
    };

    const geometries = {
      box: new THREE.BoxGeometry(0.8, 0.8, 0.8),
      sphere: new THREE.SphereGeometry(0.5, 32, 32)
    };

    // Initialize Particles
    const totalMain = 1500;
    const defaultPhotoTex = createDefaultPhotoTexture();
    for (let i = 0; i < totalMain; i++) {
      let type = 'SPHERE';
      const rand = Math.random();
      if (rand < 0.4) type = 'BOX';
      else if (rand < 0.8) type = 'SPHERE';
      else if (rand < 0.95) type = 'CANDY';
      else type = 'PHOTO';
      
      const p = new Particle(type, type === 'PHOTO' ? defaultPhotoTex : null, mainGroup, materials, geometries);
      particlesRef.current.push(p);
    }
    particlesRef.current.forEach((p, i) => p.calculatePositions(i, totalMain));

    // Dust System
    const dustGeo = new THREE.BufferGeometry();
    const dustPos = [];
    for (let i = 0; i < 2500; i++) {
      dustPos.push((Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60);
    }
    dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
    const dustMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.1, transparent: true, opacity: 0.6 });
    const dustSystem = new THREE.Points(dustGeo, dustMat);
    scene.add(dustSystem);

    // --- MediaPipe Setup ---
    let handLandmarker: HandLandmarker | null = null;
    let webcamRunning = false;

    const initMediaPipe = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.onloadeddata = () => {
              webcamRunning = true;
              setLoading(false);
            };
          }
        } else {
          setCameraError("Camera not supported");
          setLoading(false);
        }
      } catch (err) {
        console.error("MediaPipe error:", err);
        setCameraError("Failed to initialize camera/gestures");
        setLoading(false);
      }
    };

    initMediaPipe();

    // --- Animation Loop ---
    const animate = () => {
      requestAnimationFrame(animate);

      if (webcamRunning && handLandmarker && videoRef.current) {
        const results = handLandmarker.detectForVideo(videoRef.current, performance.now());
        if (results.landmarks && results.landmarks.length > 0) {
          const marks = results.landmarks[0];
          const wrist = marks[0];
          const thumb = marks[4];
          const index = marks[8];
          const middle = marks[12];
          const ring = marks[16];
          const pinky = marks[20];
          const palmCenter = marks[9];

          const dist = (p1: any, p2: any) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
          const avgFingersToWrist = (dist(index, wrist) + dist(middle, wrist) + dist(ring, wrist) + dist(pinky, wrist)) / 4;

          const now = performance.now();
          if (now - stateRef.current.lastGestureTime > 1000) {
            if (dist(thumb, index) < 0.05) {
              handleModeChange('FOCUS');
              stateRef.current.lastGestureTime = now;
            } else if (avgFingersToWrist < 0.25) {
              handleModeChange('TREE');
              stateRef.current.lastGestureTime = now;
            } else if (avgFingersToWrist > 0.4) {
              handleModeChange('SCATTER');
              stateRef.current.lastGestureTime = now;
            }
          }

          stateRef.current.handRotation.y = (palmCenter.x - 0.5) * Math.PI * -1;
          stateRef.current.handRotation.x = (palmCenter.y - 0.5) * Math.PI * 0.5;
        } else {
          stateRef.current.handRotation.y = 0;
          stateRef.current.handRotation.x = 0;
        }
      }

      mainGroup.rotation.y = THREE.MathUtils.lerp(mainGroup.rotation.y, stateRef.current.handRotation.y, 0.05);
      mainGroup.rotation.x = THREE.MathUtils.lerp(mainGroup.rotation.x, stateRef.current.handRotation.x, 0.05);
      dustSystem.rotation.y += 0.001;

      particlesRef.current.forEach(p => p.update(stateRef.current.mode, p === stateRef.current.targetPhoto));
      composer.render();
    };

    animate();

    // Handle Resize
    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
      bloomPass.resolution.set(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    // Handle Keydown
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'h') setUiVisible(prev => !prev);
      if (e.key === '1') handleModeChange('TREE');
      if (e.key === '2') handleModeChange('SCATTER');
      if (e.key === '3') handleModeChange('FOCUS');
    };
    document.addEventListener('keydown', handleKeydown);

    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('keydown', handleKeydown);
      if (containerRef.current) {
        containerRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [handleModeChange]);

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden font-serif text-[#fceea7]">
      {/* Loader */}
      <AnimatePresence>
        {loading && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1 }}
            className="fixed inset-0 bg-black z-50 flex flex-col justify-center items-center"
          >
            <div className="w-10 h-10 rounded-full border-2 border-transparent border-t-[#d4af37] animate-spin" />
            <div className="mt-5 text-[#d4af37] tracking-[2px] text-sm uppercase">Loading Holiday Magic</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Three.js Container */}
      <div ref={containerRef} className="w-full h-full" />

      {/* UI Layer */}
      <div className={`fixed inset-0 flex flex-col items-center p-10 pointer-events-none transition-opacity duration-500 z-10 ${uiVisible ? 'opacity-100' : 'opacity-0'}`}>
        <h1 className="text-6xl md:text-8xl font-bold tracking-tighter text-center bg-gradient-to-b from-white to-[#d4af37] bg-clip-text text-transparent drop-shadow-[0_0_15px_rgba(212,175,55,0.6)]">
          Merry Christmas
        </h1>

        <div className="mt-auto mb-2 pointer-events-auto flex flex-col items-center gap-4">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="bg-white/5 backdrop-blur-md border border-[#d4af37] text-[#d4af37] px-8 py-3 text-lg rounded hover:bg-[#d4af37]/20 hover:text-white transition-all duration-300 tracking-wider flex items-center gap-2"
          >
            <ImageIcon size={20} />
            ADD MEMORIES
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            accept="image/*"
          />
          
          <div className="flex gap-4">
            <button onClick={() => handleModeChange('TREE')} className={`px-4 py-2 rounded border transition-all ${mode === 'TREE' ? 'bg-[#d4af37] text-black border-[#d4af37]' : 'bg-black/50 text-[#d4af37] border-[#d4af37]/50'}`}>Tree</button>
            <button onClick={() => handleModeChange('SCATTER')} className={`px-4 py-2 rounded border transition-all ${mode === 'SCATTER' ? 'bg-[#d4af37] text-black border-[#d4af37]' : 'bg-black/50 text-[#d4af37] border-[#d4af37]/50'}`}>Scatter</button>
            <button onClick={() => handleModeChange('FOCUS')} className={`px-4 py-2 rounded border transition-all ${mode === 'FOCUS' ? 'bg-[#d4af37] text-black border-[#d4af37]' : 'bg-black/50 text-[#d4af37] border-[#d4af37]/50'}`}>Focus</button>
          </div>
        </div>

        <div className="text-sm text-[#fceea7]/60 mb-5 tracking-widest flex items-center gap-2">
          <Sparkles size={14} />
          Press 'H' to Hide Controls
        </div>
      </div>

      {/* Gesture Hints */}
      <div className={`fixed bottom-10 left-10 p-4 bg-black/40 backdrop-blur-sm border border-[#d4af37]/30 rounded-lg pointer-events-none transition-opacity duration-500 ${uiVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className="text-xs uppercase tracking-widest text-[#d4af37] mb-2 flex items-center gap-2">
          <Hand size={14} />
          Hand Gestures
        </div>
        <ul className="text-[10px] space-y-1 text-[#fceea7]/80">
          <li>• Fist: Tree Mode</li>
          <li>• Open Hand: Scatter Mode</li>
          <li>• Pinch (Thumb + Index): Focus Mode</li>
          <li>• Palm Move: Rotate Scene</li>
        </ul>
      </div>

      {/* Hidden Webcam Container */}
      <div className="fixed right-0 bottom-0 opacity-0 pointer-events-none">
        <video ref={videoRef} autoPlay playsInline className="w-40 h-30" />
      </div>

      {/* Error Message */}
      {cameraError && (
        <div className="fixed top-5 right-5 bg-red-900/80 text-white p-3 rounded border border-red-500 text-xs z-50">
          {cameraError}
        </div>
      )}
    </div>
  );
}
